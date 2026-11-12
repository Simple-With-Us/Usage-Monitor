/**
 * Hetzner host metrics + Coolify per-app resource inventory for the mobile
 * Client Monitor and (later) web ops surfaces.
 *
 * Pattern mirrored from Socratic.Trade's `/api/admin/server-metrics`, trimmed
 * for Usage Monitor: no admin session, dual-auth via dashboard session or
 * USAGE_READ_TOKEN, and an explicit `self` flag on the Usage Monitor Coolify
 * application so the client can split "this app" vs "whole host".
 *
 * Secrets never leave the server. Responses are bounded, cached, and free of
 * absolute paths / credentials.
 */

import {
  fetchFleetBackupStatus,
  FLEET_COOLIFY_APP_UUIDS,
  type FleetBackupStatusPayload,
} from "@/lib/fleet-backup-status";
import { getDiskRuntimeStatus } from "@/lib/runtime-health";
import {
  recordAndBuildPreventionPanel,
  type HostPreventionPanel,
} from "@/lib/server-metrics-indicators";

export const SERVER_METRICS_CACHE_TTL_MS = 120_000;
export const SERVER_METRICS_FAILURE_RETRY_MS = 30_000;
export const SERVER_METRICS_MAX_STALE_MS = 10 * 60_000;

const MAX_PROVIDER_RESPONSE_BYTES = 512 * 1024;
const DEFAULT_COOLIFY_HOST = "https://host.jays.services";
/** Coolify server UUID for the fleet host. Overridable via COOLIFY_SERVER_UUID. */
const DEFAULT_COOLIFY_SERVER_UUID = process.env.COOLIFY_SERVER_UUID || "";
/** Coolify application UUID for Usage Monitor production. Overridable via COOLIFY_APP_UUID. */
const DEFAULT_COOLIFY_APP_UUID = process.env.COOLIFY_APP_UUID || "";
/** Hetzner Cloud server id for fleet host. Overridable via HETZNER_SERVER_ID. */
const DEFAULT_HETZNER_SERVER_ID = process.env.HETZNER_SERVER_ID || "";

export type ServerMetricsConfigurationState =
  | "configured"
  | "partial"
  | "missing";

export interface ServerMetricsMetricValue {
  timestamp: number;
  value: number;
}

export interface ServerMetricsHostInfo {
  name: string | null;
  status: string | null;
  serverType: string | null;
  cpus: number | null;
  memoryTotalBytes: number | null;
  location: string | null;
  ip: string | null;
  /** Hetzner automatic backup window (e.g. "14-18") when enabled. */
  backupWindow: string | null;
}

export interface ServerMetricsResource {
  uuid: string;
  name: string;
  type: string;
  status: string;
  /** True when this resource is the Usage Monitor app itself. */
  self: boolean;
  /**
   * When this Coolify resource is a known fleet app (ST / CT / UM), the stable
   * fleet id used to join backup location rows.
   */
  fleetAppId?: "usage-monitor" | "socratic-trade" | "congress-trade" | null;
  /** Title Case product label when fleetAppId is known. */
  fleetLabel?: string | null;
}

export interface ServerMetricsPayload {
  degraded: boolean;
  stale: boolean;
  cacheAgeSeconds: number;
  configuration: {
    hetzner: ServerMetricsConfigurationState;
    coolify: ServerMetricsConfigurationState;
  };
  host: ServerMetricsHostInfo;
  /** Latest single-sample rollup of host metrics (null when unavailable). */
  hostUsage: {
    cpuPct: number | null;
    networkRxBytesPerSec: number | null;
    networkTxBytesPerSec: number | null;
    diskReadBytesPerSec: number | null;
    diskWriteBytesPerSec: number | null;
  };
  /** Full 1h series (sampled) for charts — capped. */
  metrics: {
    cpu: ServerMetricsMetricValue[];
    networkRx: ServerMetricsMetricValue[];
    networkTx: ServerMetricsMetricValue[];
    diskRead: ServerMetricsMetricValue[];
    diskWrite: ServerMetricsMetricValue[];
  };
  /** Coolify resources on the host; `self` marks Usage Monitor. */
  resources: ServerMetricsResource[];
  /** Convenience slice: only the Usage Monitor application row(s). */
  selfResources: ServerMetricsResource[];
  /** Local SQLite volume headroom (same numbers as /api/ready disk check). */
  appDisk: {
    freeBytes: number | null;
    totalBytes: number | null;
    usedPct: number | null;
    ok: boolean;
  };
  /**
   * Off-site + local backup status for every fleet app on this host
   * (Usage Monitor, Socratic.Trade, Congress.Trade), per location.
   */
  fleetBackups: FleetBackupStatusPayload | null;
  /**
   * Prevention panel: risk indicators (CPU / disk / apps / backups) plus a
   * short process-local poll history for post-incident trend spotting.
   */
  prevention: HostPreventionPanel | null;
  asOf: string;
  error?: string;
  warnings?: string[];
}

interface CacheEntry {
  key: string;
  payload: ServerMetricsPayload;
  expiresAt: number;
  discardAt: number;
}

const runtime: {
  cache?: CacheEntry;
  inFlight?: { key: string; promise: Promise<ServerMetricsPayload> };
} = {};

export function resetServerMetricsCacheForTests(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("server metrics cache can only be reset in tests");
  }
  runtime.cache = undefined;
  runtime.inFlight = undefined;
}

function withPrevention(
  payload: Omit<ServerMetricsPayload, "prevention"> & {
    prevention?: HostPreventionPanel | null;
  }
): ServerMetricsPayload {
  return {
    ...payload,
    prevention: recordAndBuildPreventionPanel(payload),
  };
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function readText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readPositiveNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function configurationState(
  first: string | undefined,
  second: string | undefined
): ServerMetricsConfigurationState {
  if (first && second) return "configured";
  if (first || second) return "partial";
  return "missing";
}

function readConfiguration() {
  const hetznerToken =
    readText(process.env.HCLOUD_TOKEN) ||
    readText(process.env.HETZNER_API_TOKEN) ||
    readText(process.env.HETZNER_API_KEY);
  const hetznerServerId =
    readText(process.env.HETZNER_SERVER_ID) || DEFAULT_HETZNER_SERVER_ID;

  // Prefer read-only stats token. Never use COOLIFY_AGENTS for product metrics.
  const coolifyToken =
    readText(process.env.COOLIFY_SERVER_STATS) ||
    readText(process.env.COOLIFY_API_TOKEN);
  const coolifyHost =
    readText(process.env.COOLIFY_HOST) || DEFAULT_COOLIFY_HOST;
  const coolifyServerUuid =
    readText(process.env.COOLIFY_SERVER_UUID) || DEFAULT_COOLIFY_SERVER_UUID;
  const coolifyAppUuid =
    readText(process.env.COOLIFY_APP_UUID) ||
    readText(process.env.COOLIFY_USAGE_MONITOR_UUID) ||
    DEFAULT_COOLIFY_APP_UUID;

  return {
    hetznerToken,
    hetznerServerId,
    coolifyToken,
    coolifyHost: coolifyHost.replace(/\/$/, ""),
    coolifyServerUuid,
    coolifyAppUuid,
    states: {
      // Defaults only apply once a token is present — a bare default server id
      // without credentials is still "missing", not "partial".
      hetzner: hetznerToken
        ? configurationState(hetznerToken, hetznerServerId)
        : ("missing" as const),
      // Token alone is enough for Coolify when defaults supply the server UUID.
      coolify: coolifyToken
        ? ("configured" as const)
        : ("missing" as const),
    },
  };
}

function emptyMetrics(): ServerMetricsPayload["metrics"] {
  return {
    cpu: [],
    networkRx: [],
    networkTx: [],
    diskRead: [],
    diskWrite: [],
  };
}

function emptyHost(): ServerMetricsHostInfo {
  return {
    name: null,
    status: null,
    serverType: null,
    cpus: null,
    memoryTotalBytes: null,
    location: null,
    ip: null,
    backupWindow: null,
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function withCacheAge(
  payload: ServerMetricsPayload,
  now: number
): ServerMetricsPayload {
  const asOf = Date.parse(payload.asOf);
  return {
    ...payload,
    cacheAgeSeconds: Number.isFinite(asOf)
      ? Math.max(0, Math.floor((now - asOf) / 1000))
      : 0,
  };
}

interface ProviderFetchResult {
  payload?: unknown;
  error?: string;
}

async function fetchProviderJson(
  label: string,
  url: string,
  headers: Record<string, string>
): Promise<ProviderFetchResult> {
  try {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
    if (!response.ok) {
      return { error: `${label} returned HTTP ${response.status}.` };
    }
    try {
      return { payload: await readBoundedJson(response, MAX_PROVIDER_RESPONSE_BYTES) };
    } catch {
      return { error: `${label} returned invalid or oversized JSON.` };
    }
  } catch {
    return { error: `${label} was unavailable.` };
  }
}

async function readBoundedJson(
  response: Response,
  maxBytes: number
): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error("response_too_large");
  }
  if (!response.body) throw new Error("empty_response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error("response_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function toFiniteMetricNumber(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  if (typeof value === "string" && !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseHetznerTimeSeries(
  timeSeries: unknown,
  coreCount: number | null
): {
  metrics: ServerMetricsPayload["metrics"];
  warnings: string[];
} {
  const series = asRecord(timeSeries) ?? {};
  let omittedSamples = 0;
  const result = emptyMetrics();

  const getValues = (key: string): ServerMetricsMetricValue[] => {
    const raw = asRecord(series[key])?.values;
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((item) => {
      if (!Array.isArray(item) || item.length < 2) {
        omittedSamples += 1;
        return [];
      }
      const timestamp = toFiniteMetricNumber(item[0]);
      const value = toFiniteMetricNumber(item[1]);
      if (timestamp === undefined || value === undefined) {
        omittedSamples += 1;
        return [];
      }
      return [{ timestamp, value }];
    });
  };

  const keys = Object.keys(series);
  const cpuKey = keys.find((key) => key.startsWith("cpu")) ?? "cpu";
  const diskReadKey =
    keys.find((key) => key.includes("bandwidth.read")) ??
    "disk.0.bandwidth.read";
  const diskWriteKey =
    keys.find((key) => key.includes("bandwidth.write")) ??
    "disk.0.bandwidth.write";
  const netRxKey =
    keys.find(
      (key) => key.includes("bandwidth.in") || key.includes("bandwidth.rx")
    ) ?? "network.0.bandwidth.in";
  const netTxKey =
    keys.find(
      (key) => key.includes("bandwidth.out") || key.includes("bandwidth.tx")
    ) ?? "network.0.bandwidth.out";

  const rawCpu = getValues(cpuKey);
  // Hetzner returns aggregate CPU percent across cores (can exceed 100).
  // Normalize to 0–100 host utilization when core count is known.
  result.cpu = coreCount
    ? rawCpu.map((point) => ({
        ...point,
        value: Math.min(100, Math.max(0, point.value / coreCount)),
      }))
    : [];
  result.diskRead = getValues(diskReadKey);
  result.diskWrite = getValues(diskWriteKey);
  result.networkRx = getValues(netRxKey);
  result.networkTx = getValues(netTxKey);

  // Cap series length for mobile payloads (~60 points).
  const cap = 60;
  for (const key of Object.keys(result) as Array<keyof typeof result>) {
    const seriesPoints = result[key];
    if (seriesPoints.length > cap) {
      const step = Math.ceil(seriesPoints.length / cap);
      result[key] = seriesPoints.filter((_, index) => index % step === 0).slice(
        -cap
      );
    }
  }

  const warnings: string[] = [];
  if (rawCpu.length > 0 && !coreCount) {
    warnings.push(
      "Hetzner aggregate CPU metrics were omitted because the server core count was unavailable."
    );
  }
  if (omittedSamples > 0) {
    warnings.push(
      `Hetzner metrics contained ${omittedSamples} malformed samples that were omitted.`
    );
  }
  return { metrics: result, warnings };
}

function latestOf(
  points: ServerMetricsMetricValue[]
): number | null {
  if (points.length === 0) return null;
  return points[points.length - 1]!.value;
}

function normalizeHetznerServer(payload: unknown): {
  host: Partial<ServerMetricsHostInfo> & { cpus: number | null };
  warnings: string[];
} {
  const warnings: string[] = [];
  const server = asRecord(asRecord(payload)?.server);
  if (!server) {
    return {
      host: { ...emptyHost(), cpus: null },
      warnings: ["Hetzner response did not contain a server object."],
    };
  }
  const serverTypeRecord = asRecord(server.server_type);
  const cpus = readPositiveNumber(serverTypeRecord?.cores) ?? null;
  const memoryGb = readPositiveNumber(serverTypeRecord?.memory);
  const publicNet = asRecord(server.public_net);
  const ip =
    readText(asRecord(publicNet?.ipv4)?.ip) ??
    readText(publicNet?.ipv4) ??
    null;
  const location =
    readText(asRecord(server.location)?.name) ??
    readText(asRecord(asRecord(server.datacenter)?.location)?.name) ??
    readText(asRecord(server.datacenter)?.name) ??
    null;

  return {
    host: {
      name: readText(server.name) ?? null,
      status: readText(server.status) ?? null,
      serverType: readText(serverTypeRecord?.name) ?? null,
      cpus,
      memoryTotalBytes: memoryGb
        ? memoryGb * 1024 * 1024 * 1024
        : null,
      location,
      ip,
      backupWindow: readText(server.backup_window) ?? null,
    },
    warnings,
  };
}

function normalizeCoolifyResources(
  payload: unknown,
  selfUuid: string
): { resources: ServerMetricsResource[]; warnings: string[] } {
  if (!Array.isArray(payload)) {
    return {
      resources: [],
      warnings: ["Coolify resources response was not an array."],
    };
  }
  const resources: ServerMetricsResource[] = [];
  const warnings: string[] = [];
  const max = 100;
  for (let i = 0; i < Math.min(payload.length, max); i += 1) {
    const rec = asRecord(payload[i]);
    const uuid = readText(rec?.uuid);
    const name = readText(rec?.name);
    const type = readText(rec?.type);
    const status = readText(rec?.status);
    if (!uuid || !name || !type || !status) {
      warnings.push(`Coolify resource at index ${i} was malformed and omitted.`);
      continue;
    }
    const fleetAppId = FLEET_COOLIFY_APP_UUIDS[uuid] ?? null;
    const fleetLabel =
      fleetAppId === "usage-monitor"
        ? "Usage Monitor"
        : fleetAppId === "socratic-trade"
          ? "Socratic.Trade"
          : fleetAppId === "congress-trade"
            ? "Congress.Trade"
            : null;
    resources.push({
      uuid,
      name,
      type,
      status,
      self: uuid === selfUuid,
      fleetAppId,
      fleetLabel,
    });
  }
  if (payload.length > max) {
    warnings.push(
      `Coolify returned ${payload.length} resources; only the first ${max} were processed.`
    );
  }
  return { resources, warnings };
}

function appDiskFromRuntime(): ServerMetricsPayload["appDisk"] {
  const disk = getDiskRuntimeStatus();
  let usedPct: number | null = null;
  if (
    disk.freeBytes != null &&
    disk.totalBytes != null &&
    disk.totalBytes > 0
  ) {
    usedPct = Math.max(
      0,
      Math.min(
        100,
        Math.round(((disk.totalBytes - disk.freeBytes) / disk.totalBytes) * 100)
      )
    );
  }
  return {
    freeBytes: disk.freeBytes,
    totalBytes: disk.totalBytes,
    usedPct,
    ok: disk.ok,
  };
}

async function loadRemoteMetrics(
  configuration: ReturnType<typeof readConfiguration>,
  refreshedAt: number
): Promise<{
  payload: ServerMetricsPayload;
  attempted: number;
  succeeded: number;
  hetznerMetricsFailed: boolean;
}> {
  const warnings: string[] = [];
  let attempted = 0;
  let succeeded = 0;
  let hetznerMetricsFailed = false;

  // Overlap fleet-backup listing with Hetzner/Coolify.  Sequential used to
  // push a cold `/api/server-metrics` past the iOS 20s request timeout.
  const fleetBackupsPromise = fetchFleetBackupStatus(new Date(refreshedAt)).catch(
    () => null
  );

  if (configuration.states.hetzner === "partial") {
    warnings.push(
      "Hetzner configuration is incomplete; both API token and server ID are required."
    );
  } else if (configuration.states.hetzner === "missing") {
    warnings.push("Hetzner is not configured.");
  }
  if (configuration.states.coolify === "missing") {
    warnings.push("Coolify is not configured.");
  }

  let coolifyResourcesFetch: ProviderFetchResult = {};
  if (
    configuration.states.coolify === "configured" &&
    configuration.coolifyToken
  ) {
    const headers = {
      Authorization: `Bearer ${configuration.coolifyToken}`,
      Accept: "application/json",
      "User-Agent": "Usage-Monitor infrastructure monitor",
    };
    const url = `${configuration.coolifyHost}/api/v1/servers/${encodeURIComponent(configuration.coolifyServerUuid)}/resources`;
    attempted += 1;
    coolifyResourcesFetch = await fetchProviderJson(
      "Coolify resources",
      url,
      headers
    );
    if (coolifyResourcesFetch.payload !== undefined) succeeded += 1;
  }

  let hetznerServerFetch: ProviderFetchResult = {};
  let hetznerMetricsFetch: ProviderFetchResult = {};
  if (
    configuration.states.hetzner === "configured" &&
    configuration.hetznerToken &&
    configuration.hetznerServerId
  ) {
    const headers = {
      Authorization: `Bearer ${configuration.hetznerToken}`,
      Accept: "application/json",
    };
    const serverUrl = `https://api.hetzner.cloud/v1/servers/${encodeURIComponent(configuration.hetznerServerId)}`;
    const start = new Date(refreshedAt - 60 * 60 * 1000).toISOString();
    const end = new Date(refreshedAt).toISOString();
    const metricsUrl = `${serverUrl}/metrics?type=cpu&type=disk&type=network&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
    attempted += 2;
    [hetznerServerFetch, hetznerMetricsFetch] = await Promise.all([
      fetchProviderJson("Hetzner server metadata", serverUrl, headers),
      fetchProviderJson("Hetzner metrics", metricsUrl, headers),
    ]);
    if (
      hetznerMetricsFetch.payload !== undefined &&
      !asRecord(asRecord(asRecord(hetznerMetricsFetch.payload)?.metrics)?.time_series)
    ) {
      hetznerMetricsFetch = {
        error: "Hetzner metrics returned an invalid metrics envelope.",
      };
    }
    hetznerMetricsFailed = hetznerMetricsFetch.payload === undefined;
    if (hetznerServerFetch.payload !== undefined) succeeded += 1;
    if (hetznerMetricsFetch.payload !== undefined) succeeded += 1;
  }

  for (const err of [
    coolifyResourcesFetch.error,
    hetznerServerFetch.error,
    hetznerMetricsFetch.error,
  ]) {
    if (err) warnings.push(err);
  }

  const normalizedHetzner =
    hetznerServerFetch.payload === undefined
      ? { host: { ...emptyHost(), cpus: null as number | null }, warnings: [] as string[] }
      : normalizeHetznerServer(hetznerServerFetch.payload);
  const normalizedResources =
    coolifyResourcesFetch.payload === undefined
      ? { resources: [] as ServerMetricsResource[], warnings: [] as string[] }
      : normalizeCoolifyResources(
          coolifyResourcesFetch.payload,
          configuration.coolifyAppUuid
        );

  const coreCount = normalizedHetzner.host.cpus;
  const rawTimeSeries = asRecord(
    asRecord(asRecord(hetznerMetricsFetch.payload)?.metrics)?.time_series
  );
  const parsedMetrics = parseHetznerTimeSeries(rawTimeSeries, coreCount);

  warnings.push(
    ...normalizedHetzner.warnings,
    ...normalizedResources.warnings,
    ...parsedMetrics.warnings
  );

  const host: ServerMetricsHostInfo = {
    name: normalizedHetzner.host.name ?? null,
    status: normalizedHetzner.host.status ?? null,
    serverType: normalizedHetzner.host.serverType ?? null,
    cpus: coreCount,
    memoryTotalBytes: normalizedHetzner.host.memoryTotalBytes ?? null,
    location: normalizedHetzner.host.location ?? null,
    ip: normalizedHetzner.host.ip ?? null,
    backupWindow: normalizedHetzner.host.backupWindow ?? null,
  };

  const resources = normalizedResources.resources;
  const selfResources = resources.filter((r) => r.self);

  // Fleet backup inventory (B2 + peer litestream). Independent of Hetzner/Coolify.
  let fleetBackups: FleetBackupStatusPayload | null = null;
  fleetBackups = await fleetBackupsPromise;
  if (fleetBackups == null) {
    warnings.push("Fleet backup status could not be loaded.");
  } else if (fleetBackups.warnings.length > 0) {
    warnings.push(...fleetBackups.warnings);
  }

  // Join Coolify CT uuid by name when not in the static map (volume name varies).
  for (const r of resources) {
    if (r.fleetAppId) continue;
    const lower = r.name.toLowerCase();
    if (lower.includes("congress")) {
      r.fleetAppId = "congress-trade";
      r.fleetLabel = "Congress.Trade";
    } else if (lower.includes("socratic") || lower.includes("d83b1")) {
      r.fleetAppId = "socratic-trade";
      r.fleetLabel = "Socratic.Trade";
    } else if (lower.includes("usage") || lower.includes("yagel")) {
      r.fleetAppId = "usage-monitor";
      r.fleetLabel = "Usage Monitor";
    }
  }

  const finalWarnings = uniqueStrings(warnings);
  const providerErrors = [
    coolifyResourcesFetch.error,
    hetznerServerFetch.error,
    hetznerMetricsFetch.error,
  ].filter(Boolean) as string[];

  const basePayload = {
    degraded: finalWarnings.length > 0,
    stale: false,
    cacheAgeSeconds: 0,
    configuration: configuration.states,
    host,
    hostUsage: {
      cpuPct: latestOf(parsedMetrics.metrics.cpu),
      networkRxBytesPerSec: latestOf(parsedMetrics.metrics.networkRx),
      networkTxBytesPerSec: latestOf(parsedMetrics.metrics.networkTx),
      diskReadBytesPerSec: latestOf(parsedMetrics.metrics.diskRead),
      diskWriteBytesPerSec: latestOf(parsedMetrics.metrics.diskWrite),
    },
    metrics: parsedMetrics.metrics,
    resources,
    selfResources,
    appDisk: appDiskFromRuntime(),
    fleetBackups,
    asOf: new Date(refreshedAt).toISOString(),
    ...(providerErrors.length > 0
      ? {
          error:
            "One or more infrastructure providers could not be queried.",
        }
      : {}),
    ...(finalWarnings.length > 0 ? { warnings: finalWarnings } : {}),
  };

  return {
    attempted,
    succeeded,
    hetznerMetricsFailed,
    payload: withPrevention(basePayload),
  };
}

/**
 * Fetch (or return cached) server metrics. Always resolves a payload; never
 * throws for provider failures.
 */
export async function fetchServerMetrics(): Promise<ServerMetricsPayload> {
  const configuration = readConfiguration();
  const cacheKey = [
    configuration.states.hetzner,
    configuration.hetznerServerId ?? "",
    configuration.states.coolify,
    configuration.coolifyServerUuid,
    configuration.coolifyAppUuid,
  ].join(":");
  const now = Date.now();

  if (runtime.cache?.key === cacheKey && runtime.cache.expiresAt > now) {
    return withCacheAge(runtime.cache.payload, now);
  }

  if (runtime.inFlight?.key !== cacheKey) {
    const previous =
      runtime.cache?.key === cacheKey ? runtime.cache : undefined;
    const promise = (async () => {
      const refreshedAt = Date.now();
      const result = await loadRemoteMetrics(configuration, refreshedAt);

      if (
        previous &&
        previous.discardAt > refreshedAt &&
        result.attempted > 0 &&
        result.succeeded === 0
      ) {
        const payload = withPrevention({
          ...previous.payload,
          degraded: true,
          stale: true,
          asOf: new Date(refreshedAt).toISOString(),
          error:
            "Infrastructure providers are unavailable; showing the last successful snapshot.",
          warnings: uniqueStrings([
            ...(previous.payload.warnings ?? []),
            ...(result.payload.warnings ?? []),
            "The displayed infrastructure snapshot is stale.",
          ]),
        });
        runtime.cache = {
          key: cacheKey,
          payload,
          expiresAt: refreshedAt + SERVER_METRICS_FAILURE_RETRY_MS,
          discardAt: previous.discardAt,
        };
        return withCacheAge(payload, refreshedAt);
      }

      if (
        previous &&
        previous.discardAt > refreshedAt &&
        result.hetznerMetricsFailed
      ) {
        const payload = withPrevention({
          ...result.payload,
          metrics: previous.payload.metrics,
          hostUsage: previous.payload.hostUsage,
          asOf: previous.payload.asOf,
          degraded: true,
          stale: true,
          error:
            "Hetzner metrics are unavailable; showing the last successful metric series.",
          warnings: uniqueStrings([
            ...(result.payload.warnings ?? []),
            "The displayed infrastructure metrics are stale.",
          ]),
        });
        runtime.cache = {
          key: cacheKey,
          payload,
          expiresAt: refreshedAt + SERVER_METRICS_FAILURE_RETRY_MS,
          discardAt: previous.discardAt,
        };
        return withCacheAge(payload, refreshedAt);
      }

      const ttl =
        result.attempted > 0 && result.succeeded === 0
          ? SERVER_METRICS_FAILURE_RETRY_MS
          : SERVER_METRICS_CACHE_TTL_MS;
      runtime.cache = {
        key: cacheKey,
        payload: result.payload,
        expiresAt: refreshedAt + ttl,
        discardAt: refreshedAt + SERVER_METRICS_MAX_STALE_MS,
      };
      return result.payload;
    })().finally(() => {
      if (runtime.inFlight?.promise === promise) {
        runtime.inFlight = undefined;
      }
    });
    runtime.inFlight = { key: cacheKey, promise };
  }

  return runtime.inFlight!.promise;
}
