import {
  AdapterError,
  errorResult,
  fetchJson,
  type AdapterExternalBillingRecord,
  type UsageResult,
} from "./helpers";

interface RenderDisk {
  id?: string;
  name?: string;
  sizeGB?: number;
  mountPath?: string;
}

interface RenderServiceDetails {
  plan?: string;
  runtime?: string;
  env?: string;
  region?: string;
  numInstances?: number;
  autoscaling?: {
    enabled?: boolean;
    min?: number;
    max?: number;
  };
  disk?: RenderDisk;
  buildPlan?: string;
}

interface RenderService {
  id?: string;
  name?: string;
  type?: string;
  // Retain the legacy top-level fallbacks for older API responses.
  plan?: string;
  runtime?: string;
  env?: string;
  serviceDetails?: RenderServiceDetails;
  suspended?: string | boolean;
  updatedAt?: string;
}

interface RenderReadReplica {
  id?: string;
  name?: string;
}

interface RenderPostgres {
  id?: string;
  name?: string;
  plan?: string;
  status?: string;
  suspended?: string;
  region?: string;
  role?: string;
  version?: string;
  diskSizeGB?: number;
  diskAutoscalingEnabled?: boolean;
  highAvailabilityEnabled?: boolean;
  readReplicas?: RenderReadReplica[];
  updatedAt?: string;
}

interface RenderKeyValue {
  id?: string;
  name?: string;
  plan?: string;
  status?: string;
  region?: string;
  version?: string;
  options?: {
    maxmemoryPolicy?: string;
    persistenceMode?: string;
  };
  updatedAt?: string;
}

// GET /v1/metrics/bandwidth (and Render's other /v1/metrics/* endpoints)
// share this time-series shape: one entry per queried resource, a "resource"
// label identifying which one, and a flat array of timestamped points, e.g.
// [{ labels: [{ field: "resource", value: "srv-abc" }],
//    values: [{ timestamp, value }], unit: "bytes" }]
// https://api-docs.render.com/reference/get-bandwidth
// https://api-docs.render.com/reference/get-cpu (shared 200 response shape)
export interface RenderBandwidthByService {
  serviceId: string;
  bytes: number;
  gigabytes: number;
}

export interface RenderBandwidthUsage {
  // "ready" = a complete current-calendar-month-to-date total for every
  // discovered service, aligned with the monthly request/GB limit it feeds.
  // "partial" = either a capped service subset was queried (coveredServiceCount
  // vs discoveredServiceCount) or the window could not reach the 1st of the UTC
  // month (coversCalendarMonthStart=false); in both cases the totals below are
  // an undercount floor, so the scalar snapshot metric is withheld. "error" =
  // the bandwidth read failed and the rest of the inventory still persisted.
  status: "ready" | "partial" | "error";
  windowStart: string;
  windowEnd: string;
  // The window is the current UTC calendar month to date (1st 00:00 -> now),
  // matching how a monthly GB budget and Render's monthly billing reset work.
  // Only false on the rare late-month day when the 1st falls outside Render's
  // 30-day metrics floor and the window is clamped to the reachable trailing
  // span (see resolveBandwidthWindow).
  coversCalendarMonthStart: boolean;
  totalBytes: number | null;
  // Integer megabytes - the unit actually written to the snapshot's Int
  // request-count column. See the totalRequests comment in fetchUsage for why
  // bytes (Int32 overflow past ~2.1 GB) and fractional GB (silent Int
  // truncation) are both unsafe there.
  totalMegabytes: number | null;
  totalGigabytes: number | null;
  byService: RenderBandwidthByService[];
  discoveredServiceCount: number;
  coveredServiceCount: number;
  truncatedResourceCount: boolean;
  errorCode?: string;
  httpStatus?: number | null;
  retryable?: boolean;
}

const PAGE_LIMIT = 100;
const MAX_PAGES = 1_000;
// Render's metrics API rejects a startTime older than 30 days; stay one day
// inside that bound so clock skew between us and Render can't tip it over.
// This is the safe floor the calendar-month window is clamped to when the 1st
// of the month is not reachable (see resolveBandwidthWindow).
const BANDWIDTH_MAX_LOOKBACK_DAYS = 29;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
// Keeps each /metrics/bandwidth request's query string bounded; Render ORs
// every "resource" param together within one request.
const BANDWIDTH_CHUNK_SIZE = 25;
// Safety valve against an unbounded number of outbound requests. A personal
// or small-team Render account will never approach this. Past it, the summed
// bandwidth is a subset (not account-wide) and is reported as "partial".
const MAX_BANDWIDTH_RESOURCES = 200;
// Defensive point-count ceiling per series, mirroring the pattern in
// google-cloud-monitoring.ts. At the requested hourly resolution this covers
// far more than the 29-day window ever needs.
const MAX_BANDWIDTH_POINTS_PER_SERIES = 1_000;
// Hourly buckets keep a 29-day/multi-resource response well under Render's
// undocumented point-count response cap (the API's own default resolution is
// 60s, which would be tens of thousands of points per resource over 29 days).
const BANDWIDTH_RESOLUTION_SECONDS = 3_600;
// Decimal units, matching standard cloud egress billing (not GiB/MiB).
const BYTES_PER_GB = 1_000_000_000;
const BYTES_PER_MB = 1_000_000;

function invalidResponse(message: string): never {
  throw new AdapterError(message, { code: "INVALID_RESPONSE" });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renderStatus(suspended: string | boolean | undefined, status?: string): string {
  if (suspended === true || suspended === "suspended") return "suspended";
  if (status?.trim()) return status.trim();
  return "active";
}

function isPaidPlan(plan: string | null): boolean {
  return plan != null && plan.trim().toLowerCase() !== "free";
}

function requiredPlan(
  resourceKind: string,
  resourceId: string | undefined,
  value: unknown
): string {
  if (typeof value !== "string" || !value.trim()) {
    invalidResponse(
      `Render ${resourceKind} ${resourceId ?? "unknown"} omitted its required plan`
    );
  }
  return value.trim();
}

function validateServiceDisk(service: RenderService): RenderDisk | undefined {
  const disk = service.serviceDetails?.disk;
  if (disk == null) return undefined;
  if (
    typeof disk !== "object" ||
    typeof disk.id !== "string" ||
    !disk.id.trim() ||
    typeof disk.sizeGB !== "number" ||
    !Number.isFinite(disk.sizeGB) ||
    disk.sizeGB <= 0
  ) {
    invalidResponse(
      `Render service ${service.id ?? "unknown"} returned an incomplete persistent disk`
    );
  }
  return { ...disk, id: disk.id.trim() };
}

async function fetchAllRenderResources<T extends { id?: string }>(
  path: string,
  resourceKey: "service" | "postgres" | "keyValue",
  headers: Record<string, string>
): Promise<T[]> {
  const resources: T[] = [];
  const seenIds = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = new URLSearchParams({ limit: String(PAGE_LIMIT) });
    if (cursor != null) query.set("cursor", cursor);
    const response = await fetchJson(`https://api.render.com/v1${path}?${query}`, {
      headers,
    });
    if (!response.ok) return errorResult(response.status);
    if (!Array.isArray(response.data)) {
      invalidResponse(`Render returned an invalid ${resourceKey} list`);
    }

    const rows = response.data as unknown[];
    if (rows.length === 0) return resources;

    let nextCursor: string | null = null;
    for (const row of rows) {
      if (!row || typeof row !== "object") {
        invalidResponse(`Render returned an invalid ${resourceKey} page row`);
      }
      const record = row as Record<string, unknown>;
      const resource = record[resourceKey];
      const rowCursor = record.cursor;
      if (
        !resource ||
        typeof resource !== "object" ||
        typeof (resource as { id?: unknown }).id !== "string" ||
        !(resource as { id: string }).id.trim() ||
        typeof rowCursor !== "string" ||
        !rowCursor.trim()
      ) {
        invalidResponse(`Render returned an incomplete ${resourceKey} page row`);
      }
      const id = (resource as { id: string }).id;
      if (seenIds.has(id)) {
        invalidResponse(`Render returned duplicate ${resourceKey} id ${id}`);
      }
      seenIds.add(id);
      resources.push(resource as T);
      nextCursor = rowCursor;
    }

    if (!nextCursor || seenCursors.has(nextCursor)) {
      invalidResponse(`Render ${resourceKey} pagination did not advance`);
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  invalidResponse(`Render ${resourceKey} pagination exceeded the safety limit`);
}

function bytesToGigabytes(bytes: number): number {
  return Math.round((bytes / BYTES_PER_GB) * 1000) / 1000;
}

// Whole megabytes. This is what lands in UsageSnapshot.totalRequests, an Int
// column, so it must be an integer. MB granularity preserves the bandwidth
// total to 0.001 GB (far better than integer GB, which would lose the ".5" in
// "3.5 GB") while staying comfortably inside Int32 (its max is ~2.1e9 MB, i.e.
// ~2 PB). Raw bytes are also kept in rawData, so nothing is lost overall.
function bytesToMegabytes(bytes: number): number {
  return Math.round(bytes / BYTES_PER_MB);
}

function toRenderTimestamp(date: Date): string {
  // Render accepts ISO-8601 date-times; strip milliseconds to match the format
  // used elsewhere in this codebase's outbound metric queries.
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// The bandwidth total feeds request_limit alerts against the owner's
// monthlyRequestLimit, which is a CALENDAR-MONTH concept - so the window is the
// current UTC month to date (1st 00:00 -> now), not a rolling span, and it also
// matches Render's own monthly bandwidth billing reset. The one wrinkle is
// Render's metrics API refusing a startTime older than 30 days: on the last day
// or two of a long month the 1st can fall outside that floor. Rather than
// silently querying a rolling window and presenting it as a month total (the
// exact mismatch this guards against), the window is clamped to the reachable
// floor and flagged coversCalendarMonthStart=false so the caller can mark the
// figure partial - the same day-boundary discipline openrouter.ts uses for its
// calendar-MTD estimate.
export function resolveBandwidthWindow(now: Date): {
  start: string;
  end: string;
  coversCalendarMonthStart: boolean;
} {
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  );
  const earliestReachable = new Date(
    now.getTime() - BANDWIDTH_MAX_LOOKBACK_DAYS * MS_PER_DAY
  );
  const coversCalendarMonthStart =
    monthStart.getTime() >= earliestReachable.getTime();
  const start = coversCalendarMonthStart ? monthStart : earliestReachable;
  return {
    start: toRenderTimestamp(start),
    end: toRenderTimestamp(now),
    coversCalendarMonthStart,
  };
}

// Strictly validates one /metrics/bandwidth response page and returns bytes
// summed per resource id. Fails closed (invalidResponse) on any shape this
// adapter did not request or does not recognize, matching every other Render
// list/response validator in this file.
function parseBandwidthSeries(
  data: unknown,
  requestedIds: ReadonlySet<string>
): Map<string, number> {
  if (!Array.isArray(data)) {
    invalidResponse("Render returned an invalid bandwidth metrics response");
  }
  const bytesByService = new Map<string, number>();
  for (const row of data) {
    if (!isRecord(row) || !Array.isArray(row.labels) || !Array.isArray(row.values)) {
      invalidResponse("Render returned a malformed bandwidth metrics series");
    }
    if (row.values.length > MAX_BANDWIDTH_POINTS_PER_SERIES) {
      invalidResponse("Render bandwidth metrics series exceeded the point safety limit");
    }
    const unit = typeof row.unit === "string" ? row.unit.trim().toLowerCase() : "";
    if (unit !== "" && unit !== "bytes") {
      invalidResponse(`Render bandwidth metrics reported an unsupported unit: ${String(row.unit)}`);
    }
    const resourceLabel = row.labels.find(
      (label): label is { field: string; value: string } =>
        isRecord(label) &&
        label.field === "resource" &&
        typeof label.value === "string" &&
        label.value.trim() !== ""
    );
    if (!resourceLabel || !requestedIds.has(resourceLabel.value)) {
      invalidResponse("Render bandwidth metrics returned a series for an unrequested resource");
    }
    let seriesBytes = 0;
    for (const point of row.values) {
      if (
        !isRecord(point) ||
        typeof point.value !== "number" ||
        !Number.isFinite(point.value) ||
        point.value < 0
      ) {
        invalidResponse("Render bandwidth metrics returned an invalid data point");
      }
      seriesBytes += point.value;
    }
    bytesByService.set(
      resourceLabel.value,
      (bytesByService.get(resourceLabel.value) ?? 0) + seriesBytes
    );
  }
  return bytesByService;
}

// Fetches month-relevant bandwidth for every discovered service. This is
// intentionally independent from fetchAllRenderResources: a bandwidth
// permission/outage issue must never discard the already-good service/
// Postgres/Key Value inventory (see the postPersistError handling below).
async function fetchBandwidthUsage(
  apiKey: string,
  serviceIds: string[],
  windowStart: string,
  windowEnd: string
): Promise<{
  totalBytes: number;
  byService: RenderBandwidthByService[];
  discoveredServiceCount: number;
  coveredServiceCount: number;
  truncated: boolean;
}> {
  const dedupedIds = [...new Set(serviceIds)];
  const truncated = dedupedIds.length > MAX_BANDWIDTH_RESOURCES;
  const boundedIds = dedupedIds.slice(0, MAX_BANDWIDTH_RESOURCES);
  const bytesByService = new Map<string, number>();

  for (let i = 0; i < boundedIds.length; i += BANDWIDTH_CHUNK_SIZE) {
    const chunk = boundedIds.slice(i, i + BANDWIDTH_CHUNK_SIZE);
    const query = new URLSearchParams({
      startTime: windowStart,
      endTime: windowEnd,
      resolutionSeconds: String(BANDWIDTH_RESOLUTION_SECONDS),
    });
    for (const id of chunk) query.append("resource", id);
    const response = await fetchJson(`https://api.render.com/v1/metrics/bandwidth?${query}`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) {
      return errorResult(response.status, { note: "Render bandwidth metrics request failed" });
    }
    const chunkBytes = parseBandwidthSeries(response.data, new Set(chunk));
    for (const [id, bytes] of chunkBytes) {
      bytesByService.set(id, (bytesByService.get(id) ?? 0) + bytes);
    }
  }

  const byService: RenderBandwidthByService[] = boundedIds
    .filter((id) => bytesByService.has(id))
    .map((id) => {
      const bytes = bytesByService.get(id)!;
      return { serviceId: id, bytes, gigabytes: bytesToGigabytes(bytes) };
    });
  const totalBytes = byService.reduce((sum, entry) => sum + entry.bytes, 0);

  return {
    totalBytes,
    byService,
    discoveredServiceCount: dedupedIds.length,
    coveredServiceCount: boundedIds.length,
    truncated,
  };
}

export async function fetchUsage(
  apiKey: string,
  // serviceId used to be mandatory. Account-wide discovery makes it optional;
  // keep accepting the legacy config so existing provider records need no edit.
  _config?: Record<string, unknown>
): Promise<UsageResult> {
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  // Do not reconcile a partial account inventory: all three independent
  // resource classes and every cursor page must finish first.
  const [serviceRows, postgresRows, keyValueRows] = await Promise.all([
    fetchAllRenderResources<RenderService>("/services", "service", headers),
    fetchAllRenderResources<RenderPostgres>("/postgres", "postgres", headers),
    fetchAllRenderResources<RenderKeyValue>("/key-value", "keyValue", headers),
  ]);

  const records: AdapterExternalBillingRecord[] = [];
  const services = serviceRows.map((service) => {
    const rawDetails: unknown = service.serviceDetails;
    if (rawDetails != null && !isRecord(rawDetails)) {
      invalidResponse(
        `Render service ${service.id ?? "unknown"} returned malformed serviceDetails`
      );
    }
    const details = rawDetails as RenderServiceDetails | undefined;
    const serviceType = service.type?.trim();
    if (!serviceType) {
      invalidResponse(`Render service ${service.id ?? "unknown"} omitted its type`);
    }
    const rawPlan = details?.plan ?? service.plan;
    // Static sites are the sole plan-less service shape in Render's public
    // schema. For every other service, missing plan data means we cannot safely
    // reconcile an authoritative paid-service inventory.
    const plan = serviceType === "static_site"
      ? typeof rawPlan === "string" && rawPlan.trim()
        ? rawPlan.trim()
        : null
      : requiredPlan("service", service.id, rawPlan);
    const disk = validateServiceDisk(service);
    const runtime = details?.runtime ?? details?.env ?? service.runtime ?? service.env ?? null;
    const instances = details?.numInstances ?? null;
    if (
      instances != null &&
      (!Number.isSafeInteger(instances) || instances < 0)
    ) {
      invalidResponse(`Render service ${service.id ?? "unknown"} has invalid numInstances`);
    }
    const status = renderStatus(service.suspended);
    const paidPlan = isPaidPlan(plan);
    if (paidPlan && service.id) {
      records.push({
        externalId: service.id,
        kind: "service_plan",
        serviceName: service.name ?? `Service ${service.id}`,
        planName: plan,
        status,
        usageQuantity: instances,
        usageUnit: instances == null ? null : "instances",
        rollupRole: "canonical",
      });
    }
    if (disk) {
      records.push({
        externalId: `${service.id ?? "service"}:disk:${disk.id}`,
        kind: "service_plan",
        serviceName: `${service.name ?? service.id ?? "Service"} disk`,
        planName: `${disk.sizeGB} GB persistent disk`,
        status,
        usageQuantity: disk.sizeGB,
        usageUnit: "GB",
        rollupRole: paidPlan ? "component" : "canonical",
      });
    }
    return {
      id: service.id ?? null,
      name: service.name ?? null,
      type: serviceType,
      plan,
      paidPlan,
      runtime,
      region: details?.region ?? null,
      status,
      instances,
      autoscaling: details?.autoscaling ?? null,
      disk: disk
        ? {
            id: disk.id,
            name: disk.name ?? null,
            sizeGB: disk.sizeGB,
            mountPath: disk.mountPath ?? null,
          }
        : null,
      buildPlan: details?.buildPlan ?? null,
      updatedAt: service.updatedAt ?? null,
    };
  });

  const postgres = postgresRows.map((database) => {
    const plan = requiredPlan("Postgres database", database.id, database.plan);
    const status = renderStatus(database.suspended, database.status);
    const paidPlan = isPaidPlan(plan);
    if (paidPlan && database.id) {
      records.push({
        externalId: database.id,
        kind: "service_plan",
        serviceName: database.name ?? `Postgres ${database.id}`,
        planName: plan,
        status,
        rollupRole: "canonical",
      });
    }
    return {
      id: database.id ?? null,
      name: database.name ?? null,
      plan,
      paidPlan,
      status,
      region: database.region ?? null,
      role: database.role ?? null,
      version: database.version ?? null,
      diskSizeGB: database.diskSizeGB ?? null,
      diskAutoscalingEnabled: database.diskAutoscalingEnabled ?? null,
      highAvailabilityEnabled: database.highAvailabilityEnabled ?? null,
      readReplicas: (database.readReplicas ?? []).map((replica) => ({
        id: replica.id ?? null,
        name: replica.name ?? null,
      })),
      updatedAt: database.updatedAt ?? null,
    };
  });

  const keyValue = keyValueRows.map((instance) => {
    const plan = requiredPlan("Key Value instance", instance.id, instance.plan);
    const paidPlan = isPaidPlan(plan);
    const status = instance.status?.trim() || "active";
    if (paidPlan && instance.id) {
      records.push({
        externalId: instance.id,
        kind: "service_plan",
        serviceName: instance.name ?? `Key Value ${instance.id}`,
        planName: plan,
        status,
        rollupRole: "canonical",
      });
    }
    return {
      id: instance.id ?? null,
      name: instance.name ?? null,
      plan,
      paidPlan,
      status,
      region: instance.region ?? null,
      version: instance.version ?? null,
      persistenceMode: instance.options?.persistenceMode ?? null,
      maxmemoryPolicy: instance.options?.maxmemoryPolicy ?? null,
      updatedAt: instance.updatedAt ?? null,
    };
  });

  // Bandwidth is deliberately fetched after (not merged into) the account
  // inventory Promise.all above: a bandwidth-metrics failure (wrong token
  // scope, transient metrics outage) must degrade gracefully - keeping the
  // already-good service/Postgres/Key Value inventory intact - rather than
  // discarding it. postPersistError lets usage-recorder.ts persist this
  // snapshot first and only then surface the failure for retry/health
  // tracking, the same contract google-ai.ts uses for its own partial syncs.
  const serviceIds = serviceRows
    .map((service) => service.id)
    .filter((id): id is string => typeof id === "string" && id.trim() !== "");
  const {
    start: bandwidthWindowStart,
    end: bandwidthWindowEnd,
    coversCalendarMonthStart,
  } = resolveBandwidthWindow(new Date());
  let bandwidth: RenderBandwidthUsage;
  let bandwidthError: AdapterError | undefined;
  if (serviceIds.length === 0) {
    bandwidth = {
      status: "ready",
      windowStart: bandwidthWindowStart,
      windowEnd: bandwidthWindowEnd,
      coversCalendarMonthStart,
      totalBytes: 0,
      totalMegabytes: 0,
      totalGigabytes: 0,
      byService: [],
      discoveredServiceCount: 0,
      coveredServiceCount: 0,
      truncatedResourceCount: false,
    };
  } else {
    try {
      const result = await fetchBandwidthUsage(
        apiKey,
        serviceIds,
        bandwidthWindowStart,
        bandwidthWindowEnd
      );
      // The scalar snapshot metric may only be presented as a complete
      // calendar-month-to-date total when BOTH are true: every discovered
      // service was measured (not a capped subset) AND the window reached the
      // 1st of the UTC month. Either gap makes the total an undercount vs the
      // monthly limit it feeds, so it is reported "partial" and the scalar is
      // withheld below; the measured values still populate rawData as a floor.
      const complete = !result.truncated && coversCalendarMonthStart;
      bandwidth = {
        status: complete ? "ready" : "partial",
        windowStart: bandwidthWindowStart,
        windowEnd: bandwidthWindowEnd,
        coversCalendarMonthStart,
        totalBytes: result.totalBytes,
        totalMegabytes: bytesToMegabytes(result.totalBytes),
        totalGigabytes: bytesToGigabytes(result.totalBytes),
        byService: result.byService,
        discoveredServiceCount: result.discoveredServiceCount,
        coveredServiceCount: result.coveredServiceCount,
        truncatedResourceCount: result.truncated,
      };
    } catch (error) {
      const adapterError =
        error instanceof AdapterError
          ? error
          : new AdapterError("Render bandwidth metrics request failed", {
              code: "TRANSPORT_ERROR",
              retryable: true,
              cause: error,
            });
      bandwidthError = adapterError;
      bandwidth = {
        status: "error",
        windowStart: bandwidthWindowStart,
        windowEnd: bandwidthWindowEnd,
        coversCalendarMonthStart,
        totalBytes: null,
        totalMegabytes: null,
        totalGigabytes: null,
        byService: [],
        discoveredServiceCount: serviceIds.length,
        coveredServiceCount: 0,
        truncatedResourceCount: serviceIds.length > MAX_BANDWIDTH_RESOURCES,
        errorCode: adapterError.code,
        httpStatus: adapterError.status,
        retryable: adapterError.retryable,
      };
    }
  }

  return {
    balance: null,
    totalCost: null,
    // Current-calendar-month-to-date bandwidth in whole megabytes (an
    // integer), reused the same way langfuse.ts (billable units) and sentry.ts
    // (events) already report a non-"request" primary unit through
    // totalRequests, so a Plan.monthlyRequestLimit expressed in MB (e.g. 200000
    // for ~200 GB/month) drives the existing request_limit alerts on a spike -
    // and, because the window is the calendar month (not a rolling span), that
    // monthly comparison is apples-to-apples. MB - not fractional GB
    // (UsageSnapshot.totalRequests is an Int column: 3.5 would silently
    // truncate to 3) and not raw bytes (200 GB is 2e11, which overflows
    // Prisma's 32-bit Int and throws at write). Exact bytes and GB are
    // preserved in rawData.bandwidth. Withheld (null) for the "error" state
    // (bandwidth read failed; see postPersistError) and the "partial" state (a
    // capped service subset, or a window that could not reach the 1st of the
    // month - either would understate the calendar-month total).
    //
    // The shared dashboard no longer labels this scalar "Requests" for Render:
    // the provider definition's usageUnitLabel ("Bandwidth (MB)") is honored by
    // ProviderCard and the provider detail page (see usageUnitLabelForProvider
    // in provider-definitions.ts), the same mechanism that relabels langfuse
    // (billable units) and sentry (events). The functional path (request_limit
    // alerting) remains correct on the MB scalar.
    totalRequests:
      bandwidth.status === "ready" ? bandwidth.totalMegabytes : null,
    credits: null,
    rawData: {
      services,
      postgres,
      keyValue,
      resourceCounts: {
        services: services.length,
        postgres: postgres.length,
        keyValue: keyValue.length,
        paidRecords: records.length,
      },
      bandwidth,
      capabilities: {
        accountWideDiscovery: true,
        servicePlan: true,
        serviceStatus: true,
        disks: true,
        replicas: true,
        actualInvoiceCost: false,
        renewalDate: false,
        bandwidthUsage: bandwidth.status === "ready",
      },
    },
    externalBilling: {
      source: "render-service-plans",
      authoritative: true,
      records,
    },
    postPersistError: bandwidthError,
  };
}
