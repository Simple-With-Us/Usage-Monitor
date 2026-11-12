import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createRateLimiter, getClientIp } from "@/lib/rate-limit";
import {
  backupLayersGatesOk,
  getBackupLayersStatus,
  getBackupRuntimeStatus,
  getDatabaseFileStatus,
  getDiskRuntimeStatus,
  getRuntimeIdentity,
  getSchedulerReadiness,
  getSchedulerRuntimeStatus,
  getStartupRuntimeStatus,
  isSchedulerEnabled,
} from "@/lib/runtime-health";
import { getIngestAdmissionMetrics } from "@/lib/ingest-admission";
import { getDatadogReadiness } from "@/lib/datadog-options";
import { getUsageReadTokenReadiness } from "@/lib/ingest-auth";

export const dynamic = "force-dynamic";

const DATABASE_TIMEOUT_MS = 2_000;
const DATABASE_COLD_START_GRACE_MS = 5 * 60 * 1_000;
const DATABASE_FAILURE_RETRY_MS = 60 * 1_000;

// ---------------------------------------------------------------------------
// Per-IP rate limiting: max 30 requests per 60-second window.
// ---------------------------------------------------------------------------
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 30;
const readyRateLimiter = createRateLimiter(
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX_REQUESTS
);

// ---------------------------------------------------------------------------
// Short-lived success cache: avoids re-querying SQLite when identical probes
// arrive within a brief window. Only successful responses are cached; failures
// and "starting" states always run live so callers see recovery immediately.
// ---------------------------------------------------------------------------
const SUCCESS_CACHE_TTL_MS = 5_000;
let successResponseCache: { body: object; expiresAt: number } | null = null;

type DatabaseCheck = {
  ok: boolean;
  latencyMs: number;
  checkedAt: string;
  cached: boolean;
  retryAfter: string | null;
  probeInFlight: boolean;
};

type DatabaseFailureCache = Omit<DatabaseCheck, "cached" | "probeInFlight"> & {
  retryAfterMs: number;
};

// Prisma does not cancel the underlying SQLite query when Promise.race's
// timeout wins. Reusing one outstanding probe prevents repeated readiness
// requests from queueing another query every few seconds while SQLite is busy;
// caching a completed failure extends that protection across the host's
// polling interval. The tracked promise always resolves, so a late database
// failure cannot become an unhandled rejection after the HTTP response is
// returned.
let databaseProbeInFlight: Promise<DatabaseCheck> | null = null;
let databaseProbeHasSucceeded = false;
let databaseFailureCache: DatabaseFailureCache | null = null;

interface BudgetControlsReadiness {
  enabled: boolean;
  pausedProviderCount: number | null;
  keyDisableRecommendedProviderCount: number | null;
}

// Cheap, fail-safe readiness view of the budget-breach control layer. When the
// master flag is off (the default) this does ZERO database work so the hot
// readiness path is byte-identical to before this feature. When on, it runs two
// trivial provider counts and swallows any error into nulls; it never blocks or
// affects readiness `ok`.
async function budgetControlsReadiness(): Promise<BudgetControlsReadiness> {
  const raw = process.env.BUDGET_AUTO_CONTROLS_ENABLED?.trim().toLowerCase();
  const enabled = raw === "true" || raw === "1" || raw === "yes";
  if (!enabled) {
    return {
      enabled: false,
      pausedProviderCount: null,
      keyDisableRecommendedProviderCount: null,
    };
  }
  try {
    const [pausedProviderCount, keyDisableRecommendedProviderCount] =
      await Promise.all([
        prisma.provider.count({ where: { budgetPausedAt: { not: null } } }),
        prisma.provider.count({ where: { keyDisableRecommended: true } }),
      ]);
    return {
      enabled: true,
      pausedProviderCount,
      keyDisableRecommendedProviderCount,
    };
  } catch {
    return {
      enabled: true,
      pausedProviderCount: null,
      keyDisableRecommendedProviderCount: null,
    };
  }
}

function databaseProbe(): Promise<DatabaseCheck> {
  const now = Date.now();
  if (databaseFailureCache && now < databaseFailureCache.retryAfterMs) {
    return Promise.resolve({
      ok: false,
      latencyMs: databaseFailureCache.latencyMs,
      checkedAt: databaseFailureCache.checkedAt,
      cached: true,
      retryAfter: databaseFailureCache.retryAfter,
      probeInFlight: false,
    });
  }

  if (databaseProbeInFlight) return databaseProbeInFlight;

  const startedAt = Date.now();
  const query = Promise.resolve()
    .then(() =>
      prisma.$queryRawUnsafe<Array<Record<string, number>>>("SELECT 1")
    )
    .then(
      () => {
        databaseProbeHasSucceeded = true;
        databaseFailureCache = null;
        return {
          ok: true,
          latencyMs: Date.now() - startedAt,
          checkedAt: new Date().toISOString(),
          cached: false,
          retryAfter: null,
          probeInFlight: false,
        };
      },
      () => {
        const completedAt = Date.now();
        const retryAfterMs = completedAt + DATABASE_FAILURE_RETRY_MS;
        databaseFailureCache = {
          ok: false,
          latencyMs: completedAt - startedAt,
          checkedAt: new Date(completedAt).toISOString(),
          retryAfter: new Date(retryAfterMs).toISOString(),
          retryAfterMs,
        };
        return {
          ok: false,
          latencyMs: databaseFailureCache.latencyMs,
          checkedAt: databaseFailureCache.checkedAt,
          cached: false,
          retryAfter: databaseFailureCache.retryAfter,
          probeInFlight: false,
        };
      }
    );
  let tracked: Promise<DatabaseCheck>;
  tracked = query.finally(() => {
    if (databaseProbeInFlight === tracked) databaseProbeInFlight = null;
  });
  databaseProbeInFlight = tracked;
  return tracked;
}

async function checkDatabase(): Promise<DatabaseCheck> {
  const startedAt = Date.now();
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    const result = await Promise.race([
      databaseProbe(),
      new Promise<null>((resolve) => {
        timeout = setTimeout(
          () => resolve(null),
          DATABASE_TIMEOUT_MS
        );
        timeout.unref?.();
      }),
    ]);
    if (result) return result;
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString(),
      cached: false,
      retryAfter: null,
      probeInFlight: true,
    };
  } catch {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString(),
      cached: false,
      retryAfter: null,
      probeInFlight: false,
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function GET(request: Request) {
  // -----------------------------------------------------------------------
  // Per-IP rate limiting — reject excessive polling before doing any work.
  // -----------------------------------------------------------------------
  const clientIp = getClientIp(request);
  if (process.env.NODE_ENV !== "test" && !readyRateLimiter.check(clientIp)) {
    const retryAfterSeconds = Math.ceil(RATE_LIMIT_WINDOW_MS / 1_000);
    return NextResponse.json(
      {
        error: "Too Many Requests",
        retryAfterSeconds,
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(retryAfterSeconds),
        },
      }
    );
  }

  // -----------------------------------------------------------------------
  // Success cache — serve the most recent successful response for a short
  // TTL to avoid redundant SQLite probes from rapid polling.
  // -----------------------------------------------------------------------
  const strictTransport =
    new URL(request.url).searchParams.get("strict") === "1";

  if (
    process.env.NODE_ENV !== "test" &&
    successResponseCache &&
    Date.now() < successResponseCache.expiresAt
  ) {
    return NextResponse.json(successResponseCache.body, {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "X-Readiness-Status": "ready",
        "X-Response-Cached": "true",
      },
    });
  }

  // Budget-breach control observability runs inside the same Promise.all as
  // the other probes so it cannot serialize behind a stalled DB check and
  // bypass readiness timeout/cache shapes (owner review F5).
  const [
    database,
    databaseFile,
    scheduler,
    backup,
    backupLayers,
    startup,
    disk,
    budgetControls,
  ] = await Promise.all([
    checkDatabase(),
    Promise.resolve(getDatabaseFileStatus()),
    Promise.resolve(getSchedulerRuntimeStatus()),
    Promise.resolve(getBackupRuntimeStatus()),
    Promise.resolve(getBackupLayersStatus()),
    Promise.resolve(getStartupRuntimeStatus()),
    Promise.resolve(getDiskRuntimeStatus()),
    budgetControlsReadiness(),
  ]);
  const schedulerReadiness = getSchedulerReadiness();
  // A preview/cold-standby host deliberately disables its scheduler to avoid
  // becoming a second SQLite writer. That intentional circuit breaker must not
  // make strict HTTP readiness fail; production keeps the default-required
  // behavior whenever the flag is unset or true.
  // Resolved through the settings service (same as instrumentation.ts) so a
  // knob that lives only in Infisical cannot split the two answers.
  const schedulerRequired = isSchedulerEnabled();
  const schedulerReady = !schedulerRequired || schedulerReadiness.ok;
  // Backup health is honest in checks.backup, but does NOT gate overall `ok`.
  // This app's money-truth is the live SQLite on /data; R2 Litestream is
  // disaster-recovery only and free-tier kill switches / replica lag must not
  // mark the product "down" or trip uptime monitors (owner 2026-08-05).
  // Local pre-migration snapshots still run at deploy time regardless.
  const backupHealthy =
    !backup.required ||
    (backup.active &&
      backup.replicaOk !== false &&
      !(backup.envOnly && backup.verificationRequired));
  const startupReady = !startup.required || startup.active;
  const ok =
    database.ok &&
    databaseFile.ok &&
    schedulerReady &&
    startupReady;
  const databaseOnlyFailure =
    !database.ok &&
    databaseFile.ok &&
    schedulerReady &&
    startupReady;
  // A newly-started process gets a bounded window to finish opening a large
  // SQLite/Litestream database before reporting not_ready, so a dependency
  // probe cannot turn the normal open time into a restart loop. The grace
  // applies only to a database-only failure, ends after five minutes, and can
  // never reactivate after this process has completed one successful probe.
  const databaseColdStartGraceActive =
    databaseOnlyFailure &&
    !databaseProbeHasSucceeded &&
    process.uptime() * 1_000 < DATABASE_COLD_START_GRACE_MS;
  const status = ok
    ? "ready"
    : databaseColdStartGraceActive
      ? "starting"
      : "not_ready";
  // The default transport stays HTTP 200 so a host liveness probe cannot kill
  // the only SQLite process over a dependency failure and turn a temporary
  // lock into a restart loop; independent uptime monitors use `?strict=1`,
  // which is public and returns 503 whenever the dependency body says not
  // ready. It adds no extra database work because it reuses this request's
  // already-bounded probe result.

  const body = {
    ok,
    status,
    ...getRuntimeIdentity(),
    checkedAt: new Date().toISOString(),
    checks: {
      database: {
        ...database,
        coldStartGraceActive: databaseColdStartGraceActive,
      },
      // Part of `ok`, and deliberately excluded from the cold-start grace
      // above: `SELECT 1` is answered happily by a descriptor on an unlinked
      // or since-replaced inode, so file identity is the only signal that can
      // see the pathname disappear underneath a live writer. Never reports the
      // absolute path — this endpoint is public.
      databaseFile,
      scheduler: {
        ok: schedulerReady,
        required: schedulerRequired,
        readinessReason: schedulerRequired
          ? schedulerReadiness.reason
          : "disabled",
        staleAfterMs: schedulerReadiness.staleAfterMs,
        failureThreshold: schedulerReadiness.failureThreshold,
        // Provider-fetch degradation (most attempted provider polls
        // failing) never flips `ok` above - this app is still serving,
        // the outage is upstream. It's surfaced here so a monitor can
        // alert on it independently of readiness.
        providerFetchDegraded: schedulerReadiness.providerFetchDegraded,
        providerFetchDegradedTickThreshold:
          schedulerReadiness.providerFetchDegradedTickThreshold,
        ...scheduler,
      },
      // Observability only — never part of `ok` (see backupHealthy comment above).
      // gatesOverallOk is the AND of local + primary + historic layer gates so
      // Settings/iOS stop painting a hard-coded failure when every layer is green.
      backup: {
        ok: backupHealthy,
        gatesOverallOk: backupLayersGatesOk(backupLayers),
        ...backup,
      },
      // Layered backup picture for Settings/ops UIs: local pre-migration
      // snapshots, primary Litestream off-site (B2 in production), and
      // historic R2 freeze. Never gates overall ok.
      backupLayers,
      startup: {
        ok: startupReady,
        ...startup,
      },
      // Observability only — never part of `ok`. Steady-state free/total
      // bytes on the SQLite filesystem (production: the /data block volume)
      // against a warn threshold, so a monitor can alert on disk exhaustion
      // between deploys instead of only at deploy preflight.
      disk,
      // Observability only — never part of `ok`. Reports the master flag and,
      // when enabled, how many providers are currently budget-paused / carry a
      // (advisory) key-disable recommendation.
      budgetControls,
      // Observability only (Wave C / C8): process-local ingest admission
      // reject/admit counters + waiter depth. Not a readiness gate.
      admission: getIngestAdmissionMetrics(),
      // Observability only — never part of `ok`. In production a missing
      // dedicated USAGE_READ_TOKEN 503s every bearer consumer of
      // budget-status / subscriptions GET; before this, the only signal was
      // a boot-time console.warn on the host. Booleans only, no token value.
      usageReadToken: getUsageReadTokenReadiness(),
      // Observability only — never part of `ok`.  Secret-free: service /
      // site / missing key NAMES only.  Production without DD_SERVICE fails
      // closed at process boot; this block is the public view of that state.
      datadog: getDatadogReadiness(),
    },
  };

  // Cache successful responses for a short TTL to absorb rapid polling.
  if (ok) {
    successResponseCache = {
      body,
      expiresAt: Date.now() + SUCCESS_CACHE_TTL_MS,
    };
  }

  return NextResponse.json(body, {
    // Transport stays liveness-safe by default (200) even when a dependency
    // is down; `?strict=1` upgrades the same body to 503. See the comment
    // above for why a process restart on dependency failure is dangerous for
    // the sole SQLite writer.
    status: strictTransport && !ok ? 503 : 200,
    headers: {
      "Cache-Control": "no-store",
      "X-Readiness-Status": status,
    },
  });
}

if (process.env.NODE_ENV === "test") {
  (globalThis as any).resetReadinessStateForTests = () => {
    databaseProbeInFlight = null;
    databaseProbeHasSucceeded = false;
    databaseFailureCache = null;
    successResponseCache = null;
  };
}
