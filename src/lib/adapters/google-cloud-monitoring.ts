import { createHash } from "node:crypto";
import {
  AdapterError,
  configurationError,
  errorResult,
  fetchJson,
  parseNumber,
  type AdapterExternalBillingRecord,
  type AdapterExternalBillingSync,
} from "./helpers";
import {
  fetchGoogleServiceAccountAccessToken,
  GOOGLE_MONITORING_READ_SCOPE,
  parseGoogleServiceAccountCredential,
} from "./google-service-account";

const MONITORING_API = "https://monitoring.googleapis.com/v3";
const GEMINI_SERVICE = "generativelanguage.googleapis.com";
const GEMINI_LOCATION_RESOURCE =
  "generativelanguage.googleapis.com/Location";
const REQUEST_COUNT_METRIC =
  "serviceruntime.googleapis.com/api/request_count";
const NATIVE_QUOTA_PREFIX =
  "generativelanguage.googleapis.com/quota/";
const MAX_TIME_SERIES_PAGES = 5;
const TIME_SERIES_PAGE_SIZE = 1_000;
const MAX_TIME_SERIES_POINTS =
  MAX_TIME_SERIES_PAGES * TIME_SERIES_PAGE_SIZE;
const MAX_DESCRIPTOR_PAGES = 2;
const DESCRIPTOR_PAGE_SIZE = 1_000;
const MAX_DESCRIPTOR_RESULTS =
  MAX_DESCRIPTOR_PAGES * DESCRIPTOR_PAGE_SIZE;
const MAX_NATIVE_QUOTA_QUERIES = 40;
const NATIVE_QUERY_CONCURRENCY = 10;
// Native Gemini quota GAUGEs are sampled every 60 seconds and documented as
// visible within 150 seconds. Fifteen minutes leaves a wide ingestion buffer
// without requesting tens of thousands of raw MTD points per model/location.
const GAUGE_RECENT_LOOKBACK_MS = 15 * 60 * 1_000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETAINED_QUOTAS = 100;

type MonitoringStatus =
  | "ready"
  | "empty"
  | "partial"
  | "permission_denied"
  | "error";
type QueryStatus = "ready" | "empty" | "partial" | "error";
type MetricKind = "DELTA" | "GAUGE";
type NativeQuotaKind = "usage" | "limit";

interface MonitoringPoint {
  value: number;
  endTime: string;
}

interface MonitoringSeries {
  metricLabels: Record<string, string>;
  resourceLabels: Record<string, string>;
  points: MonitoringPoint[];
}

interface QuerySpec {
  name: string;
  metricType: string;
  metricKind: MetricKind;
  resourceType: "consumed_api" | typeof GEMINI_LOCATION_RESOURCE;
  window: { start: string; end: string };
  serviceFilter: boolean;
  alignment?: {
    period: string;
    aligner: "ALIGN_SUM";
    reducer?: "REDUCE_SUM";
    groupByFields?: string[];
  };
}

interface QuerySuccess {
  name: string;
  status: "ready" | "empty";
  series: MonitoringSeries[];
}

interface QueryFailure {
  name: string;
  status: "error";
  error: AdapterError;
}

type QueryOutcome = QuerySuccess | QueryFailure;

interface NativeMetricDescriptor {
  type: string;
  metricKind: MetricKind;
  kind: NativeQuotaKind;
  quotaName: string;
  displayName: string | null;
}

interface NativeQueryOutcome {
  descriptor: NativeMetricDescriptor;
  outcome: QueryOutcome;
}

interface NativeAggregationResult {
  items: GoogleMonitoringQuotaItem[];
  failures: Array<{ name: string; error: AdapterError }>;
}

interface DescriptorDiscoverySuccess {
  status: "ready";
  availableCount: number;
  selected: NativeMetricDescriptor[];
  truncated: boolean;
}

interface DescriptorDiscoveryFailure {
  status: "error";
  error: AdapterError;
}

type DescriptorDiscoveryOutcome =
  | DescriptorDiscoverySuccess
  | DescriptorDiscoveryFailure;

export interface GoogleMonitoringQuotaItem {
  metricType: string;
  quotaName: string;
  limitName: string | null;
  model: string;
  tier: string;
  location: string;
  unit: string;
  value: number;
  reportThrough: string;
}

interface QuotaSummary {
  status: QueryStatus;
  descriptorCount: number;
  queryFailureCount: number;
  emptyRecentGaugeCount: number;
  availableCount: number;
  retainedCount: number;
  truncated: boolean;
  items: GoogleMonitoringQuotaItem[];
  errorCode?: string;
  httpStatus?: number | null;
  retryable?: boolean;
}

export interface GoogleCloudMonitoringResult {
  status: MonitoringStatus;
  projectId: string;
  windowStart: string;
  windowEnd: string;
  totalRequests: number | null;
  reportThrough: string | null;
  descriptorDiscovery: {
    status: "ready" | "error";
    availableCount: number;
    selectedCount: number;
    truncated: boolean;
    errorCode?: string;
    httpStatus?: number | null;
    retryable?: boolean;
  };
  requests: {
    status: "ready" | "empty" | "error";
    source: "aggregate_service_runtime_fallback";
    total: number | null;
    seriesCount: number;
    pointCount: number;
    errorCode?: string;
    httpStatus?: number | null;
    retryable?: boolean;
  };
  quotaUsage: QuotaSummary;
  quotaLimits: QuotaSummary;
  externalBillingSyncs: AdapterExternalBillingSync[];
  partialError?: AdapterError;
}

function invalidResponse(message: string): never {
  throw new AdapterError(message, { code: "INVALID_RESPONSE" });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function cleanProjectId(value: unknown): string {
  const projectId = cleanString(value);
  if (!projectId || !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(projectId)) {
    configurationError(
      "Google Cloud Monitoring requires an exact googleProjectId"
    );
  }
  return projectId;
}

function cleanLabels(value: unknown, field: string): Record<string, string> {
  if (value == null) return {};
  const record = asRecord(value);
  if (!record) invalidResponse(`Google Cloud Monitoring ${field} are malformed`);
  const labels: Record<string, string> = {};
  for (const [key, raw] of Object.entries(record)) {
    if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(key)) {
      invalidResponse(`Google Cloud Monitoring ${field} contain an invalid key`);
    }
    // Monitoring label values are strings, but optional metric dimensions can
    // legitimately be the empty string. Preserve that distinction while
    // keeping the response bounded and rejecting coercion of non-strings.
    if (typeof raw !== "string" || raw.length > 512) {
      invalidResponse(
        `Google Cloud Monitoring ${field} contain an invalid value`
      );
    }
    labels[key] = raw;
  }
  return labels;
}

function isoTimestamp(value: unknown, field: string): string {
  const text = cleanString(value);
  const milliseconds = text == null ? Number.NaN : Date.parse(text);
  if (!Number.isFinite(milliseconds)) {
    invalidResponse(`Google Cloud Monitoring ${field} is invalid`);
  }
  return new Date(milliseconds).toISOString();
}

function numericPoint(value: unknown): number {
  const record = asRecord(value);
  if (!record) invalidResponse("Google Cloud Monitoring point value is malformed");
  const candidates = [record.int64Value, record.doubleValue]
    .filter((candidate) => candidate != null)
    .map(parseNumber);
  if (candidates.length !== 1 || candidates[0] == null) {
    invalidResponse("Google Cloud Monitoring point value is not numeric");
  }
  const number = candidates[0];
  if (!Number.isFinite(number) || number < 0) {
    invalidResponse("Google Cloud Monitoring point value is invalid");
  }
  return number;
}

function validateResourceProject(
  labels: Record<string, string>,
  projectId: string
): void {
  if (labels.project_id != null && labels.project_id !== projectId) {
    invalidResponse(
      "Google Cloud Monitoring returned a time series for another project"
    );
  }
  const resourceContainer = labels.resource_container;
  if (
    resourceContainer != null &&
    resourceContainer !== projectId &&
    resourceContainer !== `projects/${projectId}` &&
    !/^\d+$/.test(resourceContainer)
  ) {
    invalidResponse(
      "Google Cloud Monitoring returned a resource container for another project"
    );
  }
}

function parseSeries(
  value: unknown,
  spec: QuerySpec,
  projectId: string
): MonitoringSeries {
  const record = asRecord(value);
  const metric = asRecord(record?.metric);
  const resource = asRecord(record?.resource);
  if (
    !record ||
    cleanString(metric?.type) !== spec.metricType ||
    cleanString(resource?.type) !== spec.resourceType ||
    !Array.isArray(record.points)
  ) {
    invalidResponse("Google Cloud Monitoring time series is malformed");
  }
  const metricLabels = cleanLabels(metric?.labels, "metric labels");
  const resourceLabels = cleanLabels(resource?.labels, "resource labels");
  validateResourceProject(resourceLabels, projectId);
  if (
    spec.serviceFilter &&
    resourceLabels.service !== GEMINI_SERVICE
  ) {
    invalidResponse("Google Cloud Monitoring returned an out-of-scope service");
  }
  const points = record.points.map((rawPoint) => {
    const point = asRecord(rawPoint);
    const interval = asRecord(point?.interval);
    if (!point || !interval) {
      invalidResponse("Google Cloud Monitoring point is malformed");
    }
    return {
      value: numericPoint(point.value),
      endTime: isoTimestamp(interval.endTime, "point endTime"),
    };
  });
  return { metricLabels, resourceLabels, points };
}

function monitoringFilter(spec: QuerySpec, projectId: string): string {
  return [
    `project = "${projectId}"`,
    `metric.type = "${spec.metricType}"`,
    `resource.type = "${spec.resourceType}"`,
    ...(spec.serviceFilter
      ? [`resource.labels.service = "${GEMINI_SERVICE}"`]
      : []),
  ].join(" AND ");
}

async function fetchTimeSeries(
  projectId: string,
  token: string,
  spec: QuerySpec
): Promise<MonitoringSeries[]> {
  const series: MonitoringSeries[] = [];
  const seenTokens = new Set<string>();
  let pointCount = 0;
  let pageToken: string | null = null;

  for (let page = 0; page < MAX_TIME_SERIES_PAGES; page++) {
    const url = new URL(
      `${MONITORING_API}/projects/${encodeURIComponent(projectId)}/timeSeries`
    );
    url.searchParams.set("filter", monitoringFilter(spec, projectId));
    url.searchParams.set("interval.startTime", spec.window.start);
    url.searchParams.set("interval.endTime", spec.window.end);
    url.searchParams.set("view", "FULL");
    url.searchParams.set("pageSize", String(TIME_SERIES_PAGE_SIZE));
    if (spec.alignment) {
      url.searchParams.set(
        "aggregation.alignmentPeriod",
        spec.alignment.period
      );
      url.searchParams.set(
        "aggregation.perSeriesAligner",
        spec.alignment.aligner
      );
      if (spec.alignment.reducer) {
        url.searchParams.set(
          "aggregation.crossSeriesReducer",
          spec.alignment.reducer
        );
      }
      for (const field of spec.alignment.groupByFields ?? []) {
        url.searchParams.append("aggregation.groupByFields", field);
      }
    }
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const response = await fetchJson(
      url.toString(),
      { headers: { Authorization: `Bearer ${token}` } },
      { timeoutMs: REQUEST_TIMEOUT_MS, maxResponseBytes: MAX_RESPONSE_BYTES }
    );
    if (!response.ok) {
      errorResult(response.status, {
        note: `Google Cloud Monitoring ${spec.name} query failed`,
      });
    }
    const data = asRecord(response.data);
    if (!data) invalidResponse("Google Cloud Monitoring response is malformed");
    if (data.timeSeries != null && !Array.isArray(data.timeSeries)) {
      invalidResponse("Google Cloud Monitoring timeSeries is malformed");
    }
    for (const rawSeries of (data.timeSeries as unknown[] | undefined) ?? []) {
      const parsed = parseSeries(rawSeries, spec, projectId);
      pointCount += parsed.points.length;
      if (pointCount > MAX_TIME_SERIES_POINTS) {
        invalidResponse("Google Cloud Monitoring query exceeded the point limit");
      }
      series.push(parsed);
    }

    const nextToken = cleanString(data.nextPageToken);
    if (!nextToken) return series;
    if (seenTokens.has(nextToken)) {
      invalidResponse("Google Cloud Monitoring repeated a page token");
    }
    seenTokens.add(nextToken);
    pageToken = nextToken;
  }
  invalidResponse("Google Cloud Monitoring query exceeded the page limit");
}

function nativeDescriptor(value: unknown): NativeMetricDescriptor | null {
  const record = asRecord(value);
  const type = cleanString(record?.type);
  const metricKind = cleanString(record?.metricKind);
  const valueType = cleanString(record?.valueType);
  if (!record || !type || !metricKind || !valueType) {
    invalidResponse("Google Cloud Monitoring metric descriptor is malformed");
  }
  const match = type.match(
    /^generativelanguage\.googleapis\.com\/quota\/([a-z0-9_]+)\/(usage|limit)$/
  );
  if (!match) return null;
  if (
    (metricKind !== "DELTA" && metricKind !== "GAUGE") ||
    valueType !== "INT64"
  ) {
    invalidResponse(
      `Google Cloud Monitoring quota descriptor ${type} has unsupported semantics`
    );
  }
  if (record.monitoredResourceTypes != null) {
    if (!Array.isArray(record.monitoredResourceTypes)) {
      invalidResponse(
        "Google Cloud Monitoring descriptor resource types are malformed"
      );
    }
    const resourceTypes = record.monitoredResourceTypes.map(cleanString);
    if (
      resourceTypes.length > 0 &&
      !resourceTypes.includes(GEMINI_LOCATION_RESOURCE)
    ) {
      invalidResponse(
        `Google Cloud Monitoring quota descriptor ${type} has an unexpected resource type`
      );
    }
  }
  return {
    type,
    metricKind,
    quotaName: match[1],
    kind: match[2] as NativeQuotaKind,
    displayName: cleanString(record.displayName),
  };
}

function quotaUnit(quotaName: string): string {
  if (quotaName.includes("token")) return "tokens";
  if (quotaName.includes("request")) return "requests";
  if (quotaName.includes("batch")) return "batches";
  if (quotaName.includes("file")) return "files";
  return "units";
}

function nativeDescriptorPriority(descriptor: NativeMetricDescriptor): string {
  const unit = quotaUnit(descriptor.quotaName);
  const priority = unit === "tokens" ? "0" : unit === "requests" ? "1" : "2";
  return `${priority}:${descriptor.quotaName}:${descriptor.kind}`;
}

function selectNativeDescriptors(
  descriptors: NativeMetricDescriptor[]
): NativeMetricDescriptor[] {
  const groups = new Map<string, NativeMetricDescriptor[]>();
  for (const descriptor of descriptors) {
    const items = groups.get(descriptor.quotaName) ?? [];
    items.push(descriptor);
    groups.set(descriptor.quotaName, items);
  }
  const orderedGroups = [...groups.values()].sort((left, right) =>
    nativeDescriptorPriority(left[0]).localeCompare(
      nativeDescriptorPriority(right[0])
    )
  );
  const selected: NativeMetricDescriptor[] = [];
  for (const group of orderedGroups) {
    const sorted = [...group].sort((left, right) =>
      left.kind.localeCompare(right.kind)
    );
    if (selected.length + sorted.length > MAX_NATIVE_QUOTA_QUERIES) break;
    selected.push(...sorted);
  }
  return selected;
}

function descriptorDiscoveryResult(
  descriptors: Map<string, NativeMetricDescriptor>,
  boundedPages: boolean
): DescriptorDiscoverySuccess {
  const all = [...descriptors.values()];
  const selected = selectNativeDescriptors(all);
  return {
    status: "ready",
    availableCount: all.length,
    selected,
    truncated: boundedPages || selected.length !== all.length,
  };
}

async function discoverNativeDescriptors(
  projectId: string,
  token: string
): Promise<DescriptorDiscoverySuccess> {
  const descriptors = new Map<string, NativeMetricDescriptor>();
  const seenTokens = new Set<string>();
  let pageToken: string | null = null;

  for (let page = 0; page < MAX_DESCRIPTOR_PAGES; page++) {
    const url = new URL(
      `${MONITORING_API}/projects/${encodeURIComponent(projectId)}/metricDescriptors`
    );
    url.searchParams.set(
      "filter",
      `metric.type = starts_with("${NATIVE_QUOTA_PREFIX}")`
    );
    url.searchParams.set("activeOnly", "true");
    url.searchParams.set("pageSize", String(DESCRIPTOR_PAGE_SIZE));
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await fetchJson(
      url.toString(),
      { headers: { Authorization: `Bearer ${token}` } },
      { timeoutMs: REQUEST_TIMEOUT_MS, maxResponseBytes: MAX_RESPONSE_BYTES }
    );
    if (!response.ok) {
      errorResult(response.status, {
        note: "Google Cloud Monitoring metric descriptor discovery failed",
      });
    }
    const data = asRecord(response.data);
    if (!data) {
      invalidResponse("Google Cloud Monitoring descriptor response is malformed");
    }
    if (
      data.metricDescriptors != null &&
      !Array.isArray(data.metricDescriptors)
    ) {
      invalidResponse("Google Cloud Monitoring descriptors are malformed");
    }
    for (const value of
      (data.metricDescriptors as unknown[] | undefined) ?? []) {
      const descriptor = nativeDescriptor(value);
      if (descriptor) descriptors.set(descriptor.type, descriptor);
      if (descriptors.size > MAX_DESCRIPTOR_RESULTS) {
        invalidResponse(
          "Google Cloud Monitoring descriptor discovery exceeded the result limit"
        );
      }
    }
    const nextToken = cleanString(data.nextPageToken);
    if (!nextToken) {
      return descriptorDiscoveryResult(descriptors, false);
    }
    if (seenTokens.has(nextToken)) {
      invalidResponse("Google Cloud Monitoring repeated a descriptor page token");
    }
    seenTokens.add(nextToken);
    if (page === MAX_DESCRIPTOR_PAGES - 1) {
      return descriptorDiscoveryResult(descriptors, true);
    }
    pageToken = nextToken;
  }
  return descriptorDiscoveryResult(descriptors, true);
}

function monthWindow(now = new Date()): { start: string; end: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { start: start.toISOString(), end: now.toISOString() };
}

function latestTimestamp(series: MonitoringSeries[]): string | null {
  return (
    series
      .flatMap((item) => item.points.map((point) => point.endTime))
      .sort()
      .at(-1) ?? null
  );
}

function safeSum(values: number[], label: string): number | null {
  if (values.length === 0) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(total) || total < 0) {
    invalidResponse(`Google Cloud Monitoring ${label} total is invalid`);
  }
  return total;
}

function displayQuotaName(value: string): string {
  const tail = value.split("/").filter(Boolean).at(-1) ?? value;
  return tail
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function quotaTier(descriptor: NativeMetricDescriptor): string {
  const quotaName = descriptor.quotaName;
  // Google documents this legacy-looking name as "requests per model (paid
  // tier)" even though the metric path itself omits paid_tier.
  // https://cloud.google.com/monitoring/api/metrics_gcp_d_h
  if (quotaName === "generate_requests_per_model") return "paid tier";
  const numbered = quotaName.match(/paid_tier_(\d+)/);
  if (numbered) return `paid tier ${numbered[1]}`;
  if (quotaName.includes("paid_tier")) return "paid tier";
  if (quotaName.includes("free_tier")) return "free tier";
  const display = descriptor.displayName?.toLowerCase() ?? "";
  const displayNumbered = display.match(/paid tier\s+(\d+)/);
  if (displayNumbered) return `paid tier ${displayNumbered[1]}`;
  if (display.includes("paid tier")) return "paid tier";
  if (display.includes("free tier")) return "free tier";
  return "provider-defined tier";
}

function stableExternalId(prefix: string, values: string[]): string {
  const digest = createHash("sha256")
    .update("api-usage-monitor:google-monitoring:v2\0", "utf8")
    .update(JSON.stringify(values), "utf8")
    .digest("hex")
    .slice(0, 32);
  return `${prefix}:${digest}`;
}

function querySpecForDescriptor(
  descriptor: NativeMetricDescriptor,
  window: { start: string; end: string }
): QuerySpec {
  const descriptorWindow =
    descriptor.metricKind === "GAUGE"
      ? {
          start: new Date(
            Date.parse(window.end) - GAUGE_RECENT_LOOKBACK_MS
          ).toISOString(),
          end: window.end,
        }
      : window;
  return {
    name: `native:${descriptor.type}`,
    metricType: descriptor.type,
    metricKind: descriptor.metricKind,
    resourceType: GEMINI_LOCATION_RESOURCE,
    window: descriptorWindow,
    serviceFilter: false,
    ...(descriptor.metricKind === "DELTA"
      ? {
          alignment: {
            period: "86400s",
            aligner: "ALIGN_SUM" as const,
          },
        }
      : {}),
  };
}

async function queryOutcome(
  projectId: string,
  token: string,
  spec: QuerySpec
): Promise<QueryOutcome> {
  try {
    const series = await fetchTimeSeries(projectId, token, spec);
    return {
      name: spec.name,
      status: series.some((item) => item.points.length > 0) ? "ready" : "empty",
      series,
    };
  } catch (error) {
    return {
      name: spec.name,
      status: "error",
      error:
        error instanceof AdapterError
          ? error
          : new AdapterError(
              `Google Cloud Monitoring ${spec.name} query failed`,
              {
                code: "TRANSPORT_ERROR",
                retryable: true,
                cause: error,
              }
            ),
    };
  }
}

async function queryNativeDescriptors(
  descriptors: NativeMetricDescriptor[],
  projectId: string,
  token: string,
  window: { start: string; end: string }
): Promise<NativeQueryOutcome[]> {
  const outcomes: NativeQueryOutcome[] = [];
  for (
    let offset = 0;
    offset < descriptors.length;
    offset += NATIVE_QUERY_CONCURRENCY
  ) {
    const batch = descriptors.slice(
      offset,
      offset + NATIVE_QUERY_CONCURRENCY
    );
    outcomes.push(
      ...(await Promise.all(
        batch.map(async (descriptor) => ({
          descriptor,
          outcome: await queryOutcome(
            projectId,
            token,
            querySpecForDescriptor(descriptor, window)
          ),
        }))
      ))
    );
  }
  return outcomes;
}

function aggregateNativeQuotas(
  outcomes: NativeQueryOutcome[],
  kind: NativeQuotaKind
): NativeAggregationResult {
  const grouped = new Map<string, GoogleMonitoringQuotaItem>();
  const failedKeys = new Set<string>();
  const failures: Array<{ name: string; error: AdapterError }> = [];
  for (const { descriptor, outcome } of outcomes) {
    if (descriptor.kind !== kind || outcome.status === "error") continue;
    for (const series of outcome.series) {
      if (series.points.length === 0) continue;
      const model = series.metricLabels.model || "all models";
      const limitName = series.metricLabels.limit_name || null;
      const location = series.resourceLabels.location || "global";
      const tier = quotaTier(descriptor);
      const unit = quotaUnit(descriptor.quotaName);
      const key = JSON.stringify([
        descriptor.type,
        model,
        limitName,
        location,
        tier,
      ]);
      if (failedKeys.has(key)) continue;
      try {
        const latest = [...series.points].sort((left, right) =>
          right.endTime.localeCompare(left.endTime)
        )[0];
        const value =
          descriptor.metricKind === "DELTA"
            ? safeSum(
                series.points.map((point) => point.value),
                "native quota usage"
              )
            : latest.value;
        if (value == null || !Number.isSafeInteger(value)) {
          invalidResponse(
            "Google Cloud Monitoring native quota value is invalid"
          );
        }
        const reportThrough =
          descriptor.metricKind === "DELTA"
            ? latestTimestamp([series])!
            : latest.endTime;
        const existing = grouped.get(key);
        if (!existing) {
          grouped.set(key, {
            metricType: descriptor.type,
            quotaName: descriptor.quotaName,
            limitName,
            model,
            tier,
            location,
            unit,
            value,
            reportThrough,
          });
        } else if (descriptor.metricKind === "DELTA") {
          const combined = existing.value + value;
          if (!Number.isSafeInteger(combined)) {
            invalidResponse(
              "Google Cloud Monitoring native quota total is invalid"
            );
          }
          existing.value = combined;
          if (reportThrough > existing.reportThrough) {
            existing.reportThrough = reportThrough;
          }
        } else if (
          reportThrough > existing.reportThrough ||
          (reportThrough === existing.reportThrough && value > existing.value)
        ) {
          existing.value = value;
          existing.reportThrough = reportThrough;
        }
      } catch (error) {
        failedKeys.add(key);
        // Never retain a partial group: doing so would silently under-report a
        // quota after one of its component series failed validation.
        grouped.delete(key);
        failures.push({
          name: `${descriptor.type}:${model}:${location}`,
          error:
            error instanceof AdapterError
              ? error
              : new AdapterError(
                  "Google Cloud Monitoring native quota aggregation failed",
                  { code: "INVALID_RESPONSE", cause: error }
                ),
        });
      }
    }
  }
  return {
    items: [...grouped.values()].sort(
      (left, right) =>
        left.quotaName.localeCompare(right.quotaName) ||
        left.model.localeCompare(right.model) ||
        left.tier.localeCompare(right.tier) ||
        left.location.localeCompare(right.location)
    ),
    failures,
  };
}

function requestRecord(
  totalRequests: number,
  window: { start: string; end: string },
  reportThrough: string
): AdapterExternalBillingRecord {
  return {
    externalId: "gemini-requests-mtd",
    kind: "account",
    serviceName: "Gemini API aggregate requests",
    planName: "Service Runtime aggregate fallback",
    status: "active",
    currentPeriodStart: window.start,
    currentPeriodEnd: reportThrough,
    usageQuantity: totalRequests,
    usageUnit: "requests",
    rollupRole: "metadata",
    dateKind: "report_through",
  };
}

function nativeQuotaRecord(
  item: GoogleMonitoringQuotaItem,
  kind: NativeQuotaKind,
  windowStart: string
): AdapterExternalBillingRecord {
  const dimensions = [item.model, item.tier, item.location]
    .filter(Boolean)
    .join(" · ");
  const base: AdapterExternalBillingRecord = {
    externalId: stableExternalId(`native-quota-${kind}`, [
      item.metricType,
      item.model,
      item.limitName ?? "",
      item.tier,
      item.location,
    ]),
    kind: "account",
    serviceName: `Gemini ${displayQuotaName(item.quotaName)} · ${dimensions}`,
    planName: `Cloud Monitoring native quota ${kind}`,
    status: "active",
    currentPeriodEnd: item.reportThrough,
    usageUnit: item.unit,
    rollupRole: "metadata",
    dateKind: "report_through",
  };
  if (kind === "usage") {
    return {
      ...base,
      currentPeriodStart: windowStart,
      usageQuantity: item.value,
    };
  }
  return {
    ...base,
    requestLimit: item.value,
    requestLimitWindow: item.limitName
      ? displayQuotaName(item.limitName)
      : displayQuotaName(item.quotaName),
  };
}

function querySummary(outcome: QueryOutcome) {
  if (outcome.status !== "error") {
    return { status: outcome.status } as const;
  }
  return {
    status: "error" as const,
    errorCode: outcome.error.code,
    httpStatus: outcome.error.status,
    retryable: outcome.error.retryable,
  };
}

function combinedQueryError(
  failures: Array<{ name: string; error: AdapterError }>
): AdapterError | undefined {
  if (failures.length === 0) return undefined;
  if (failures.length === 1) return failures[0].error;
  return new AdapterError(
    `Google Cloud Monitoring partial sync failed: ${failures
      .map(({ name, error }) => `${name}: ${error.message}`)
      .join("; ")}`,
    {
      code: failures[0].error.code,
      status: failures.every(
        ({ error }) => error.status === failures[0].error.status
      )
        ? failures[0].error.status
        : null,
      retryable: failures.some(({ error }) => error.retryable),
    }
  );
}

function quotaSummary(input: {
  discovery: DescriptorDiscoveryOutcome;
  outcomes: NativeQueryOutcome[];
  kind: NativeQuotaKind;
  items: GoogleMonitoringQuotaItem[];
  aggregationFailures: Array<{ name: string; error: AdapterError }>;
}): QuotaSummary {
  if (input.discovery.status === "error") {
    return {
      status: "error",
      descriptorCount: 0,
      queryFailureCount: 0,
      emptyRecentGaugeCount: 0,
      availableCount: 0,
      retainedCount: 0,
      truncated: false,
      items: [],
      errorCode: input.discovery.error.code,
      httpStatus: input.discovery.error.status,
      retryable: input.discovery.error.retryable,
    };
  }
  const descriptors = input.discovery.selected.filter(
    (descriptor) => descriptor.kind === input.kind
  );
  const queryFailures = input.outcomes.flatMap(({ descriptor, outcome }) =>
    descriptor.kind === input.kind && outcome.status === "error"
      ? [{ name: descriptor.type, error: outcome.error }]
      : []
  );
  const failures = [...queryFailures, ...input.aggregationFailures];
  const emptyRecentGauges = input.outcomes.filter(
    ({ descriptor, outcome }) =>
      descriptor.kind === input.kind &&
      descriptor.metricKind === "GAUGE" &&
      outcome.status === "empty"
  );
  const retained = input.items.slice(0, MAX_RETAINED_QUOTAS);
  const itemTruncated = retained.length !== input.items.length;
  const partial =
    input.discovery.truncated ||
    failures.length > 0 ||
    emptyRecentGauges.length > 0 ||
    itemTruncated;
  return {
    status: partial
      ? "partial"
      : retained.length > 0
        ? "ready"
        : "empty",
    descriptorCount: descriptors.length,
    queryFailureCount: failures.length,
    emptyRecentGaugeCount: emptyRecentGauges.length,
    availableCount: input.items.length,
    retainedCount: retained.length,
    truncated: input.discovery.truncated || itemTruncated,
    items: retained,
    ...(failures[0]
      ? {
          errorCode: failures[0].error.code,
          httpStatus: failures[0].error.status,
          retryable: failures.some(({ error }) => error.retryable),
        }
      : {}),
  };
}

function isPermissionFailure(error: AdapterError): boolean {
  return error.status === 401 || error.status === 403;
}

export async function fetchGoogleCloudMonitoring(
  config: Record<string, unknown>
): Promise<GoogleCloudMonitoringResult> {
  const projectId = cleanProjectId(config.googleProjectId);
  const credential = parseGoogleServiceAccountCredential(
    config.serviceAccountJson
  );
  const token = await fetchGoogleServiceAccountAccessToken(
    credential,
    GOOGLE_MONITORING_READ_SCOPE
  );
  const window = monthWindow();
  const requestSpec: QuerySpec = {
    name: "aggregateRequestFallback",
    metricType: REQUEST_COUNT_METRIC,
    metricKind: "DELTA",
    resourceType: "consumed_api",
    window,
    serviceFilter: true,
    alignment: {
      period: "86400s",
      aligner: "ALIGN_SUM",
      reducer: "REDUCE_SUM",
      groupByFields: ["resource.labels.service"],
    },
  };

  const discoveryPromise: Promise<DescriptorDiscoveryOutcome> =
    discoverNativeDescriptors(projectId, token).then(
      (value): DescriptorDiscoveryOutcome => value,
      (error): DescriptorDiscoveryOutcome => ({
        status: "error",
        error:
          error instanceof AdapterError
            ? error
            : new AdapterError(
                "Google Cloud Monitoring descriptor discovery failed",
                {
                  code: "TRANSPORT_ERROR",
                  retryable: true,
                  cause: error,
                }
              ),
      })
    );
  const [requests, discovery] = await Promise.all([
    queryOutcome(projectId, token, requestSpec),
    discoveryPromise,
  ]);
  const nativeOutcomes =
    discovery.status === "ready"
      ? await queryNativeDescriptors(
          discovery.selected,
          projectId,
          token,
          window
        )
      : [];
  const requestTotal =
    requests.status === "error"
      ? null
      : safeSum(
          requests.series.flatMap((series) =>
            series.points.map((point) => point.value)
          ),
          "aggregate request"
        );
  const requestReportThrough =
    requests.status === "error" ? null : latestTimestamp(requests.series);
  const usageAggregation = aggregateNativeQuotas(nativeOutcomes, "usage");
  const limitAggregation = aggregateNativeQuotas(nativeOutcomes, "limit");
  const usage = quotaSummary({
    discovery,
    outcomes: nativeOutcomes,
    kind: "usage",
    items: usageAggregation.items,
    aggregationFailures: usageAggregation.failures,
  });
  const limits = quotaSummary({
    discovery,
    outcomes: nativeOutcomes,
    kind: "limit",
    items: limitAggregation.items,
    aggregationFailures: limitAggregation.failures,
  });
  const failures: Array<{ name: string; error: AdapterError }> = [
    ...(requests.status === "error"
      ? [{ name: requests.name, error: requests.error }]
      : []),
    ...(discovery.status === "error"
      ? [{ name: "descriptorDiscovery", error: discovery.error }]
      : []),
    ...nativeOutcomes.flatMap(({ descriptor, outcome }) =>
      outcome.status === "error"
        ? [{ name: descriptor.type, error: outcome.error }]
        : []
    ),
    ...usageAggregation.failures,
    ...limitAggregation.failures,
  ];
  const successfulQueries =
    (requests.status === "error" ? 0 : 1) +
    nativeOutcomes.filter(({ outcome }) => outcome.status !== "error").length;
  const anyData =
    requestTotal != null || usage.items.length > 0 || limits.items.length > 0;
  const boundedPartial =
    discovery.status === "ready" &&
    (discovery.truncated ||
      usage.status === "partial" ||
      limits.status === "partial");
  const permissionDenied =
    successfulQueries === 0 &&
    failures.length > 0 &&
    failures.every(({ error }) => isPermissionFailure(error));
  const status: MonitoringStatus =
    failures.length > 0 || boundedPartial
      ? successfulQueries > 0
        ? "partial"
        : permissionDenied
          ? "permission_denied"
          : "error"
      : anyData
        ? "ready"
        : "empty";

  const externalBillingSyncs: AdapterExternalBillingSync[] = [];
  if (requests.status !== "error") {
    const observedAggregate =
      requestTotal != null && requestReportThrough != null;
    externalBillingSyncs.push({
      source: "google-cloud-monitoring-requests",
      // request_count can remain empty during Google's documented visibility
      // delay. Only a real aggregate point is current/authoritative; an empty
      // query means unknown and must preserve the previous MTD row.
      authoritative: observedAggregate,
      records: observedAggregate
        ? [requestRecord(requestTotal, window, requestReportThrough)]
        : [],
    });
  }
  if (discovery.status === "ready") {
    externalBillingSyncs.push(
      {
        source: "google-cloud-monitoring-native-quota-usage",
        // Discovery is intentionally activeOnly, so a missing descriptor means
        // "no recent series", not authoritative deletion of month-to-date
        // history. Failed/truncated queries likewise retain prior dimensions.
        authoritative: false,
        records: usage.items.map((item) =>
          nativeQuotaRecord(item, "usage", window.start)
        ),
      },
      {
        source: "google-cloud-monitoring-native-quota-limits",
        authoritative: false,
        records: limits.items.map((item) =>
          nativeQuotaRecord(item, "limit", window.start)
        ),
      }
    );
  }

  return {
    status,
    projectId,
    windowStart: window.start,
    windowEnd: window.end,
    totalRequests: requestTotal,
    reportThrough:
      [
        requestReportThrough,
        ...usage.items.map((item) => item.reportThrough),
        ...limits.items.map((item) => item.reportThrough),
      ]
        .filter((value): value is string => value != null)
        .sort()
        .at(-1) ?? null,
    descriptorDiscovery:
      discovery.status === "ready"
        ? {
            status: "ready",
            availableCount: discovery.availableCount,
            selectedCount: discovery.selected.length,
            truncated: discovery.truncated,
          }
        : {
            status: "error",
            availableCount: 0,
            selectedCount: 0,
            truncated: false,
            errorCode: discovery.error.code,
            httpStatus: discovery.error.status,
            retryable: discovery.error.retryable,
          },
    requests: {
      ...querySummary(requests),
      source: "aggregate_service_runtime_fallback",
      total: requestTotal,
      seriesCount: requests.status === "error" ? 0 : requests.series.length,
      pointCount:
        requests.status === "error"
          ? 0
          : requests.series.reduce(
              (sum, series) => sum + series.points.length,
              0
            ),
    },
    quotaUsage: usage,
    quotaLimits: limits,
    externalBillingSyncs,
    partialError: combinedQueryError(failures),
  };
}
