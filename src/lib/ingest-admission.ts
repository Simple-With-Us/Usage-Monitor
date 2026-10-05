import { AsyncLocalStorage } from "node:async_hooks";
import { appSettings } from "@/lib/app-settings";

interface IngestAdmissionState {
  owner: symbol | null;
  internalWaiters: Array<{
    owner: symbol;
    resolve: (release: () => void) => void;
  }>;
}

const globalForIngestAdmission = globalThis as typeof globalThis & {
  __apiUsageMonitorIngestAdmission?: IngestAdmissionState;
  __apiUsageMonitorInternalAdmissionContext?: AsyncLocalStorage<symbol>;
  __apiUsageMonitorIngestAdmissionMetrics?: IngestAdmissionMetrics;
};

const state =
  globalForIngestAdmission.__apiUsageMonitorIngestAdmission ??
  (globalForIngestAdmission.__apiUsageMonitorIngestAdmission = {
    owner: null,
    internalWaiters: [],
  });

state.internalWaiters ??= [];

const internalAdmissionContext =
  globalForIngestAdmission.__apiUsageMonitorInternalAdmissionContext ??
  (globalForIngestAdmission.__apiUsageMonitorInternalAdmissionContext =
    new AsyncLocalStorage<symbol>());

/** Process-local admission counters for ops (Wave C / C8). Not persisted. */
export interface IngestAdmissionMetrics {
  httpAdmits: number;
  httpRejects: number;
  internalAcquires: number;
  /** High-water mark of internalWaiters length observed since process start. */
  maxWaiterDepth: number;
  /** Rolling sum of HTTP lease hold times (ms) for a coarse average. */
  httpHoldMsTotal: number;
  httpHoldSamples: number;
}

const metrics: IngestAdmissionMetrics =
  globalForIngestAdmission.__apiUsageMonitorIngestAdmissionMetrics ??
  (globalForIngestAdmission.__apiUsageMonitorIngestAdmissionMetrics = {
    httpAdmits: 0,
    httpRejects: 0,
    internalAcquires: 0,
    maxWaiterDepth: 0,
    httpHoldMsTotal: 0,
    httpHoldSamples: 0,
  });

export function getIngestAdmissionMetrics(): IngestAdmissionMetrics & {
  held: boolean;
  waiterDepth: number;
  httpHoldMsAvg: number | null;
} {
  return {
    ...metrics,
    held: state.owner !== null,
    waiterDepth: state.internalWaiters.length,
    httpHoldMsAvg:
      metrics.httpHoldSamples > 0
        ? metrics.httpHoldMsTotal / metrics.httpHoldSamples
        : null,
  };
}

export function resetIngestAdmissionMetricsForTests(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Ingest admission metrics can only be reset in tests");
  }
  metrics.httpAdmits = 0;
  metrics.httpRejects = 0;
  metrics.internalAcquires = 0;
  metrics.maxWaiterDepth = 0;
  metrics.httpHoldMsTotal = 0;
  metrics.httpHoldSamples = 0;
}

export const INGEST_ADMISSION_RETRY_AFTER_SECONDS = 5;
export const OTLP_METRICS_DISABLED_RETRY_AFTER_SECONDS = 300;

/**
 * Parse common "disabled" env spellings for emergency OTLP switches.
 * Wave G / E9: honor false / 0 / off / no (case-insensitive), not only "false".
 */
function isEnvExplicitlyDisabled(configured: string | undefined): boolean {
  const normalized = configured?.trim().toLowerCase();
  return (
    normalized === "false" ||
    normalized === "0" ||
    normalized === "off" ||
    normalized === "no"
  );
}

/**
 * Emergency receiver isolation is opt-out so deployments remain backward
 * compatible until an operator explicitly disables the variable.
 */
export function isOtlpMetricsIngestEnabled(
  configured = appSettings.get("OTLP_METRICS_INGEST_ENABLED")
): boolean {
  return !isEnvExplicitlyDisabled(configured);
}

/**
 * Host system.* OTLP metrics (hardcoded provider "hetzner" in system-mapper)
 * can flood ExternalUsageEvent if every process exports host gauges.
 * Wave G / E9: opt-in only — set OTLP_SYSTEM_METRICS_INGEST_ENABLED=true to
 * persist them. When unset/false, metrics route maps but does not write rows.
 */
export function isOtlpSystemMetricsIngestEnabled(
  configured = appSettings.get("OTLP_SYSTEM_METRICS_INGEST_ENABLED")
): boolean {
  const normalized = configured?.trim().toLowerCase();
  return (
    normalized === "true" ||
    normalized === "1" ||
    normalized === "on" ||
    normalized === "yes"
  );
}

/**
 * Serialize SQLite-writing ingest work within this process. The Render
 * service has one instance and one SQLite file, so rejecting overlapping
 * writers is safer than queuing requests whose exporters may time out and
 * retry while the original write is still running.
 */
export function tryAcquireIngestAdmission(): (() => void) | null {
  if (state.owner !== null || state.internalWaiters.length > 0) {
    metrics.httpRejects += 1;
    return null;
  }

  const owner = Symbol("ingest-admission-owner");
  state.owner = owner;
  metrics.httpAdmits += 1;
  const acquiredAt = Date.now();
  const release = releaseFor(owner, acquiredAt);
  return release;
}

function releaseFor(owner: symbol, acquiredAtMs?: number): () => void {
  let released = false;

  return () => {
    if (released) return;
    released = true;
    if (state.owner !== owner) return;
    if (acquiredAtMs != null) {
      metrics.httpHoldMsTotal += Math.max(0, Date.now() - acquiredAtMs);
      metrics.httpHoldSamples += 1;
    }
    const next = state.internalWaiters.shift();
    if (!next) {
      state.owner = null;
      return;
    }
    state.owner = next.owner;
    next.resolve(releaseFor(next.owner));
  };
}

async function acquireInternalUsageWriteAdmissionLease(): Promise<{
  owner: symbol;
  release: () => void;
}> {
  const owner = Symbol("internal-usage-write-admission-owner");
  metrics.internalAcquires += 1;
  if (state.owner === null && state.internalWaiters.length === 0) {
    state.owner = owner;
    return { owner, release: releaseFor(owner) };
  }

  const release = await new Promise<() => void>((resolve) => {
    state.internalWaiters.push({ owner, resolve });
    if (state.internalWaiters.length > metrics.maxWaiterDepth) {
      metrics.maxWaiterDepth = state.internalWaiters.length;
    }
  });
  return { owner, release };
}

export async function acquireInternalUsageWriteAdmission(): Promise<() => void> {
  return (await acquireInternalUsageWriteAdmissionLease()).release;
}

export async function withInternalUsageWriteAdmission<T>(
  work: () => Promise<T>
): Promise<T> {
  const inheritedOwner = internalAdmissionContext.getStore();
  if (inheritedOwner && state.owner === inheritedOwner) {
    return work();
  }

  const { owner, release } = await acquireInternalUsageWriteAdmissionLease();
  try {
    return await internalAdmissionContext.run(owner, work);
  } finally {
    release();
  }
}
