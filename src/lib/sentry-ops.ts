// Sparse, trace-attached Sentry ops for THIS app.
//
// Token/cost time series stay in Usage Monitor.  Application Metrics shipped
// in Sentry in 2026, so app-health counters (`scheduler.tick`, `ingest.failed`)
// may emit there and jump to the enclosing trace.  Structured logs are the
// same split: Datadog remains the warehouse; Sentry.logger is a few health
// outcomes, not the access-log firehose.  Every call is a no-op when the SDK
// was never initialized (no DSN).
//
// fleet-infra mirror: a small subset of these signals also posts a raw
// envelope to the fleet-infra Sentry project so the shared fleet health
// channel sees UM's app-health alongside the other apps.  See
// `docs/plans/2026-09-01-sentry-fleet-integration.md` and
// `docs/observability/producer-coverage-matrix.md`.  The mirror is
// DSN-gated by SENTRY_FLEET_DSN; absent = no-op.

import { isCursorAdminPollerEnabled } from "@/lib/cursor-admin-config";

export const SENTRY_CRON_MONITOR_SLUG = "usage-monitor-scheduler";

// Cursor Admin API usage is aggregated hourly.  When the opt-in poller is
// enabled it runs from the 15-minute scheduler but only calls the API once
// an hour.  This monitor matches that poll, not the scheduler.  Check-ins
// no-op while CURSOR_ADMIN_POLLER_ENABLED is unset, so the monitor is not
// upserted for a process that left the poller off.
export const SENTRY_CURSOR_ADMIN_CRON_SLUG = "usage-monitor-cursor-admin";
export const SENTRY_CURSOR_ADMIN_CRON_INTERVAL_MINUTES = 60;
export const SENTRY_CURSOR_ADMIN_CRON_CHECKIN_MARGIN = 15;
export const SENTRY_CURSOR_ADMIN_CRON_MAX_RUNTIME = 5;

// Must match POLL_INTERVAL_MS in usage-recorder.ts (15 minutes).  The 2026-08-31
// expansion upserted this monitor as 1 minute + 5 minute margin, so a healthy
// 15-minute tick looked like a missed check-in.  Do not change the job cadence
// to appease Sentry — change the monitor to match the job.
export const SENTRY_CRON_INTERVAL_MINUTES = 15;
export const SENTRY_CRON_CHECKIN_MARGIN = 5;
export const SENTRY_CRON_MAX_RUNTIME = 10;

export function sentryCronMonitorConfig(): {
  schedule: { type: "interval"; value: number; unit: "minute" };
  checkinMargin: number;
  maxRuntime: number;
  timezone: "UTC";
} {
  return {
    schedule: {
      type: "interval",
      value: SENTRY_CRON_INTERVAL_MINUTES,
      unit: "minute",
    },
    checkinMargin: SENTRY_CRON_CHECKIN_MARGIN,
    maxRuntime: SENTRY_CRON_MAX_RUNTIME,
    timezone: "UTC",
  };
}

type SentryMod = typeof import("@sentry/nextjs") & {
  default?: typeof import("@sentry/nextjs");
};

async function loadSentry(): Promise<SentryMod | null> {
  try {
    return (await import("@sentry/nextjs")) as SentryMod;
  } catch {
    return null;
  }
}

function api<T>(mod: SentryMod, key: "captureCheckIn" | "logger" | "metrics"): T | undefined {
  return (mod[key] ?? mod.default?.[key]) as T | undefined;
}

export function sentryCursorAdminCronMonitorConfig(): {
  schedule: { type: "interval"; value: number; unit: "minute" };
  checkinMargin: number;
  maxRuntime: number;
  timezone: "UTC";
} {
  return {
    schedule: {
      type: "interval",
      value: SENTRY_CURSOR_ADMIN_CRON_INTERVAL_MINUTES,
      unit: "minute",
    },
    checkinMargin: SENTRY_CURSOR_ADMIN_CRON_CHECKIN_MARGIN,
    maxRuntime: SENTRY_CURSOR_ADMIN_CRON_MAX_RUNTIME,
    timezone: "UTC",
  };
}

export async function recordCursorAdminPollerCheckIn(
  status: "ok" | "error"
): Promise<void> {
  if (!isCursorAdminPollerEnabled()) return;
  try {
    const mod = await loadSentry();
    const captureCheckIn = mod
      ? api<typeof import("@sentry/nextjs").captureCheckIn>(mod, "captureCheckIn")
      : undefined;
    if (typeof captureCheckIn !== "function") return;
    captureCheckIn(
      { monitorSlug: SENTRY_CURSOR_ADMIN_CRON_SLUG, status },
      sentryCursorAdminCronMonitorConfig()
    );
  } catch {
    // Sentry cron check-in is best-effort and non-fatal.
  }
}

export async function recordSentryCronHeartbeat(
  status: "ok" | "error"
): Promise<void> {
  try {
    const mod = await loadSentry();
    const captureCheckIn = mod
      ? api<typeof import("@sentry/nextjs").captureCheckIn>(mod, "captureCheckIn")
      : undefined;
    if (typeof captureCheckIn !== "function") return;
    captureCheckIn(
      { monitorSlug: SENTRY_CRON_MONITOR_SLUG, status },
      sentryCronMonitorConfig()
    );
  } catch {
    // Sentry cron check-in is best-effort and non-fatal.
  }
}

export async function logSchedulerOutcome(
  status: "ok" | "error" | "disabled",
  attributes: Record<string, string | number | boolean | undefined> = {}
): Promise<void> {
  try {
    const mod = await loadSentry();
    if (!mod) return;
    const logger = api<{
      warn: (message: string, attrs?: Record<string, unknown>) => void;
      error: (message: string, attrs?: Record<string, unknown>) => void;
    }>(mod, "logger");
    const metrics = api<{
      count: (
        name: string,
        value?: number,
        options?: { attributes?: Record<string, string | number | boolean> }
      ) => void;
    }>(mod, "metrics");
    const attrs = Object.fromEntries(
      Object.entries(attributes).filter(([, value]) => value !== undefined)
    ) as Record<string, string | number | boolean>;
    if (status === "ok") {
      metrics?.count?.("scheduler.tick", 1, {
        attributes: { outcome: "ok", ...attrs },
      });
      return;
    }
    if (status === "disabled") {
      logger?.warn?.("scheduler.disabled", attrs);
      metrics?.count?.("scheduler.tick", 1, {
        attributes: { outcome: "disabled", ...attrs },
      });
      return;
    }
    logger?.error?.("scheduler.tick_failed", attrs);
    metrics?.count?.("scheduler.tick", 1, {
      attributes: { outcome: "error", ...attrs },
    });
  } catch {
    // Sparse Sentry logs/metrics are best-effort.
  }
}

export async function logSchedulerDegraded(
  attributes: Record<string, string | number | boolean | undefined>
): Promise<void> {
  try {
    const mod = await loadSentry();
    if (!mod) return;
    const logger = api<{
      warn: (message: string, attrs?: Record<string, unknown>) => void;
    }>(mod, "logger");
    const attrs = Object.fromEntries(
      Object.entries(attributes).filter(([, value]) => value !== undefined)
    ) as Record<string, string | number | boolean>;
    logger?.warn?.("scheduler.provider_fetch_degraded", attrs);
  } catch {
    // Sparse Sentry logs are best-effort.
  }
}

export async function logIngestFailed(
  attributes: Record<string, string | number | boolean | undefined>
): Promise<void> {
  try {
    const mod = await loadSentry();
    if (!mod) return;
    const logger = api<{
      warn: (message: string, attrs?: Record<string, unknown>) => void;
    }>(mod, "logger");
    const metrics = api<{
      count: (
        name: string,
        value?: number,
        options?: { attributes?: Record<string, string | number | boolean> }
      ) => void;
    }>(mod, "metrics");
    const attrs = Object.fromEntries(
      Object.entries(attributes).filter(([, value]) => value !== undefined)
    ) as Record<string, string | number | boolean>;
    logger?.warn?.("ingest.failed", attrs);
    metrics?.count?.("ingest.failed", 1, { attributes: attrs });
  } catch {
    // Sparse Sentry logs/metrics are best-effort.
  }
  // fleet-infra mirror: warn so it lands in the shared health view
  // alongside peer apps' ingest-failure signals.
  try {
    const { recordFleetInfraMetric } = await import("@/lib/sentry-fleet");
    const cleanAttrs = Object.fromEntries(
      Object.entries(attributes).filter(
        ([, value]) => value !== undefined && value !== null
      )
    ) as Record<string, string | number | boolean>;
    await recordFleetInfraMetric("ingest.failed", 1, cleanAttrs);
  } catch {
    // best-effort
  }
}

/**
 * Wave M / M1: emit a "scheduler.duration_ms" gauge for each completed
 * tick so the Sentry Metrics view shows the wall-clock time of
 * `fetchAllDueProviders` + `runUsageMaintenance`.  UM-AGENTS plan called
 * this out as the missing application metric.  No-op when the SDK was
 * never initialized or when fleet-infra is unconfigured.
 */
export async function recordSchedulerDuration(
  durationMs: number,
  attributes: Record<string, string | number | boolean | undefined> = {}
): Promise<void> {
  const safeMs = Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0;
  try {
    const mod = await loadSentry();
    if (mod) {
      const metrics = api<{
        gauge: (
          name: string,
          value: number,
          options?: { unit?: string; attributes?: Record<string, string | number | boolean> }
        ) => void;
      }>(mod, "metrics");
      const attrs = Object.fromEntries(
        Object.entries(attributes).filter(([, value]) => value !== undefined)
      ) as Record<string, string | number | boolean>;
      metrics?.gauge?.("scheduler.duration_ms", safeMs, {
        unit: "millisecond",
        attributes: attrs,
      });
    }
  } catch {
    // best-effort
  }
  try {
    const { recordFleetInfraMetric } = await import("@/lib/sentry-fleet");
    const cleanAttrs = Object.fromEntries(
      Object.entries(attributes).filter(
        ([, value]) => value !== undefined && value !== null
      )
    ) as Record<string, string | number | boolean>;
    await recordFleetInfraMetric("scheduler.duration_ms", safeMs, cleanAttrs);
  } catch {
    // best-effort
  }
}

/**
 * Wave M / M1: emit an "ingest.admission_rejected" counter every time the
 * process-global admission token in src/lib/ingest-admission.ts turns
 * away an HTTP request because the SQLite writer is busy.  This is the
 * UM-side signal of the "503 + Retry-After: 5" response that an OTLP
 * exporter sees on retry.  No-op when SDK never initialized or fleet-infra
 * unconfigured.
 */
export async function recordIngestAdmissionRejected(
  attributes: Record<string, string | number | boolean | undefined> = {}
): Promise<void> {
  try {
    const mod = await loadSentry();
    if (mod) {
      const metrics = api<{
        count: (
          name: string,
          value?: number,
          options?: { attributes?: Record<string, string | number | boolean> }
        ) => void;
      }>(mod, "metrics");
      const attrs = Object.fromEntries(
        Object.entries(attributes).filter(([, value]) => value !== undefined)
      ) as Record<string, string | number | boolean>;
      metrics?.count?.("ingest.admission_rejected", 1, { attributes: attrs });
    }
  } catch {
    // best-effort
  }
  try {
    const { recordFleetInfraMetric } = await import("@/lib/sentry-fleet");
    const cleanAttrs = Object.fromEntries(
      Object.entries(attributes).filter(
        ([, value]) => value !== undefined && value !== null
      )
    ) as Record<string, string | number | boolean>;
    await recordFleetInfraMetric("ingest.admission_rejected", 1, cleanAttrs);
  } catch {
    // best-effort
  }
}

/** Count schema-rejected v2 events without copying event ids, validation
 * detail, producer payloads, or any other billing-ledger content to Sentry. */
export async function recordIngestEventsRejected(
  count: number,
  attributes: {
    route?: "ingest/usage";
    outcome?: "all_rejected" | "partial";
  } = {}
): Promise<void> {
  const safeCount = Math.max(0, Math.floor(Number.isFinite(count) ? count : 0));
  if (safeCount === 0) return;
  try {
    const mod = await loadSentry();
    if (!mod) return;
    const metrics = api<{
      count: (
        name: string,
        value?: number,
        options?: { attributes?: Record<string, string | number | boolean> }
      ) => void;
    }>(mod, "metrics");
    const attrs: Record<string, string> = {};
    if (attributes.route) attrs.route = attributes.route;
    if (attributes.outcome) attrs.outcome = attributes.outcome;
    metrics?.count?.("ingest.events_rejected", safeCount, { attributes: attrs });
  } catch {
    // Best-effort diagnostic counter; Usage Monitor remains the ledger.
  }
}

/**
 * Wave M / M1: emit a "rollup.completed" counter per data-retention
 * batch with the count of daily rollup rows touched, so we can see
 * retention progress in the Sentry Metrics view (and the fleet-infra
 * mirror).  No-op when SDK never initialized or fleet-infra
 * unconfigured.
 */
export async function recordRollupCompleted(
  attributes: Record<string, string | number | boolean | undefined> = {}
): Promise<void> {
  try {
    const mod = await loadSentry();
    if (mod) {
      const metrics = api<{
        count: (
          name: string,
          value?: number,
          options?: { attributes?: Record<string, string | number | boolean> }
        ) => void;
      }>(mod, "metrics");
      const attrs = Object.fromEntries(
        Object.entries(attributes).filter(([, value]) => value !== undefined)
      ) as Record<string, string | number | boolean>;
      metrics?.count?.("rollup.completed", 1, { attributes: attrs });
    }
  } catch {
    // best-effort
  }
  try {
    const { recordFleetInfraMetric } = await import("@/lib/sentry-fleet");
    const cleanAttrs = Object.fromEntries(
      Object.entries(attributes).filter(
        ([, value]) => value !== undefined && value !== null
      )
    ) as Record<string, string | number | boolean>;
    await recordFleetInfraMetric("rollup.completed", 1, cleanAttrs);
  } catch {
    // best-effort
  }
}
