/**
 * Platform status registry — runs every probe and assembles the payload.
 *
 * Probes are grouped one module per category.  Each module exports a single
 * `readonly PlatformProbe[]`; this file is the only place that knows the full
 * set, and display order is registry order.
 *
 * Caching mirrors `server-metrics.ts`: a short TTL, a single in-flight promise
 * so concurrent readers share one upstream sweep, and a stale window so a
 * transient upstream failure serves the last good payload instead of nothing.
 */

import { DEVELOPER_PROBES } from "./probes/developer";
import { EDGE_PROBES } from "./probes/edge";
import { HOSTING_PROBES } from "./probes/hosting";
import { MESSAGING_PROBES } from "./probes/messaging";
import { OBSERVABILITY_PROBES } from "./probes/observability";
import { PAYMENTS_PROBES } from "./probes/payments";
import { SECRETS_PROBES } from "./probes/secrets";
import { STORAGE_PROBES } from "./probes/storage";
import {
  boundMetrics,
  boundString,
  unconfiguredResult,
  type PlatformProbe,
  type PlatformStatusCard,
  type PlatformStatusPayload,
  type PlatformStatusSummary,
} from "./types";

export const PLATFORM_STATUS_CACHE_TTL_MS = 60_000;
export const PLATFORM_STATUS_MAX_STALE_MS = 10 * 60_000;

/** Every probe, in display order. */
export const PLATFORM_PROBES: readonly PlatformProbe[] = [
  ...HOSTING_PROBES,
  ...EDGE_PROBES,
  ...STORAGE_PROBES,
  ...OBSERVABILITY_PROBES,
  ...DEVELOPER_PROBES,
  ...MESSAGING_PROBES,
  ...PAYMENTS_PROBES,
  ...SECRETS_PROBES,
];

interface CacheEntry {
  payload: PlatformStatusPayload;
  expiresAt: number;
  discardAt: number;
}

const runtime: {
  cache?: CacheEntry;
  inFlight?: Promise<PlatformStatusPayload>;
} = {};

export function resetPlatformStatusCacheForTests(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("resetPlatformStatusCacheForTests is test-only");
  }
  runtime.cache = undefined;
  runtime.inFlight = undefined;
}

/** Run one probe, converting any failure into a renderable card. */
async function runProbe(probe: PlatformProbe): Promise<PlatformStatusCard> {
  const fetchedAt = new Date().toISOString();
  const identity = {
    id: probe.id,
    name: probe.name,
    category: probe.category,
    requiredEnv: probe.requiredEnv,
    consoleUrl: probe.consoleUrl,
    fetchedAt,
  };

  let configured = false;
  try {
    configured = probe.isConfigured();
  } catch {
    configured = false;
  }

  if (!configured) {
    const result = unconfiguredResult();
    return { ...identity, configured: false, ...result };
  }

  try {
    const result = await probe.probe();
    return {
      ...identity,
      configured: true,
      state: result.state,
      headline: result.headline === null ? null : boundString(result.headline),
      metrics: boundMetrics(result.metrics),
      ...(result.error ? { error: result.error } : {}),
    };
  } catch (error) {
    // A probe that throws is a bug in that probe, not a reason to fail the
    // page.  Render it as unreachable and keep every other card.
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...identity,
      configured: true,
      state: "unreachable",
      headline: "Status check failed.",
      metrics: [],
      error: /abort|timeout|timed out/i.test(message) ? "timeout" : "probe_failed",
    };
  }
}

function summarize(platforms: PlatformStatusCard[]): PlatformStatusSummary {
  let configured = 0;
  let healthy = 0;
  let degraded = 0;
  let unconfigured = 0;
  for (const platform of platforms) {
    if (!platform.configured) {
      unconfigured += 1;
      continue;
    }
    configured += 1;
    if (platform.state === "healthy" || platform.state === "receiving") healthy += 1;
    else degraded += 1;
  }
  return { total: platforms.length, configured, healthy, degraded, unconfigured };
}

async function collect(): Promise<PlatformStatusPayload> {
  const platforms = await Promise.all(PLATFORM_PROBES.map((probe) => runProbe(probe)));
  const summary = summarize(platforms);
  return {
    platforms,
    summary,
    degraded: summary.degraded > 0,
    stale: false,
    cacheAgeSeconds: 0,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Cached platform status.  Concurrent callers share one sweep; a failed sweep
 * falls back to the last good payload within the stale window.
 */
export async function fetchPlatformStatus(): Promise<PlatformStatusPayload> {
  const now = Date.now();
  const cached = runtime.cache;

  if (cached && now < cached.expiresAt) {
    return {
      ...cached.payload,
      stale: false,
      cacheAgeSeconds: Math.max(0, Math.round((now - Date.parse(cached.payload.fetchedAt)) / 1000)),
    };
  }

  if (runtime.inFlight) return runtime.inFlight;

  const sweep = collect()
    .then((payload) => {
      runtime.cache = {
        payload,
        expiresAt: Date.now() + PLATFORM_STATUS_CACHE_TTL_MS,
        discardAt: Date.now() + PLATFORM_STATUS_MAX_STALE_MS,
      };
      return payload;
    })
    .catch((error) => {
      const fallback = runtime.cache;
      if (fallback && Date.now() < fallback.discardAt) {
        return {
          ...fallback.payload,
          stale: true,
          cacheAgeSeconds: Math.max(
            0,
            Math.round((Date.now() - Date.parse(fallback.payload.fetchedAt)) / 1000)
          ),
          warnings: ["platform_sweep_failed"],
        };
      }
      throw error;
    })
    .finally(() => {
      runtime.inFlight = undefined;
    });

  runtime.inFlight = sweep;
  return sweep;
}
