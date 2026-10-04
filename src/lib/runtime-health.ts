import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  statfsSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import packageJson from "../../package.json";
import type { CloudflareLegacyHandoffStatus } from "@/lib/external-billing-subscription-adoption";
import { appSettings } from "@/lib/app-settings";

export interface SchedulerRunSummary {
  total: number;
  successes: number;
  failures: number;
  skipped: number;
  maintenanceHealthy: boolean;
  // Whether THIS tick's provider-fetch phase (successes/failures ratio,
  // skipped excluded) was degraded - see isProviderFetchTickDegraded in
  // usage-recorder.ts. Distinct from maintenanceHealthy: a tick can succeed
  // (maintenance healthy) while most provider polls still failed.
  providerFetchDegraded: boolean;
  cloudflareLegacyHandoff: CloudflareLegacyHandoffStatus;
}

export interface SchedulerRuntimeStatus {
  startedAt: string | null;
  tickInProgress: boolean;
  lastTickStartedAt: string | null;
  lastTickCompletedAt: string | null;
  lastTickSucceeded: boolean | null;
  consecutiveFailures: number;
  firstFailureAt: string | null;
  // Streak of consecutive ticks whose provider-fetch phase was degraded.
  // Kept separate from consecutiveFailures/lastTickSucceeded so an upstream
  // provider-fetch outage never flips lastTickSucceeded or feeds the
  // repeated_tick_failures readiness reason - see runUsagePollingSchedulerTick.
  consecutiveProviderFetchDegradedTicks: number;
  firstProviderFetchDegradedAt: string | null;
  lastRun: SchedulerRunSummary | null;
}

export interface SchedulerReadiness {
  ok: boolean;
  reason:
    | "not_started"
    | "repeated_tick_failures"
    | "tick_stalled"
    | "tick_stale"
    | "provider_fetch_degraded"
    | null;
  staleAfterMs: number;
  failureThreshold: number;
  // True once consecutiveProviderFetchDegradedTicks has reached
  // providerFetchDegradedTickThreshold. Reported independently of `reason`
  // (which only names one primary cause) so callers can see a provider-fetch
  // outage even while some other condition is the reported blocking reason.
  providerFetchDegraded: boolean;
  providerFetchDegradedTickThreshold: number;
}

const DEFAULT_SCHEDULER_STALE_AFTER_MS = 45 * 60 * 1_000;
const DEFAULT_SCHEDULER_FAILURE_THRESHOLD = 3;
// Bounded so a single flaky provider poll (one degraded tick) can't flap
// /api/ready's scheduler.readinessReason - only a sustained run of degraded
// ticks (default: 3 in a row, ~45min at the 15min poll cadence) surfaces it.
const DEFAULT_PROVIDER_FETCH_DEGRADED_TICK_THRESHOLD = 3;

function schedulerStaleAfterMs(): number {
  const configured = Number(process.env.SCHEDULER_STALE_AFTER_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_SCHEDULER_STALE_AFTER_MS;
}

function schedulerFailureThreshold(): number {
  const configured = Number(process.env.SCHEDULER_FAILURE_THRESHOLD);
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : DEFAULT_SCHEDULER_FAILURE_THRESHOLD;
}

function providerFetchDegradedTickThreshold(): number {
  const configured = Number(
    process.env.PROVIDER_FETCH_DEGRADED_TICK_THRESHOLD
  );
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : DEFAULT_PROVIDER_FETCH_DEGRADED_TICK_THRESHOLD;
}

// Identity of the SQLite file this process actually serves from: the device
// and inode the pathname resolved to at capture time, plus a read-only
// descriptor held open on that same inode so its link count stays observable
// after the pathname is gone. See getDatabaseFileStatus.
interface DatabaseFileBaseline {
  dev: number;
  ino: number;
  fd: number | null;
}

interface RuntimeHealthState {
  scheduler: SchedulerRuntimeStatus;
  databaseFile: DatabaseFileBaseline | null;
  databaseFileCache: { status: DatabaseFileStatus; expiresAtMs: number } | null;
}

const globalForRuntimeHealth = globalThis as typeof globalThis & {
  __apiUsageMonitorRuntimeHealth?: RuntimeHealthState;
};

const state =
  globalForRuntimeHealth.__apiUsageMonitorRuntimeHealth ??
  (globalForRuntimeHealth.__apiUsageMonitorRuntimeHealth = {
    scheduler: {
      startedAt: null,
      tickInProgress: false,
      lastTickStartedAt: null,
      lastTickCompletedAt: null,
      lastTickSucceeded: null,
      consecutiveFailures: 0,
      firstFailureAt: null,
      consecutiveProviderFetchDegradedTicks: 0,
      firstProviderFetchDegradedAt: null,
      lastRun: null,
    },
    databaseFile: null,
    databaseFileCache: null,
  });

function normalizeSchedulerRunSummary(
  summary: SchedulerRunSummary
): SchedulerRunSummary {
  return {
    total: summary.total,
    successes: summary.successes,
    failures: summary.failures,
    skipped: summary.skipped,
    maintenanceHealthy: summary.maintenanceHealthy,
    providerFetchDegraded: summary.providerFetchDegraded,
    cloudflareLegacyHandoff: summary.cloudflareLegacyHandoff,
  };
}

export function markSchedulerStarted(at = new Date()): void {
  state.scheduler.startedAt ??= at.toISOString();
}

export function markSchedulerTickStarted(at = new Date()): void {
  state.scheduler.tickInProgress = true;
  state.scheduler.lastTickStartedAt = at.toISOString();
}

export function markSchedulerTickCompleted(
  succeeded: boolean,
  lastRun: SchedulerRunSummary | null,
  at = new Date()
): void {
  state.scheduler.tickInProgress = false;
  state.scheduler.lastTickCompletedAt = at.toISOString();
  state.scheduler.lastTickSucceeded = succeeded;
  if (succeeded) {
    state.scheduler.consecutiveFailures = 0;
    state.scheduler.firstFailureAt = null;
  } else {
    state.scheduler.consecutiveFailures += 1;
    state.scheduler.firstFailureAt ??= at.toISOString();
  }
  // A tick with no lastRun (fetch/maintenance threw before producing a
  // summary) carries no provider-fetch signal at all, so it resets the
  // streak rather than extending or clearing it as "recovered" - there is no
  // basis to claim either.
  if (lastRun?.providerFetchDegraded) {
    state.scheduler.consecutiveProviderFetchDegradedTicks += 1;
    state.scheduler.firstProviderFetchDegradedAt ??= at.toISOString();
  } else {
    state.scheduler.consecutiveProviderFetchDegradedTicks = 0;
    state.scheduler.firstProviderFetchDegradedAt = null;
  }
  state.scheduler.lastRun = lastRun
    ? normalizeSchedulerRunSummary(lastRun)
    : null;
}

export function getSchedulerRuntimeStatus(): SchedulerRuntimeStatus {
  return {
    ...state.scheduler,
    lastRun: state.scheduler.lastRun
      ? normalizeSchedulerRunSummary(state.scheduler.lastRun)
      : null,
  };
}

export function getSchedulerReadiness(now = new Date()): SchedulerReadiness {
  const scheduler = state.scheduler;
  const staleAfterMs = schedulerStaleAfterMs();
  const failureThreshold = schedulerFailureThreshold();
  const degradedTickThreshold = providerFetchDegradedTickThreshold();
  const providerFetchDegraded =
    scheduler.consecutiveProviderFetchDegradedTicks >= degradedTickThreshold;
  if (!scheduler.startedAt) {
    return {
      ok: false,
      reason: "not_started",
      staleAfterMs,
      failureThreshold,
      providerFetchDegraded,
      providerFetchDegradedTickThreshold: degradedTickThreshold,
    };
  }
  if (
    scheduler.tickInProgress &&
    scheduler.lastTickStartedAt &&
    now.getTime() - new Date(scheduler.lastTickStartedAt).getTime() > staleAfterMs
  ) {
    return {
      ok: false,
      reason: "tick_stalled",
      staleAfterMs,
      failureThreshold,
      providerFetchDegraded,
      providerFetchDegradedTickThreshold: degradedTickThreshold,
    };
  }
  if (
    !scheduler.tickInProgress &&
    scheduler.lastTickCompletedAt &&
    now.getTime() - new Date(scheduler.lastTickCompletedAt).getTime() > staleAfterMs
  ) {
    return {
      ok: false,
      reason: "tick_stale",
      staleAfterMs,
      failureThreshold,
      providerFetchDegraded,
      providerFetchDegradedTickThreshold: degradedTickThreshold,
    };
  }
  if (scheduler.consecutiveFailures >= failureThreshold) {
    return {
      ok: false,
      reason: "repeated_tick_failures",
      staleAfterMs,
      failureThreshold,
      providerFetchDegraded,
      providerFetchDegradedTickThreshold: degradedTickThreshold,
    };
  }
  // Provider-fetch degradation never takes the service unready on its own -
  // this app is still serving correctly, the outage is upstream. It only
  // gets its own readinessReason once sustained (see
  // providerFetchDegradedTickThreshold) so a monitor reading this endpoint
  // can alert on it without the deploy being marked not-ready.
  if (providerFetchDegraded) {
    return {
      ok: true,
      reason: "provider_fetch_degraded",
      staleAfterMs,
      failureThreshold,
      providerFetchDegraded,
      providerFetchDegradedTickThreshold: degradedTickThreshold,
    };
  }
  return {
    ok: true,
    reason: null,
    staleAfterMs,
    failureThreshold,
    providerFetchDegraded,
    providerFetchDegradedTickThreshold: degradedTickThreshold,
  };
}

export function getRuntimeIdentity(): {
  service: string;
  version: string;
  revision: string | null;
  environment: string;
} {
  return {
    service: process.env.RENDER_SERVICE_NAME || "usage-monitor",
    version: packageJson.version,
    revision:
      // Coolify injects SOURCE_COMMIT per deploy. Prefer it over a stale
      // manual GIT_COMMIT_SHA (Oracle-era host env leftover) so /api/health
      // and uptime "stale vs main" match the running image tag.
      process.env.SOURCE_COMMIT ||
      process.env.RENDER_GIT_COMMIT ||
      process.env.GIT_COMMIT_SHA ||
      null,
    environment: process.env.NODE_ENV || "development",
  };
}

export interface BackupRuntimeStatus {
  required: boolean;
  active: boolean;
  /**
   * True when readiness only knows the startup env flag (`LITESTREAM_ACTIVE`),
   * not a side-channel proof that the Garage/R2 replica is advancing.
   * Monitors should not treat env-only backup as replica health (Wave C / C4).
   */
  envOnly: boolean;
  /** null = no side-channel configured; false = side-channel says unhealthy/stale. */
  replicaOk: boolean | null;
  replicaAgeSeconds: number | null;
  /**
   * True when an env-only backup claim is NOT enough to report ready — i.e. a
   * required backup must be proved by the replica side-channel. Opt out with
   * LITESTREAM_REPLICA_VERIFICATION_REQUIRED=false (disposable/rollback hosts
   * and the single deploy that installs the status-file producer), mirroring
   * the STARTUP_WRAPPER_REQUIRED escape hatch below.
   */
  verificationRequired: boolean;
  reason: string | null;
}

/**
 * Backup readiness. Prefer an optional side-channel status file written by the
 * host/Litestream/Garage monitor (`LITESTREAM_REPLICA_STATUS_PATH`) so `/api/ready`
 * does not lie when only `LITESTREAM_ACTIVE=true` is set.
 *
 * Status file formats (either):
 * - JSON: `{ "ok": true, "ageSeconds": 42, "checkedAt": "ISO" }`
 * - Heartbeat: any file whose mtime is treated as last-success; age is now-mtime.
 *
 * `LITESTREAM_REPLICA_MAX_AGE_SECONDS` (default 10800) fails the side-channel when
 * the probe/status file is older than the budget. Default is 3h so a 1h
 * Litestream `sync-interval` (R2 free-tier calm) does not flap backup health.
 */
/** Off-site Litestream destination class (public readiness labeling only). */
export type LitestreamReplicaTarget = "b2" | "r2" | "unknown";

function litestreamEndpointHostname(): string | null {
  const endpoint = (
    process.env.LITESTREAM_S3_ENDPOINT ||
    process.env.AWS_S3_ENDPOINT ||
    ""
  ).trim();
  if (!endpoint) return null;
  try {
    // Hostname-only check via URL parser (not a substring match) so path /
    // userinfo cannot spoof R2 vs B2 (CodeQL js/incomplete-url-substring-sanitization).
    const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(endpoint)
      ? endpoint
      : `https://${endpoint}`;
    return new URL(withScheme).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function litestreamEndpointIsR2(): boolean {
  const host = litestreamEndpointHostname();
  if (!host) return false;
  return (
    host === "r2.cloudflarestorage.com" ||
    host.endsWith(".r2.cloudflarestorage.com") ||
    host === "r2.cloudflare.com" ||
    host.endsWith(".r2.cloudflare.com")
  );
}

function litestreamEndpointIsB2(): boolean {
  const host = litestreamEndpointHostname();
  if (!host) return false;
  return (
    host === "backblazeb2.com" ||
    host.endsWith(".backblazeb2.com") ||
    // Native B2 S3-compatible endpoints: s3.<region>.backblazeb2.com
    /^s3\.[a-z0-9-]+\.backblazeb2\.com$/.test(host)
  );
}

export function getLitestreamReplicaTarget(): LitestreamReplicaTarget {
  if (litestreamEndpointIsB2()) return "b2";
  if (litestreamEndpointIsR2()) return "r2";
  return "unknown";
}

function r2FreeTierKillEngaged(): boolean {
  if (process.env.LITESTREAM_EMERGENCY_DISABLE === "true") return true;
  if (process.env.R2_WRITES_DISABLED === "true") return true;
  try {
    // Same path the Node free-tier monitor and start-with-litestream.sh share.
    return existsSync("/data/r2-disabled-70pct.flag");
  } catch {
    return false;
  }
}

export function getBackupRuntimeStatus(now = new Date()): BackupRuntimeStatus {
  const required = process.env.LITESTREAM_REQUIRED === "true";
  let active = process.env.LITESTREAM_ACTIVE === "true";
  // When the R2 free-tier kill switch is engaged and the replica endpoint is
  // Cloudflare R2, report backup inactive even if LITESTREAM_ACTIVE was set at
  // boot (the runtime watcher may have stopped litestream mid-cycle).
  if (active && litestreamEndpointIsR2() && r2FreeTierKillEngaged()) {
    active = false;
  }
  // LITESTREAM_ACTIVE/APP_STARTUP_WRAPPER are startup-only strings: Litestream
  // timing out against Garage for hours changes neither, so an env-only claim
  // is not evidence the replica is advancing. Fail closed by default and make
  // the side-channel mandatory wherever backup is required.
  const verificationRequired =
    process.env.LITESTREAM_REPLICA_VERIFICATION_REQUIRED !== "false";
  const statusPath = process.env.LITESTREAM_REPLICA_STATUS_PATH?.trim() || null;
  const maxAgeRaw = process.env.LITESTREAM_REPLICA_MAX_AGE_SECONDS?.trim();
  const maxAgeSeconds = maxAgeRaw
    ? Number.parseInt(maxAgeRaw, 10)
    : 10800;
  const maxAge =
    Number.isFinite(maxAgeSeconds) && maxAgeSeconds > 0 ? maxAgeSeconds : 10800;

  if (
    !active &&
    litestreamEndpointIsR2() &&
    r2FreeTierKillEngaged() &&
    process.env.LITESTREAM_ACTIVE === "true"
  ) {
    // Boot claimed active but free-tier kill stopped R2 replication.
    return {
      required,
      active: false,
      envOnly: true,
      replicaOk: false,
      replicaAgeSeconds: null,
      verificationRequired,
      reason: "r2_free_tier_disabled",
    };
  }

  if (!statusPath) {
    return {
      required,
      active,
      envOnly: true,
      replicaOk: null,
      replicaAgeSeconds: null,
      verificationRequired,
      reason: active ? "env_active_unverified" : null,
    };
  }

  try {
    if (!existsSync(statusPath)) {
      return {
        required,
        active,
        envOnly: false,
        replicaOk: false,
        replicaAgeSeconds: null,
        verificationRequired,
        reason: "replica_status_missing",
      };
    }

    const raw = readFileSync(statusPath, "utf8").trim();
    let ageSeconds: number | null = null;
    let sideOk = true;
    let probeReason: string | null = null;

    if (raw.startsWith("{")) {
      const parsed = JSON.parse(raw) as {
        ok?: unknown;
        ageSeconds?: unknown;
        checkedAt?: unknown;
        reason?: unknown;
        ltxAgeSeconds?: unknown;
      };
      if (typeof parsed.ok === "boolean") {
        sideOk = parsed.ok;
      }
      if (typeof parsed.reason === "string" && parsed.reason.trim()) {
        probeReason = parsed.reason.trim();
      }
      // Prefer explicit ageSeconds; otherwise use checkedAt. Some probes also
      // report ltxAgeSeconds (operator detail) — never use it for staleness of
      // the probe itself (a frozen ltxAge with a fresh checkedAt is fine).
      if (
        typeof parsed.ageSeconds === "number" &&
        Number.isFinite(parsed.ageSeconds) &&
        parsed.ageSeconds >= 0
      ) {
        ageSeconds = parsed.ageSeconds;
      } else if (typeof parsed.checkedAt === "string") {
        const checkedMs = Date.parse(parsed.checkedAt);
        if (Number.isFinite(checkedMs)) {
          ageSeconds = Math.max(0, (now.getTime() - checkedMs) / 1000);
        }
      }
    } else {
      const mtimeMs = statSync(statusPath).mtimeMs;
      ageSeconds = Math.max(0, (now.getTime() - mtimeMs) / 1000);
    }

    if (ageSeconds != null && ageSeconds > maxAge) {
      sideOk = false;
    }

    let reason: string | null = null;
    if (!sideOk) {
      if (ageSeconds != null && ageSeconds > maxAge) {
        reason = "replica_status_stale";
      } else if (probeReason) {
        // Pass through host probe reasons (e.g. r2_free_tier_disabled,
        // ltx_age_exceeds_budget) so Ops does not see a generic unhealthy.
        reason = probeReason;
      } else {
        reason = "replica_status_unhealthy";
      }
    }

    return {
      required,
      active,
      envOnly: false,
      replicaOk: sideOk,
      replicaAgeSeconds: ageSeconds,
      verificationRequired,
      reason,
    };
  } catch {
    return {
      required,
      active,
      envOnly: false,
      replicaOk: false,
      replicaAgeSeconds: null,
      verificationRequired,
      reason: "replica_status_unreadable",
    };
  }
}

export function getStartupRuntimeStatus(): {
  required: boolean;
  active: boolean;
  entrypoint: string | null;
} {
  const entrypoint = process.env.APP_STARTUP_WRAPPER || null;
  // The startup-wrapper requirement must hold on any host that can serve
  // production traffic. It used to key off RENDER === "true", which is never
  // set on the Oracle production host, so the check was inert there and a
  // bare `npm start` (skipping the verified pre-migration backup, safe
  // migration, and Litestream layers in scripts/start-with-litestream.sh)
  // still reported ready. Require the wrapper whenever Litestream is
  // required or the process runs as production, unless explicitly opted out
  // via STARTUP_WRAPPER_REQUIRED=false (for disposable throwaway containers
  // only - never set it on a SQLite writer).
  const required =
    process.env.LITESTREAM_REQUIRED === "true" ||
    (process.env.NODE_ENV === "production" &&
      process.env.STARTUP_WRAPPER_REQUIRED !== "false");
  return {
    required,
    active: entrypoint === "start-with-litestream-v2",
    entrypoint,
  };
}

// Aligned with the deploy preflight's MIN_DATA_FREE_BYTES in
// deploy/retired/oracle/deploy-production.sh (the retired Oracle host's
// canonical transaction) so the steady-state signal trips at the
// same headroom the next deploy would demand.
const DEFAULT_DISK_WARN_FREE_BYTES = 5 * 1024 * 1024 * 1024;

function diskWarnFreeBytes(): number {
  const configured = Number(appSettings.get("READY_DISK_WARN_FREE_BYTES"));
  return Number.isFinite(configured) && configured >= 0
    ? configured
    : DEFAULT_DISK_WARN_FREE_BYTES;
}

// The absolute path of the SQLite file DATABASE_URL names, or null when
// DATABASE_URL is absent or not a `file:` URL (dev/test against a non-SQLite
// datasource). Any `?query` suffix Prisma accepts (connection_limit, etc.) is
// stripped - see withConnectionLimit in prisma.ts.
function databaseFilePath(): string | null {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.startsWith("file:")) return null;
  const raw = url.slice("file:".length).split("?")[0];
  if (raw.length === 0) return null;
  return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
}

// The SQLite file's directory is the filesystem whose exhaustion would stop
// the writer (production: /data on its own block volume). Fall back to the
// process working directory when DATABASE_URL is absent or not a file: URL.
function databaseDirectory(): string {
  const path = databaseFilePath();
  return path ? dirname(path) : process.cwd();
}

export interface DatabaseFileStatus {
  ok: boolean;
  /**
   * False when `ok` is not a claim: DATABASE_URL names no SQLite file, or no
   * baseline identity was ever captured because the pathname has never been
   * openable in this process (mocked-prisma test environments, CI's
   * never-created test database). Identity checking begins once a baseline
   * exists - in production that is instrumentation register(), which runs
   * after the startup wrapper's restore guarantees the file is present.
   */
  checked: boolean;
  reason:
    | "database_file_unlinked"
    | "database_file_missing"
    | "database_file_replaced"
    | "database_file_stat_failed"
    | null;
  /**
   * Hard links to the inode this process has open. 0 means the live database
   * exists ONLY as this process's open descriptor - see
   * docs/runbooks/sqlite-data-loss-incident.md before restarting anything.
   */
  linkCount: number | null;
  /** Whether the DATABASE_URL pathname currently resolves at all. */
  pathPresent: boolean | null;
  /**
   * False when no startup identity could be recorded (the file was unopenable
   * at capture time). `checked` is false in that state - see above.
   */
  baselineCaptured: boolean;
  cached: boolean;
  checkedAt: string;
}

// Success TTL mirrors /api/ready's own success cache: a healthy verdict is
// reused briefly to keep the probe path cheap, while every failing verdict is
// recomputed live so recovery is visible immediately.
const DATABASE_FILE_STATUS_CACHE_TTL_MS = 5_000;

// Records the device/inode the pathname resolves to and holds a read-only
// descriptor open on that same inode. The descriptor takes no SQLite lock and
// keeps nothing alive that unlink would otherwise free; it exists purely so
// `nlink` of the inode the process serves from stays readable after the
// pathname is gone. Safe to call repeatedly - it is a no-op once captured, and
// it never throws.
export function captureDatabaseFileBaseline(): void {
  if (state.databaseFile) return;
  const path = databaseFilePath();
  if (!path) return;
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const stats = fstatSync(fd);
    state.databaseFile = { dev: stats.dev, ino: stats.ino, fd };
  } catch {
    // No baseline: the caller (register(), or the next readiness probe) will
    // retry. Until a capture succeeds, getDatabaseFileStatus reports
    // `checked:false` - identity checking cannot start against a file that
    // has never been openable in this process.
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // best effort
      }
    }
  }
}

/**
 * Whether the SQLite file this process serves from still is the file its
 * pathname names. `SELECT 1` cannot answer this: an open descriptor on an
 * unlinked inode answers it happily, and so does a descriptor whose pathname
 * has since been replaced by a different database. Three distinct failures:
 *
 * - `database_file_unlinked` - the open inode has zero links. The live data
 *   exists only as this process's descriptor; restarting destroys it.
 * - `database_file_missing`  - the pathname is gone (e.g. renamed away) while
 *   the inode this process opened still has a link somewhere else.
 * - `database_file_replaced` - the pathname now resolves to a different
 *   device/inode than the one opened at startup (silent replacement).
 *
 * Every failure verdict is relative to the baseline captured at startup. When
 * no baseline was ever captured - the pathname was never openable in this
 * process - there is nothing to compare against and no claim is made
 * (`ok:true, checked:false`), which keeps mocked-prisma test suites and CI
 * (whose DATABASE_URL file is never created) transparent to this check.
 *
 * The absolute path is deliberately never reported: /api/ready is public.
 */
export function getDatabaseFileStatus(now = new Date()): DatabaseFileStatus {
  const cached = state.databaseFileCache;
  if (cached && now.getTime() < cached.expiresAtMs) {
    return { ...cached.status, cached: true };
  }
  const checkedAt = now.toISOString();
  const path = databaseFilePath();
  if (!path) {
    return {
      ok: true,
      checked: false,
      reason: null,
      linkCount: null,
      pathPresent: null,
      baselineCaptured: false,
      cached: false,
      checkedAt,
    };
  }

  captureDatabaseFileBaseline();
  const baseline = state.databaseFile;
  if (!baseline) {
    // Never-captured baseline: the pathname has never been openable in this
    // process, so there is no identity to defend and no claim to make.
    // Deliberately not cached - every probe retries capture until the file
    // exists, at which point checking begins.
    return {
      ok: true,
      checked: false,
      reason: null,
      linkCount: null,
      pathPresent: null,
      baselineCaptured: false,
      cached: false,
      checkedAt,
    };
  }

  let linkCount: number | null = null;
  let baselineStatFailed = false;
  if (baseline.fd != null) {
    try {
      linkCount = fstatSync(baseline.fd).nlink;
    } catch {
      baselineStatFailed = true;
    }
  }

  let pathPresent: boolean;
  let pathStats: { dev: number; ino: number } | null = null;
  try {
    const stats = statSync(path);
    pathPresent = true;
    pathStats = { dev: stats.dev, ino: stats.ino };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      pathPresent = false;
    } else {
      return finalizeDatabaseFileStatus(
        {
          ok: false,
          checked: true,
          reason: "database_file_stat_failed",
          linkCount,
          pathPresent: null,
          baselineCaptured: true,
          cached: false,
          checkedAt,
        },
        now
      );
    }
  }

  // Ordered most-actionable first: an unlinked open inode is the state in
  // which a restart or redeploy permanently destroys the only remaining copy,
  // so it outranks the pathname-shaped reasons even though both are true.
  const reason: DatabaseFileStatus["reason"] =
    linkCount === 0
      ? "database_file_unlinked"
      : !pathPresent
        ? "database_file_missing"
        : baselineStatFailed
          ? "database_file_stat_failed"
          : pathStats &&
              (pathStats.dev !== baseline.dev || pathStats.ino !== baseline.ino)
            ? "database_file_replaced"
            : null;

  return finalizeDatabaseFileStatus(
    {
      ok: reason === null,
      checked: true,
      reason,
      linkCount,
      pathPresent,
      baselineCaptured: true,
      cached: false,
      checkedAt,
    },
    now
  );
}

function finalizeDatabaseFileStatus(
  status: DatabaseFileStatus,
  now: Date
): DatabaseFileStatus {
  state.databaseFileCache = status.ok
    ? {
        status,
        expiresAtMs: now.getTime() + DATABASE_FILE_STATUS_CACHE_TTL_MS,
      }
    : null;
  return status;
}

export function getDiskRuntimeStatus(): {
  ok: boolean;
  freeBytes: number | null;
  totalBytes: number | null;
  thresholdBytes: number;
  checkedAt: string;
  reason: "free_bytes_below_warn_threshold" | "disk_stat_failed" | null;
} {
  const thresholdBytes = diskWarnFreeBytes();
  const checkedAt = new Date().toISOString();
  try {
    // The absolute filesystem path is deliberately not reported: /api/ready
    // is public and only needs free/total bytes plus the threshold verdict.
    const stats = statfsSync(databaseDirectory());
    const freeBytes = stats.bavail * stats.bsize;
    const totalBytes = stats.blocks * stats.bsize;
    const ok = freeBytes >= thresholdBytes;
    return {
      ok,
      freeBytes,
      totalBytes,
      thresholdBytes,
      checkedAt,
      reason: ok ? null : "free_bytes_below_warn_threshold",
    };
  } catch {
    return {
      ok: false,
      freeBytes: null,
      totalBytes: null,
      thresholdBytes,
      checkedAt,
      reason: "disk_stat_failed",
    };
  }
}

// ---------------------------------------------------------------------------
// Layered backup observability (local pre-migration · B2 primary · R2 historic)
// ---------------------------------------------------------------------------

const PRE_MIGRATION_BACKUP_DIRECTORY = ".pre-migration-backups";
// After a successful deploy, a verified pre-migration snapshot should exist.
// Allow a multi-day window so infrequent deploys do not false-alarm; missing
// dir/files still reports honestly for a never-deployed host.
const LOCAL_BACKUP_MAX_AGE_SECONDS = 14 * 24 * 60 * 60;

export interface LocalBackupRuntimeStatus {
  ok: boolean;
  present: boolean;
  count: number;
  latestAgeSeconds: number | null;
  latestSizeBytes: number | null;
  reason:
    | "directory_missing"
    | "no_verified_backups"
    | "latest_stale"
    | "stat_failed"
    | null;
}

/**
 * Same-disk SQLite pre-migration snapshots written by
 * `scripts/backup-sqlite-before-migrate.mjs` under
 * `<db-dir>/.pre-migration-backups`. Public-safe: never reports absolute paths.
 */
export function getLocalBackupRuntimeStatus(
  now = new Date()
): LocalBackupRuntimeStatus {
  const dir = join(databaseDirectory(), PRE_MIGRATION_BACKUP_DIRECTORY);
  try {
    if (!existsSync(dir)) {
      return {
        ok: false,
        present: false,
        count: 0,
        latestAgeSeconds: null,
        latestSizeBytes: null,
        reason: "directory_missing",
      };
    }
    const entries = readdirSync(dir, { withFileTypes: true });
    let count = 0;
    let latestMtimeMs: number | null = null;
    let latestSizeBytes: number | null = null;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      // Verified promotions end in .backup.db; ignore .partial / temp.
      if (!entry.name.endsWith(".backup.db") && !entry.name.endsWith(".db")) {
        continue;
      }
      if (entry.name.endsWith(".partial") || entry.name.includes(".partial.")) {
        continue;
      }
      try {
        const st = statSync(join(dir, entry.name));
        count += 1;
        if (latestMtimeMs == null || st.mtimeMs > latestMtimeMs) {
          latestMtimeMs = st.mtimeMs;
          latestSizeBytes = st.size;
        }
      } catch {
        // skip unreadable entry
      }
    }
    if (count === 0 || latestMtimeMs == null) {
      return {
        ok: false,
        present: true,
        count: 0,
        latestAgeSeconds: null,
        latestSizeBytes: null,
        reason: "no_verified_backups",
      };
    }
    const latestAgeSeconds = Math.max(
      0,
      (now.getTime() - latestMtimeMs) / 1000
    );
    const stale = latestAgeSeconds > LOCAL_BACKUP_MAX_AGE_SECONDS;
    return {
      ok: !stale,
      present: true,
      count,
      latestAgeSeconds,
      latestSizeBytes,
      reason: stale ? "latest_stale" : null,
    };
  } catch {
    return {
      ok: false,
      present: false,
      count: 0,
      latestAgeSeconds: null,
      latestSizeBytes: null,
      reason: "stat_failed",
    };
  }
}

export interface R2HistoricBackupStatus {
  /** Credentials present for free-tier monitoring of historic R2. */
  configured: boolean;
  /**
   * Live Litestream destination is R2 (should be false in production after
   * the B2 cutover — R2 is historic freeze only).
   */
  litestreamUsesR2: boolean;
  /** Host kill-switch paused R2 writes (only meaningful when litestreamUsesR2). */
  autoDisabled: boolean;
  /**
   * Operator-facing role: `historic` when B2 is primary and R2 is retained
   * as a freeze; `active` only when Litestream still points at R2.
   */
  role: "historic" | "active" | "unconfigured";
  ok: boolean;
  reason: string | null;
  /**
   * Weekly verified snapshot written by `scripts/ops/r2-weekly-archive.mjs`.
   * Null when the job has never run on this host. A backup that silently
   * stops is the classic failure mode, so staleness is reported explicitly
   * rather than inferred from "the bucket still has objects in it".
   */
  weeklyArchive: R2WeeklyArchiveStatus | null;
}

export interface R2WeeklyArchiveStatus {
  /** Last run succeeded AND landed inside the freshness window. */
  ok: boolean;
  /** Age of the last successful archive, in seconds. */
  ageSeconds: number | null;
  /** Object key of the most recent verified archive. */
  key: string | null;
  /** How many superseded generations the last run pruned. */
  prunedCount: number | null;
  reason: string | null;
}

/**
 * Weekly cadence with slack for one missed run: 8 days. A single skipped week
 * is worth flagging, because this is the only second-vendor copy.
 */
const R2_ARCHIVE_MAX_AGE_SECONDS = 8 * 24 * 60 * 60;

export function getR2WeeklyArchiveStatus(): R2WeeklyArchiveStatus | null {
  const statusPath =
    process.env.R2_ARCHIVE_STATUS_PATH?.trim() || "/data/.r2-archive-status.json";
  try {
    if (!existsSync(statusPath)) return null;
    const parsed = JSON.parse(readFileSync(statusPath, "utf8")) as {
      ok?: unknown;
      key?: unknown;
      checkedAt?: unknown;
      completedAt?: unknown;
      prunedCount?: unknown;
      reason?: unknown;
    };

    const completedAt =
      typeof parsed.completedAt === "string" ? parsed.completedAt : null;
    const checkedAt =
      typeof parsed.checkedAt === "string" ? parsed.checkedAt : null;
    const lastSuccessMs = completedAt ? Date.parse(completedAt) : Number.NaN;
    const lastSuccessAge = Number.isFinite(lastSuccessMs)
      ? Math.max(0, Math.round((Date.now() - lastSuccessMs) / 1000))
      : null;
    const key = typeof parsed.key === "string" ? parsed.key : null;

    if (parsed.ok !== true) {
      return {
        ok: false,
        // Last successful archive only.  A failed run writes checkedAt=now
        // with no completedAt; publishing that as ageSeconds makes the UI
        // say "Lagging · 1m" as if a fresh archive existed.
        ageSeconds: lastSuccessAge,
        key,
        prunedCount: null,
        // A fixed reason code written by the archive job — never remote text.
        reason:
          typeof parsed.reason === "string" && /^[a-z_]{1,40}$/.test(parsed.reason)
            ? parsed.reason
            : "archive_failed",
      };
    }

    const stamp = completedAt || checkedAt;
    const parsedAt = stamp ? Date.parse(stamp) : Number.NaN;
    const ageSeconds = Number.isFinite(parsedAt)
      ? Math.max(0, Math.round((Date.now() - parsedAt) / 1000))
      : null;
    const stale = ageSeconds === null || ageSeconds > R2_ARCHIVE_MAX_AGE_SECONDS;
    return {
      ok: !stale,
      ageSeconds,
      key,
      prunedCount: typeof parsed.prunedCount === "number" ? parsed.prunedCount : null,
      reason: stale ? "archive_stale" : null,
    };
  } catch {
    return {
      ok: false,
      ageSeconds: null,
      key: null,
      prunedCount: null,
      reason: "archive_status_unreadable",
    };
  }
}

/** Public `/api/health` view of the weekly R2 archive — see getPublicR2WeeklyHealth. */
export interface PublicR2WeeklyHealth {
  ok: boolean;
  key: string | null;
  ageSeconds: number | null;
  /** "fresh" when ok; "stale" when a receipt exists but failed/aged out; "unknown" with no receipt at all. */
  staleness: "fresh" | "stale" | "unknown";
  reason: string | null;
}

/**
 * Fleet-standard `checks.storage.r2Weekly` shape for the unauthenticated
 * `/api/health` endpoint — mirrors Socratic.Trade and Congress.Trade so a
 * single probe (fleet-backup-status.ts's peer parser, an uptime monitor, a
 * human) reads the same fields off any app's public health path.
 *
 * `ok` requires the archive job's own `ok:true` AND `completedAt` inside the
 * 8-day freshness window (delegated entirely to getR2WeeklyArchiveStatus, the
 * same logic the session-gated operations card already relies on). A missing
 * or unreadable receipt collapses to a single `reason: "no_receipt"` — the
 * internal `archive_status_unreadable` / never-run distinction is operator
 * detail that a public unauthenticated endpoint does not need to expose.
 */
export function getPublicR2WeeklyHealth(): PublicR2WeeklyHealth {
  const status = getR2WeeklyArchiveStatus();
  if (status === null || status.reason === "archive_status_unreadable") {
    return {
      ok: false,
      key: status?.key ?? null,
      ageSeconds: status?.ageSeconds ?? null,
      staleness: "unknown",
      reason: "no_receipt",
    };
  }
  return {
    ok: status.ok,
    key: status.key,
    ageSeconds: status.ageSeconds,
    staleness: status.ok ? "fresh" : "stale",
    reason: status.reason,
  };
}

/**
 * Historic Cloudflare R2 status. Does not call Cloudflare (ready path stays
 * cheap/public); uses env + kill flag only. Full free-tier numbers remain on
 * the session-gated operations card.
 */
export function getR2HistoricBackupStatus(): R2HistoricBackupStatus {
  const account =
    process.env.R2_USAGE_ACCOUNT_ID?.trim() ||
    process.env.CLOUDFLARE_JAY_ACCOUNT_ID?.trim() ||
    process.env.CLOUDFLARE_ACCOUNT_ID?.trim() ||
    "";
  const token =
    process.env.R2_USAGE_API_TOKEN?.trim() ||
    process.env.CLOUDFLARE_JAY_API_TOKEN?.trim() ||
    process.env.CLOUDFLARE_API_TOKEN?.trim() ||
    "";
  const configured = Boolean(account && token);
  const litestreamUsesR2 = litestreamEndpointIsR2();
  const autoDisabled = r2FreeTierKillEngaged();
  const weeklyArchive = getR2WeeklyArchiveStatus();

  if (litestreamUsesR2) {
    // Still writing (or intending to write) to R2 — not the desired steady state
    // after B2 cutover, but report honestly.
    const ok = !autoDisabled;
    return {
      configured,
      litestreamUsesR2: true,
      autoDisabled,
      role: "active",
      ok,
      reason: autoDisabled
        ? "r2_free_tier_disabled"
        : configured
          ? null
          : "r2_monitor_unconfigured",
      weeklyArchive,
    };
  }

  if (!configured) {
    return {
      configured: false,
      litestreamUsesR2: false,
      autoDisabled,
      role: "unconfigured",
      ok: true, // historic freeze without monitor credentials is not an outage
      reason: "r2_monitor_unconfigured",
      weeklyArchive,
    };
  }

  // Historic R2 is only a trustworthy second copy when the weekly verified
  // archive is fresh.  A missing, failed, or stale archive is still
  // observability-only (backup layers never gate `/api/ready` ok), but the
  // layer's own `ok` must be false so Settings / iOS do not paint a green
  // check next to a freeze that has never been refreshed.
  const archiveReason =
    weeklyArchive == null
      ? "archive_not_run"
      : weeklyArchive.ok
        ? null
        : weeklyArchive.reason;
  return {
    configured: true,
    litestreamUsesR2: false,
    autoDisabled,
    role: "historic",
    ok: weeklyArchive?.ok === true,
    reason: archiveReason,
    weeklyArchive,
  };
}

/** Operator-facing copy. Phones render these so a Coolify deploy can retitle a row. */
export interface BackupLayerPresentation {
  title: string;
  detail: string | null;
}

export interface BackupLayersStatus {
  local: LocalBackupRuntimeStatus & BackupLayerPresentation;
  /** Primary off-site Litestream replica (Backblaze B2 in production). */
  primary: BackupRuntimeStatus & {
    ok: boolean;
    target: LitestreamReplicaTarget;
    label: "b2" | "r2" | "offsite";
  } & BackupLayerPresentation;
  /** Cloudflare R2 weekly archive (not the live Litestream replica). */
  r2Historic: R2HistoricBackupStatus & BackupLayerPresentation;
}

export function formatBackupAgeSeconds(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  const s = Math.round(seconds);
  if (s < 90) return `latest ${Math.max(1, s)}s ago`;
  if (s < 3600) return `latest ${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `latest ${Math.round(s / 3600)}h ago`;
  const days = Math.floor(s / 86_400);
  const hours = Math.round((s % 86_400) / 3600);
  return hours > 0 ? `latest ${days}d ${hours}h ago` : `latest ${days}d ago`;
}

export function presentLocalBackupLayer(
  local: LocalBackupRuntimeStatus
): BackupLayerPresentation {
  const parts: string[] = [];
  if (typeof local.count === "number") {
    parts.push(local.count === 1 ? "1 snapshot" : `${local.count} snapshots`);
  }
  const age = formatBackupAgeSeconds(local.latestAgeSeconds);
  if (age) parts.push(age);
  if (!local.ok && local.reason) {
    parts.push(local.reason.replace(/_/g, " "));
  }
  return { title: "Local Backup", detail: parts.length ? parts.join(" · ") : null };
}

export function presentPrimaryBackupLayer(
  primary: BackupRuntimeStatus & {
    label: "b2" | "r2" | "offsite";
    ok?: boolean;
    active?: boolean;
    envOnly?: boolean;
  }
): BackupLayerPresentation {
  const title =
    primary.label === "b2"
      ? "B2 Backup"
      : primary.label === "r2"
        ? "R2 Backup"
        : "Off-Site Backup";
  const parts: string[] = [];
  if (primary.active === false) parts.push("inactive");
  else {
    const age = formatBackupAgeSeconds(primary.replicaAgeSeconds);
    if (age) parts.push(age.replace(/^latest /, "replica "));
    else if (primary.envOnly === true) parts.push("env only");
  }
  if (primary.ok === false && primary.reason) {
    parts.push(String(primary.reason).replace(/_/g, " "));
  }
  return { title, detail: parts.length ? parts.join(" · ") : null };
}

export function presentR2HistoricLayer(
  r2: R2HistoricBackupStatus
): BackupLayerPresentation {
  const title = "R2 Weekly Archive";
  const parts: string[] = [];
  if (r2.role === "active") {
    parts.push("still primary");
    if (r2.autoDisabled) parts.push("writes paused");
  } else if (r2.role === "unconfigured") {
    parts.push("not monitored");
  } else if (r2.weeklyArchive?.ok) {
    const age = formatBackupAgeSeconds(r2.weeklyArchive.ageSeconds);
    parts.push(age ?? "verified this week");
  } else if (r2.weeklyArchive?.reason) {
    parts.push(r2.weeklyArchive.reason.replace(/_/g, " "));
  } else {
    parts.push("not run this week");
  }
  if (!r2.ok && r2.reason && !parts.includes(r2.reason.replace(/_/g, " "))) {
    parts.push(r2.reason.replace(/_/g, " "));
  }
  return { title, detail: parts.length ? parts.join(" · ") : null };
}

/**
 * Three-layer backup picture for Settings / operations UIs.
 * Does not gate readiness `ok` — same contract as `checks.backup`.
 * `title` / `detail` are the phone-facing strings; change them here, not in iOS.
 */
export function getBackupLayersStatus(now = new Date()): BackupLayersStatus {
  const primary = getBackupRuntimeStatus(now);
  const target = getLitestreamReplicaTarget();
  const primaryHealthy =
    !primary.required ||
    (primary.active &&
      primary.replicaOk !== false &&
      !(primary.envOnly && primary.verificationRequired));
  const primaryLayer = {
    ok: primaryHealthy,
    target,
    label: (target === "b2" ? "b2" : target === "r2" ? "r2" : "offsite") as
      | "b2"
      | "r2"
      | "offsite",
    ...primary,
  };
  const local = getLocalBackupRuntimeStatus(now);
  const r2Historic = getR2HistoricBackupStatus();
  return {
    local: { ...local, ...presentLocalBackupLayer(local) },
    primary: { ...primaryLayer, ...presentPrimaryBackupLayer(primaryLayer) },
    r2Historic: { ...r2Historic, ...presentR2HistoricLayer(r2Historic) },
  };
}

/** AND of the three layer `.ok` flags. Observability only — never part of ready `ok`. */
export function backupLayersGatesOk(layers: BackupLayersStatus): boolean {
  return layers.local.ok && layers.primary.ok && layers.r2Historic.ok;
}

export function resetRuntimeHealthForTests(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Runtime health state can only be reset in tests");
  }
  state.scheduler = {
    startedAt: null,
    tickInProgress: false,
    lastTickStartedAt: null,
    lastTickCompletedAt: null,
    lastTickSucceeded: null,
    consecutiveFailures: 0,
    firstFailureAt: null,
    consecutiveProviderFetchDegradedTicks: 0,
    firstProviderFetchDegradedAt: null,
    lastRun: null,
  };
  if (state.databaseFile?.fd != null) {
    try {
      closeSync(state.databaseFile.fd);
    } catch {
      // best effort - the descriptor is process-local test state
    }
  }
  state.databaseFile = null;
  state.databaseFileCache = null;
}
