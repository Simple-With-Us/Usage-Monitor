import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, createHmac, randomBytes } from "node:crypto";

/**
 * Cloudflare R2 free-tier monitor + automatic shutoff.
 *
 * Free tier (account-wide, resets monthly):
 *   - Storage: 10 GB-month
 *   - Class A ops: 1,000,000 / month
 *   - Class B ops: 10,000,000 / month
 *
 * Hard policy at {@link R2_THRESHOLD_PCT} (90%):
 *   - **Storage:** max(current snapshot, GB-month so far) ≥ 90% of the
 *     10 GiB free tier → stop.  Cloudflare bills GB-month, not the latest
 *     ListObjects total.  A prune that drops the live card to a few hundred
 *     MB does not erase a 20+ GiB day earlier in the month.  Month-peak
 *     alone is not the kill input (that false-killed after the 2026-08-04
 *     / 2026-08-12 prune).  No pace projection for storage.
 *   - **Class A / Class B (flows):** absolute MTD ≥ 90% **or** linear
 *     month-end pace projects ≥ 90% → stop.
 *
 * On trip we:
 *   1. Persist `/data/r2-disabled-70pct.flag` (and set env)
 *   2. Alert via Pushover (`PUSHOVER_USAGE_API_TOKEN`, then generic fallbacks)
 *   3. Stop R2-backed Litestream (startup gate + runtime watcher)
 *
 * Production fail-closed: if Litestream points at R2 and analytics credentials
 * are missing (or GraphQL fetch fails) while `LITESTREAM_REQUIRED=true` or
 * `NODE_ENV=production`, we **disable R2 writes** rather than fly blind.
 * Local SQLite size and day-of-month stubs are never used as R2 metrics.
 *
 * Required credentials (either pair):
 *   - `R2_USAGE_ACCOUNT_ID` + `R2_USAGE_API_TOKEN`, or
 *   - `CLOUDFLARE_JAY_ACCOUNT_ID` / `CLOUDFLARE_ACCOUNT_ID` +
 *     `CLOUDFLARE_JAY_API_TOKEN` / `CLOUDFLARE_API_TOKEN`
 */

export interface R2UsageLimits {
  storageBytes: number; // 10 GiB = 10 * 1024 * 1024 * 1024
  classAOps: number; // 1,000,000
  classBOps: number; // 10,000,000
}

export const DEFAULT_R2_FREE_TIER_LIMITS: R2UsageLimits = {
  storageBytes: 10 * 1024 * 1024 * 1024,
  classAOps: 1_000_000,
  classBOps: 10_000_000,
};

export const R2_THRESHOLD_PCT = 90;

// Keep this legacy filename shared with startup/runtime watchers so existing flags
// remain readable and clearR2AutoDisable() can remove them after a policy change.
export const R2_DISABLED_FLAG_FILENAME = "r2-disabled-70pct.flag";
/**
 * Durable record that auto-resume decided the kill switch should be off.
 *
 * Without this, a kill switch sourced from deploy config could never actually
 * be cleared: clearR2AutoDisable() only mutates process.env, so the resume
 * lasted exactly as long as the process, and the next restart re-injected
 * `LITESTREAM_EMERGENCY_DISABLE=true` from the environment. That is not
 * theoretical — production sat kill-switched from 2026-08-04 to 2026-08-12
 * with storage at 4.4% of the free tier, because the switch was pinned as a
 * Coolify env var and every maintenance-cycle resume was silently undone.
 *
 * Precedence, and it must match `r2_kill_active()` in
 * scripts/start-with-litestream.sh exactly:
 *   1. the disable flag FILE wins — an explicit, persisted kill
 *   2. otherwise an env-set kill applies UNLESS the auto-resume marker exists
 *   3. otherwise not killed
 * enforceR2AutoDisable() deletes this marker, so a fresh breach always
 * supersedes an older resume and the two can never both be live.
 */
export const R2_AUTO_RESUMED_FLAG_FILENAME = "r2-auto-resumed.flag";
export const R2_EMERGENCY_ALERT_FLAG_FILENAME = "r2-emergency-alert-sent.flag";
export const R2_DAILY_PUSHOVER_FILENAME = "r2-last-daily-pushover.json";

/** Official Class A action types (writes / lists). Unknown actions count as A. */
export const R2_CLASS_A_ACTIONS = new Set([
  "ListBuckets",
  "PutBucket",
  "ListObjects",
  "ListObjectsV2",
  "PutObject",
  "CopyObject",
  "CompleteMultipartUpload",
  "CreateMultipartUpload",
  "ListMultipartUploads",
  "UploadPart",
  "UploadPartCopy",
  "ListParts",
  "PutBucketEncryption",
  "PutBucketCors",
  "PutBucketLifecycleConfiguration",
  "DeleteObject",
  "DeleteObjects",
  "DeleteBucket",
  "AbortMultipartUpload",
  "PutBucketOwnershipControls",
  "PutBucketPolicy",
  "PutBucketLogging",
  "PutBucketVersioning",
  "PutBucketNotification",
  "PutBucketReplication",
  "PutBucketTagging",
  "PutBucketWebsite",
  "PutObjectLockConfiguration",
  "PutObjectRetention",
  "PutObjectLegalHold",
  "PutObjectTagging",
]);

/** Official Class B action types (reads / HEAD). */
export const R2_CLASS_B_ACTIONS = new Set([
  "HeadBucket",
  "HeadObject",
  "GetObject",
  "UsageSummary",
  "GetBucketEncryption",
  "GetBucketLocation",
  "GetBucketCors",
  "GetBucketLifecycleConfiguration",
  "GetBucketOwnershipControls",
  "GetBucketPolicy",
  "GetBucketLogging",
  "GetBucketVersioning",
  "GetBucketNotification",
  "GetBucketNotificationConfiguration",
  "GetBucketReplication",
  "GetBucketTagging",
  "GetBucketWebsite",
  "GetObjectLockConfiguration",
  "GetObjectRetention",
  "GetObjectLegalHold",
  "GetObjectTagging",
  "GetBucketSippyConfiguration",
]);

export interface R2MetricStatus {
  actual: number;
  limit: number;
  mtdPct: number;
  projected: number;
  projectedPct: number;
  onTrackToExceed: boolean;
}

export type R2MetricsSource =
  | "live_s3_storage+graphql_ops"
  | "cloudflare_graphql"
  | "r2_not_enabled"
  | "unavailable";

/** Cloudflare REST code when the account does not have the R2 product. */
export const R2_PRODUCT_DISABLED_ERROR_CODE = 10042;

/** Cache “R2 not enabled” so a fleet sweep does not ListBuckets every minute (Class A). */
export const R2_PRODUCT_STATUS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Max age of GraphQL storage samples before we refuse to kill on them (stale). */
export const R2_GRAPHQL_STORAGE_MAX_AGE_MS = 90 * 60 * 1000;

/**
 * Fresh storage samples (datetime_DESC, first win).  Keep this window short so
 * one busy bucket cannot crowd the group cap and hide idle orphans.  Account-
 * wide orphan coverage comes from `r2StorageByBucket` (bucketName only).
 */
export const R2_STORAGE_GRAPHQL_LOOKBACK_MS = 24 * 60 * 60 * 1000;
export const R2_STORAGE_GRAPHQL_GROUP_LIMIT = 400;
/** One row per bucket over the UTC month — idle orphans still bill. */
export const R2_STORAGE_GRAPHQL_BUCKET_LIMIT = 80;
/** One row per bucket per UTC date — used for GB-month and week/peak. */
export const R2_STORAGE_GRAPHQL_DAY_LIMIT = 400;
/** Rolling window for the digest "last 7 days" line. */
export const R2_PREVIOUS_WEEK_DAYS = 7;

/** Auto-resume hysteresis: clear kill switch when live storage is below this. */
export const R2_RESUME_STORAGE_PCT = 85;

/**
 * Soft tip-prune threshold: when live storage reaches this absolute share of the
 * free tier, delete non-tip LTX per level (latest max-txid kept) before the 90%
 * kill. Disaster recovery only needs the tip chain; multi-level LTX history is
 * what re-breaches free tier every day (2026-08-04 / 2026-08-06).
 */
export const R2_SOFT_PRUNE_STORAGE_PCT = 50;

/**
 * Litestream LTX object key: .../prod.db/0001/00000000-00000001.ltx
 * Groups: 1=prefix, 2=level, 3=minTx hex, 4=maxTx hex.
 * Numbered groups only (tsconfig target predates named groups).
 */
export const LTX_OBJECT_KEY_RE =
  /^(.+\/)(\d{4})\/([0-9a-fA-F]+)-([0-9a-fA-F]+)\.ltx$/;

export interface R2BucketStorageSample {
  bucketName: string;
  bytes: number;
  objectCount: number;
  asOf: string | null;
}

export interface R2UsageAssessment {
  timestamp: string;
  storage: R2MetricStatus;
  classA: R2MetricStatus;
  classB: R2MetricStatus;
  overallOnTrackToExceed70Pct: boolean;
  exceededMetric?: "storage" | "classA" | "classB";
  metricsSource: R2MetricsSource;
  metricsError?: string;
  checkpointTransitionError?: string;
  buckets?: R2BucketStorageSample[];
  litestreamUsesR2?: boolean;
  autoDisabled?: boolean;
  /** True when storage bytes came from live S3 ListObjects (not GraphQL lag). */
  storageIsLive?: boolean;
  /** True when GraphQL storage samples were too old to trust for kill decisions. */
  storageSampleStale?: boolean;
  /** Latest per-bucket snapshot (24h + live S3 overlay). */
  currentBytes?: number;
  /** Time-average of daily account totals this UTC month (Cloudflare GB-month). */
  gbMonthBytes?: number | null;
  /** Highest daily account total this UTC month. */
  monthPeakBytes?: number;
  /** UTC date (`YYYY-MM-DD`) of {@link monthPeakBytes}. */
  monthPeakDate?: string | null;
  /** Average daily total over the last {@link R2_PREVIOUS_WEEK_DAYS} UTC days. */
  previousWeekGbMonthBytes?: number | null;
  /** Highest daily total over that same rolling week. */
  previousWeekPeakBytes?: number | null;
}

export interface R2UsageCredentials {
  accountId: string;
  apiToken: string;
}

export interface FetchedR2UsageMetrics {
  /**
   * Free-tier stock used for kill / %: max(current snapshot, GB-month).
   * Never month-peak (false 15 GiB kill after prune).
   */
  storageBytes: number;
  /** Latest per-bucket snapshot (24h overlay, including empty samples). */
  currentBytes: number;
  /** Time-average of daily account totals this UTC month, or null if no daily series. */
  gbMonthBytes: number | null;
  /** Highest daily account total this UTC month (or month-window bucket max fallback). */
  monthPeakBytes: number;
  monthPeakDate: string | null;
  previousWeekGbMonthBytes: number | null;
  previousWeekPeakBytes: number | null;
  classAOps: number;
  classBOps: number;
  buckets: R2BucketStorageSample[];
  rawActionCounts: Record<string, number>;
}

let inMemoryLastDailyPushoverDate = "";
let inMemoryEmergencyAlertSent = false;
let cachedFallbackFlagDir: string | null = null;
/** Live ListObjects inventory cache (declared early for test reset). */
let liveS3ListCache: {
  atMs: number;
  value: { storageBytes: number; buckets: R2BucketStorageSample[] };
} | null = null;
let r2ProductStatusCache = new Map<
  string,
  { atMs: number; status: "enabled" | "disabled"; bucketNames: string[] | null }
>();

function getFlagDir(): string {
  // Unit tests must never observe or mutate a host's live guard files merely
  // because the test runner happens to have a /data mount. Use Vitest's own
  // marker because production-behavior tests intentionally replace NODE_ENV.
  if (process.env.VITEST !== "true" && fs.existsSync("/data")) return "/data";
  // Fallback for environments without the persistent /data volume: use a
  // private per-process directory (mkdtemp creates it 0o700 with an
  // unpredictable suffix) instead of predictable paths directly inside the
  // shared world-writable os temp dir, which are vulnerable to symlink /
  // pre-creation attacks (CodeQL js/insecure-temporary-file).
  if (!cachedFallbackFlagDir) {
    cachedFallbackFlagDir = fs.mkdtempSync(path.join(os.tmpdir(), "um-r2-"));
  }
  return cachedFallbackFlagDir;
}

function getFlagFilePath(filename: string): string {
  return path.join(getFlagDir(), filename);
}

/** Test-only: resolve where a flag file would be written. */
export function __getR2FlagFilePathForTests(filename: string): string {
  return getFlagFilePath(filename);
}

/** Test-only: clear in-memory memos and the private fallback flag directory. */
export function __resetR2UsageStateForTests(): void {
  inMemoryLastDailyPushoverDate = "";
  inMemoryEmergencyAlertSent = false;
  loggedResumeOverride = false;
  liveS3ListCache = null;
  r2ProductStatusCache = new Map();
  setR2CheckpointHandoffPending(false);
  if (cachedFallbackFlagDir) {
    try {
      fs.rmSync(cachedFallbackFlagDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
    cachedFallbackFlagDir = null;
  }
}

/**
 * True when the configured Litestream S3 endpoint is Cloudflare R2.
 * Garage / MinIO / other S3 endpoints return false so free-tier kill never
 * takes down non-R2 backup paths.
 *
 * Hostname is parsed with the URL API (not a substring match) so an attacker
 * cannot spoof "not R2" / "is R2" via path/query/userinfo tricks
 * (CodeQL js/incomplete-url-substring-sanitization).
 */
export function isLitestreamR2Endpoint(
  endpoint: string | undefined | null = process.env.LITESTREAM_S3_ENDPOINT ??
    process.env.AWS_S3_ENDPOINT
): boolean {
  if (!endpoint || typeof endpoint !== "string") return false;
  const trimmed = endpoint.trim();
  if (!trimmed) return false;
  try {
    const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
    const host = new URL(withScheme).hostname.toLowerCase();
    return (
      host === "r2.cloudflarestorage.com" ||
      host.endsWith(".r2.cloudflarestorage.com") ||
      host === "r2.cloudflare.com" ||
      host.endsWith(".r2.cloudflare.com")
    );
  } catch {
    return false;
  }
}

function r2SupervisorCanResume(): boolean {
  const supervisorPid = Number(process.env.LITESTREAM_R2_SUPERVISOR_PID);
  if (!Number.isSafeInteger(supervisorPid) || supervisorPid <= 0) return false;
  try {
    process.kill(supervisorPid, 0);
  } catch {
    return false;
  }

  return (
    process.env.APP_STARTUP_WRAPPER === "start-with-litestream-v2" &&
    process.env.LITESTREAM_R2_SUPERVISOR_ACTIVE === "true" &&
    isLitestreamR2Endpoint() &&
    Boolean(
      process.env.LITESTREAM_S3_BUCKET?.trim() &&
        process.env.LITESTREAM_S3_ENDPOINT?.trim() &&
        process.env.LITESTREAM_S3_ACCESS_KEY_ID?.trim() &&
        process.env.LITESTREAM_S3_SECRET_ACCESS_KEY?.trim()
    )
  );
}

async function setWalAutocheckpointPages(pages: 0 | 1_000): Promise<void> {
  const setWalAutocheckpoint = (globalThis as Record<string, unknown>)[
    "__apiUsageMonitorSetWalAutocheckpoint"
  ];
  if (typeof setWalAutocheckpoint !== "function") {
    throw new Error("SQLite WAL checkpoint ownership hook is unavailable");
  }
  await (setWalAutocheckpoint as (pages: 0 | 1_000) => Promise<void>)(pages);
}

async function handOffR2CheckpointToApp(): Promise<void> {
  try {
    await setWalAutocheckpointPages(1_000);
    setR2CheckpointHandoffPending(false);
  } catch (error) {
    setR2CheckpointHandoffPending(true);
    throw error;
  }
}

async function retryPendingR2CheckpointHandoff(): Promise<void> {
  if (!isR2CheckpointHandoffPending() || !r2SupervisorCanResume()) return;
  await serializeR2Transition(async () => {
    if (!isR2CheckpointHandoffPending() || !r2SupervisorCanResume()) return;
    await handOffR2CheckpointToApp();
  });
}

export function resolveR2UsageCredentials(
  env: Record<string, string | undefined> = process.env
): R2UsageCredentials | null {
  const accountId = (
    env.R2_USAGE_ACCOUNT_ID ||
    env.CLOUDFLARE_JAY_ACCOUNT_ID ||
    env.CLOUDFLARE_ACCOUNT_ID ||
    ""
  ).trim();
  const apiToken = (
    env.R2_USAGE_API_TOKEN ||
    env.CLOUDFLARE_JAY_API_TOKEN ||
    env.CLOUDFLARE_API_TOKEN ||
    ""
  ).trim();
  if (!accountId || !apiToken) return null;
  return { accountId, apiToken };
}

export function classifyR2Action(actionType: string): "A" | "B" {
  if (R2_CLASS_B_ACTIONS.has(actionType)) return "B";
  // Conservative default: treat unknowns (and explicit Class A) as Class A so
  // free-tier shutoff trips early rather than late.
  return "A";
}

export type R2ThresholdMode =
  /** Absolute MTD share only (storage stock). */
  | "absolute"
  /** Absolute MTD share OR linear month-end pace (ops flows). */
  | "absolute_or_pace";

export function calculatePaceProjection(
  actual: number,
  limit: number,
  now: Date = new Date(),
  thresholdPct: number = R2_THRESHOLD_PCT,
  mode: R2ThresholdMode = "absolute_or_pace"
): R2MetricStatus {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const startOfMonth = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
  const endOfMonth = new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999));

  const totalMs = endOfMonth.getTime() - startOfMonth.getTime();
  const elapsedMs = now.getTime() - startOfMonth.getTime();
  const elapsedFraction = Math.max(elapsedMs / totalMs, 0.02);

  const mtdPct = (actual / limit) * 100;
  const projected = actual / elapsedFraction;
  const projectedPct = (projected / limit) * 100;
  const absoluteBreach = mtdPct >= thresholdPct;
  const paceBreach = projectedPct >= thresholdPct;
  const onTrackToExceed =
    mode === "absolute" ? absoluteBreach : absoluteBreach || paceBreach;

  return {
    actual,
    limit,
    mtdPct: Number(mtdPct.toFixed(2)),
    projected: Number(projected.toFixed(2)),
    projectedPct: Number(projectedPct.toFixed(2)),
    onTrackToExceed,
  };
}

/**
 * True when production must not run R2-backed Litestream without a working
 * free-tier meter (would otherwise burn the account blind).
 */
export function r2FreeTierFailClosedRequired(
  env: Record<string, string | undefined> = process.env
): boolean {
  if (!isLitestreamR2Endpoint(env.LITESTREAM_S3_ENDPOINT ?? env.AWS_S3_ENDPOINT)) {
    return false;
  }
  return env.LITESTREAM_REQUIRED === "true" || env.NODE_ENV === "production";
}

export function assessR2Usage(
  actualStorageBytes: number,
  actualClassAOps: number,
  actualClassBOps: number,
  limits: R2UsageLimits = DEFAULT_R2_FREE_TIER_LIMITS,
  now: Date = new Date(),
  extras: {
    metricsSource?: R2MetricsSource;
    metricsError?: string;
    buckets?: R2BucketStorageSample[];
    currentBytes?: number;
    gbMonthBytes?: number | null;
    monthPeakBytes?: number;
    monthPeakDate?: string | null;
    previousWeekGbMonthBytes?: number | null;
    previousWeekPeakBytes?: number | null;
  } = {}
): R2UsageAssessment {
  // Storage: absolute 90% of free tier only (stock). Ops: absolute or pace.
  const storage = calculatePaceProjection(
    actualStorageBytes,
    limits.storageBytes,
    now,
    R2_THRESHOLD_PCT,
    "absolute"
  );
  const classA = calculatePaceProjection(
    actualClassAOps,
    limits.classAOps,
    now,
    R2_THRESHOLD_PCT,
    "absolute_or_pace"
  );
  const classB = calculatePaceProjection(
    actualClassBOps,
    limits.classBOps,
    now,
    R2_THRESHOLD_PCT,
    "absolute_or_pace"
  );

  const overallOnTrackToExceed70Pct =
    storage.onTrackToExceed || classA.onTrackToExceed || classB.onTrackToExceed;

  let exceededMetric: "storage" | "classA" | "classB" | undefined;
  if (storage.onTrackToExceed) exceededMetric = "storage";
  else if (classA.onTrackToExceed) exceededMetric = "classA";
  else if (classB.onTrackToExceed) exceededMetric = "classB";

  return {
    timestamp: now.toISOString(),
    storage,
    classA,
    classB,
    overallOnTrackToExceed70Pct,
    exceededMetric,
    metricsSource: extras.metricsSource ?? "cloudflare_graphql",
    metricsError: extras.metricsError,
    buckets: extras.buckets,
    litestreamUsesR2: isLitestreamR2Endpoint(),
    currentBytes: extras.currentBytes,
    gbMonthBytes: extras.gbMonthBytes,
    monthPeakBytes: extras.monthPeakBytes,
    monthPeakDate: extras.monthPeakDate,
    previousWeekGbMonthBytes: extras.previousWeekGbMonthBytes,
    previousWeekPeakBytes: extras.previousWeekPeakBytes,
  };
}

function flagFileExists(filename: string): boolean {
  try {
    return fs.existsSync(getFlagFilePath(filename));
  } catch {
    return false;
  }
}

/** Has auto-resume durably decided an env-pinned kill switch should be off? */
export function hasR2AutoResumeMarker(): boolean {
  return flagFileExists(R2_AUTO_RESUMED_FLAG_FILENAME);
}

let loggedResumeOverride = false;

// Transitions mutate shared process flags and checkpoint ownership across
// awaits.  Keep their effects ordered across duplicated Next module instances
// so a slow resume cannot commit after a newer kill has already engaged.
const r2TransitionLeaseKey = Symbol.for("usage-monitor.r2-transition-lease");
const r2TransitionRegistry = globalThis as typeof globalThis & Record<symbol, unknown>;
const r2CheckpointHandoffPendingKey = Symbol.for(
  "usage-monitor.r2-checkpoint-handoff-pending"
);

function isR2CheckpointHandoffPending(): boolean {
  return r2TransitionRegistry[r2CheckpointHandoffPendingKey] === true;
}

function setR2CheckpointHandoffPending(pending: boolean): void {
  r2TransitionRegistry[r2CheckpointHandoffPendingKey] = pending;
}

function serializeR2Transition<T>(operation: () => Promise<T>): Promise<T> {
  const tail = (r2TransitionRegistry[r2TransitionLeaseKey] as Promise<void> | undefined) ??
    Promise.resolve();
  const result = tail.then(operation, operation);
  r2TransitionRegistry[r2TransitionLeaseKey] = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

function writeR2AutoResumeMarkerAtomically(reason: string): void {
  const markerPath = getFlagFilePath(R2_AUTO_RESUMED_FLAG_FILENAME);
  const tempPath = `${markerPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const contents =
    `Auto-resumed at ${new Date().toISOString()}: ${reason}\n` +
    "This overrides LITESTREAM_EMERGENCY_DISABLE / R2_WRITES_DISABLED if they\n" +
    "are still set in the environment.  Delete this file to force the kill\n" +
    "switch back on; a fresh free-tier breach deletes it automatically.\n";

  try {
    fs.writeFileSync(tempPath, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    fs.renameSync(tempPath, markerPath);
  } catch (err) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Best-effort cleanup; an uncommitted temp file is never a marker.
    }
    throw err;
  }
}

export function isR2AutoDisabled(): boolean {
  // An explicit, persisted kill beats everything — including a resume marker,
  // though enforceR2AutoDisable() deletes the marker first.
  if (flagFileExists(R2_DISABLED_FLAG_FILENAME)) return true;

  const envKill =
    process.env.LITESTREAM_EMERGENCY_DISABLE === "true" ||
    process.env.R2_WRITES_DISABLED === "true";
  if (!envKill) return false;

  // See R2_AUTO_RESUMED_FLAG_FILENAME: an env-sourced kill is a default, not a
  // verdict.  Once auto-resume has confirmed usage is back under the resume
  // threshold, that decision has to survive the restart that re-injects the
  // variable — otherwise the switch can never come off without a human.
  if (hasR2AutoResumeMarker()) {
    if (!loggedResumeOverride) {
      loggedResumeOverride = true;
      console.warn(
        "[r2-usage] LITESTREAM_EMERGENCY_DISABLE/R2_WRITES_DISABLED is set in this " +
          "environment, but a recorded auto-resume overrides it. Remove those " +
          "variables from deploy config — they are stale. To force the kill switch " +
          `back on, delete ${R2_AUTO_RESUMED_FLAG_FILENAME} (a fresh breach also ` +
          "clears it automatically)."
      );
    }
    return false;
  }
  return true;
}

/**
 * Persist the free-tier kill switch. Sets env so in-process readers see it
 * immediately; writes the flag so start-with-litestream.sh and a runtime
 * watcher stop R2-backed Litestream without needing a redeploy.
 */
/** Clear free-tier kill switch so litestream can resume after prune/restart. */
export async function clearR2AutoDisable(
  reason = "usage back under the resume threshold"
): Promise<void> {
  return serializeR2Transition(() => clearR2AutoDisableSerialized(reason));
}

async function clearR2AutoDisableSerialized(reason: string): Promise<void> {
  const r2Target = isLitestreamR2Endpoint();
  if (r2Target && !isR2AutoDisabled()) return;
  const canResumeSupervisor = r2Target && r2SupervisorCanResume();
  if (r2Target) {
    process.env.LITESTREAM_ACTIVE = "false";
    if (canResumeSupervisor) {
      // The supervisor must keep Litestream stopped until SQLite has given
      // checkpoint ownership back to the replicator.
      await setWalAutocheckpointPages(0);
      setR2CheckpointHandoffPending(false);
    }
  }
  // Persist the decision. Mutating process.env alone made this a no-op across
  // restarts whenever the switch came from deploy config — see the constant's
  // doc comment for the production incident that caused.
  try {
    // Publish a complete marker while the old kill flag remains authoritative;
    // removing that flag below commits the prepared resume.
    writeR2AutoResumeMarkerAtomically(reason);
  } catch (err) {
    if (canResumeSupervisor) {
      await handOffR2CheckpointToApp().catch((rollbackError) => {
        console.error("[r2-usage] Failed restoring SQLite checkpoint policy after resume-marker failure:", rollbackError);
      });
    }
    throw new Error("Failed writing R2 auto-resume marker", { cause: err });
  }
  try {
    const flag = getFlagFilePath(R2_DISABLED_FLAG_FILENAME);
    if (fs.existsSync(flag)) fs.unlinkSync(flag);
  } catch (err) {
    // Removing the old kill flag is the commit point.  Until it succeeds, the
    // flag wins over this marker, so roll checkpoints back and keep R2 inactive.
    try {
      const marker = getFlagFilePath(R2_AUTO_RESUMED_FLAG_FILENAME);
      if (fs.existsSync(marker)) fs.unlinkSync(marker);
    } catch (cleanupError) {
      console.error("[r2-usage] Failed cleaning uncommitted auto-resume marker:", cleanupError);
    }
    if (canResumeSupervisor) {
      await handOffR2CheckpointToApp().catch((rollbackError) => {
        console.error("[r2-usage] Failed restoring SQLite checkpoint policy after kill-flag failure:", rollbackError);
      });
    }
    throw new Error("Failed clearing R2 emergency disable flag", { cause: err });
  }
  delete process.env.LITESTREAM_EMERGENCY_DISABLE;
  delete process.env.R2_WRITES_DISABLED;
  process.env.LITESTREAM_EMERGENCY_DISABLE = "false";
  process.env.R2_WRITES_DISABLED = "false";
  if (r2Target) process.env.LITESTREAM_ACTIVE = canResumeSupervisor ? "true" : "false";
  loggedResumeOverride = false;
  try {
    const alert = getFlagFilePath(R2_EMERGENCY_ALERT_FLAG_FILENAME);
    if (fs.existsSync(alert)) fs.unlinkSync(alert);
  } catch {
    // best-effort
  }
  inMemoryEmergencyAlertSent = false;
}

export async function enforceR2AutoDisable(reason: string): Promise<void> {
  return serializeR2Transition(() => enforceR2AutoDisableSerialized(reason));
}

async function enforceR2AutoDisableSerialized(reason: string): Promise<void> {
  const r2Target = isLitestreamR2Endpoint();
  let checkpointHandoffError: unknown;
  process.env.LITESTREAM_EMERGENCY_DISABLE = "true";
  process.env.R2_WRITES_DISABLED = "true";
  // A fresh breach supersedes any earlier auto-resume, so drop the marker
  // before writing the kill flag — the two must never both be live.
  try {
    const resumed = getFlagFilePath(R2_AUTO_RESUMED_FLAG_FILENAME);
    if (fs.existsSync(resumed)) fs.unlinkSync(resumed);
  } catch (err) {
    console.error("[r2-usage] Failed clearing auto-resume marker:", err);
  }
  if (
    r2Target &&
    r2SupervisorCanResume() &&
    (process.env.LITESTREAM_ACTIVE === "true" || isR2CheckpointHandoffPending())
  ) {
    try {
      await handOffR2CheckpointToApp();
    } catch (err) {
      checkpointHandoffError = err;
    }
  }
  // Keep B2 and unknown targets active; the R2 archival kill is independent
  // of the primary replica destination.
  if (r2Target) process.env.LITESTREAM_ACTIVE = "false";
  try {
    const filePath = getFlagFilePath(R2_DISABLED_FLAG_FILENAME);
    fs.writeFileSync(
      filePath,
      `Disabled at ${new Date().toISOString()}: ${reason}\n` +
        `Resume: delete this file and clear LITESTREAM_EMERGENCY_DISABLE / R2_WRITES_DISABLED, then restart the container.\n`,
      { encoding: "utf8", mode: 0o600 }
    );
  } catch (err) {
    console.error("[r2-usage] Failed writing emergency disable flag file:", err);
  }
  console.error(
    `[r2-usage] R2 free-tier auto-disable engaged: ${reason}` +
      (isLitestreamR2Endpoint()
        ? " (Litestream endpoint is R2 — replication will stop)"
        : " (R2 archival writes disabled; non-R2 replica left running)")
  );
  if (checkpointHandoffError) {
    const errorName =
      checkpointHandoffError instanceof Error
        ? checkpointHandoffError.name.slice(0, 48)
        : "unknown";
    console.error(
      `[r2-usage] R2 kill persisted but SQLite checkpoint handoff failed (error=${errorName})`
    );
    throw new Error("R2 kill persisted but SQLite checkpoint handoff failed", {
      cause: checkpointHandoffError,
    });
  }
}



/** This process's product identity for Pushover footers. */
export const R2_SENDER_APP_LABEL = "Usage Monitor";

/**
 * Append `(sent from APP)` only when the subject logo is not this product
 * (owner: footer is noise when UM messages under the UM Pushover token).
 */
export function appendSentFromFooter(
  body: string,
  subject: "um" | "st" | "ct" = "um",
  sender: "um" | "st" | "ct" = "um",
  senderLabel: string = R2_SENDER_APP_LABEL
): string {
  const trimmed = body.replace(/\s+$/u, "");
  if (subject === sender) return trimmed;
  const footer = `(sent from ${senderLabel})`;
  if (trimmed.endsWith(footer)) return trimmed;
  return `${trimmed}\n${footer}`;
}

/**
 * Pushover application token for a SUBJECT free-tier account (logo on phone).
 * When this host messages about ST/CT free tiers, use their tokens; for own
 * free tier prefer PUSHOVER_USAGE_API_TOKEN.
 */
export function resolveSubjectPushoverAppToken(
  subject: "um" | "st" | "ct" = "um"
): string {
  const primary: Record<"um" | "st" | "ct", string[]> = {
    um: ["PUSHOVER_USAGE_API_TOKEN", "PUSHOVER_UM_API_TOKEN", "PUSHOVER_API_TOKEN"],
    st: ["PUSHOVER_ST_API_TOKEN"],
    ct: ["PUSHOVER_CT_API_TOKEN"],
  };
  for (const key of primary[subject]) {
    const v = process.env[key]?.trim();
    if (v) return v;
  }
  // Fallbacks: generic host tokens last (may wrong-logo).
  return (
    process.env.PUSHOVER_APP_TOKEN?.trim() ||
    process.env.PUSHOVER_USAGE_API_TOKEN?.trim() ||
    process.env.PUSHOVER_ST_API_TOKEN?.trim() ||
    process.env.PUSHOVER_CT_API_TOKEN?.trim() ||
    ""
  );
}

/** Own backup line: shallow R2 + Hetzner ~24h volume floor. */
export function formatOwnBackupRegimenLine(input: {
  killEngaged: boolean;
  litestreamUsesR2?: boolean;
}): string {
  if (input.killEngaged) {
    return "Backup: R2 litestream paused (free-tier kill). Hetzner volume snapshots remain the ~24h PITR floor.";
  }
  if (input.litestreamUsesR2 === false) {
    return "Backup: Litestream endpoint is not R2 — confirm host backup path. Hetzner ~24h floor still applies.";
  }
  return "Backup: own litestream→R2 (1h/24h policy) + Hetzner ~24h volume floor.";
}

export async function sendPushoverNotification(
  title: string,
  message: string,
  priority: number = 0,
  fetchImpl: typeof fetch = fetch,
  opts?: { subject?: "um" | "st" | "ct" }
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const userKey = process.env.PUSHOVER_USER_KEY;
  // Prefer the SUBJECT product's app token so R2 free-tier alerts show that
  // product's logo (own free tier → Usage Monitor token).
  const subject = opts?.subject ?? "um";
  const apiToken = resolveSubjectPushoverAppToken(subject);
  // Footer only when speaking under another product's logo (e.g. ST/CT subject).
  const body = appendSentFromFooter(message, subject, "um", R2_SENDER_APP_LABEL);

  if (!userKey || !apiToken) {
    return {
      ok: false,
      error:
        "Pushover credentials not configured (need PUSHOVER_USER_KEY + PUSHOVER_USAGE_API_TOKEN or PUSHOVER_API_TOKEN)",
    };
  }

  const form = new URLSearchParams({
    token: apiToken,
    user: userKey,
    title,
    message: body,
    priority: String(priority),
  });

  try {
    const res = await fetchImpl("https://api.pushover.net/1/messages.json", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    if (res.ok) {
      return { ok: true, status: res.status };
    }
    const errText = await res.text().catch(() => "");
    return {
      ok: false,
      status: res.status,
      error: `HTTP ${res.status}: ${errText.slice(0, 200)}`,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function getLastDailyPushoverDate(): string {
  if (inMemoryLastDailyPushoverDate) return inMemoryLastDailyPushoverDate;
  try {
    const filePath = getFlagFilePath(R2_DAILY_PUSHOVER_FILENAME);
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (typeof data?.date === "string") {
        inMemoryLastDailyPushoverDate = data.date;
        return data.date;
      }
    }
  } catch {
    // fall through
  }
  return "";
}

export function recordDailyPushoverSent(dateStr: string): void {
  inMemoryLastDailyPushoverDate = dateStr;
  try {
    const filePath = getFlagFilePath(R2_DAILY_PUSHOVER_FILENAME);
    fs.writeFileSync(
      filePath,
      JSON.stringify({ date: dateStr, sentAt: new Date().toISOString() }),
      { encoding: "utf8", mode: 0o600 }
    );
  } catch (err) {
    console.error("[r2-usage] Failed saving last daily pushover file:", err);
  }
}

export function formatDailyPushoverMessage(
  assessment: R2UsageAssessment,
  disabled: boolean
): { title: string; body: string } {
  const storageGIB = (assessment.storage.actual / (1024 * 1024 * 1024)).toFixed(
    2
  );
  const formatGiBLine = (bytes: number): string =>
    `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
  const title = "📊 Cloudflare R2 Free Tier Status";

  const statusStr = disabled
    ? `🛑 DISABLED (Auto-killed at ${R2_THRESHOLD_PCT}% threshold)`
    : assessment.metricsSource === "unavailable"
      ? "❓ METRICS UNAVAILABLE (no auto-disable)"
      : assessment.overallOnTrackToExceed70Pct
        ? `⚠️ WARNING (Pace/MTD >= ${R2_THRESHOLD_PCT}%)`
        : `✅ OK (Under ${R2_THRESHOLD_PCT}% free-tier pace)`;

  const topBuckets = (assessment.buckets ?? [])
    .slice()
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 3)
    .map(
      (b) =>
        `  ${b.bucketName}: ${(b.bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`
    );

  const body = [
    `Usage Monitor account (UM Cloudflare free tier):`,
    `R2 Storage: ${storageGIB} GiB / 10.00 GiB (${assessment.storage.mtdPct}% MTD, ${assessment.storage.projectedPct}% proj)`,
    assessment.currentBytes != null &&
    assessment.currentBytes !== assessment.storage.actual
      ? `  current snapshot: ${formatGiBLine(assessment.currentBytes)}`
      : null,
    assessment.monthPeakBytes != null &&
    assessment.monthPeakBytes > assessment.storage.actual
      ? `  month peak: ${formatGiBLine(assessment.monthPeakBytes)}${
          assessment.monthPeakDate ? ` (${assessment.monthPeakDate})` : ""
        }`
      : null,
    assessment.previousWeekGbMonthBytes != null
      ? `  last 7 days: ${formatGiBLine(assessment.previousWeekGbMonthBytes)} avg${
          assessment.previousWeekPeakBytes != null
            ? ` (peak ${formatGiBLine(assessment.previousWeekPeakBytes)})`
            : ""
        }`
      : null,
    `Class A Ops: ${assessment.classA.actual.toLocaleString()} / 1,000,000 (${assessment.classA.mtdPct}% MTD, ${assessment.classA.projectedPct}% proj)`,
    `Class B Ops: ${assessment.classB.actual.toLocaleString()} / 10,000,000 (${assessment.classB.mtdPct}% MTD, ${assessment.classB.projectedPct}% proj)`,
    `Threshold: ${R2_THRESHOLD_PCT}% max pace/MTD`,
    `Source: ${assessment.metricsSource}`,
    `Litestream→R2: ${assessment.litestreamUsesR2 ? "yes" : "no"}`,
    topBuckets.length ? `Top buckets:\n${topBuckets.join("\n")}` : null,
    `Status: ${statusStr}`,
    formatOwnBackupRegimenLine({
      killEngaged: disabled,
      litestreamUsesR2: assessment.litestreamUsesR2,
    }),
  ]
    .filter(Boolean)
    .join("\n");

  // Footer is applied at send time only when subject ≠ Usage Monitor.
  return { title, body };
}

export function isR2EmergencyAlertSent(): boolean {
  if (inMemoryEmergencyAlertSent) return true;
  try {
    return fs.existsSync(getFlagFilePath(R2_EMERGENCY_ALERT_FLAG_FILENAME));
  } catch {
    return false;
  }
}

export function recordR2EmergencyAlertSent(): void {
  inMemoryEmergencyAlertSent = true;
  try {
    const filePath = getFlagFilePath(R2_EMERGENCY_ALERT_FLAG_FILENAME);
    fs.writeFileSync(filePath, `Sent at ${new Date().toISOString()}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch (err) {
    console.error("[r2-usage] Failed saving emergency alert sent flag:", err);
  }
}

const R2_USAGE_GRAPHQL_QUERY = `
query R2FreeTierUsage(
  $accountTag: string!
  $startDate: Time
  $endDate: Time
  $storageStartDate: Time
) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      r2OperationsAdaptiveGroups(
        limit: 10000
        filter: { datetime_geq: $startDate, datetime_leq: $endDate }
      ) {
        sum { requests }
        dimensions { actionType }
      }
      r2StorageAdaptiveGroups(
        limit: ${R2_STORAGE_GRAPHQL_GROUP_LIMIT}
        filter: { datetime_geq: $storageStartDate, datetime_leq: $endDate }
        orderBy: [datetime_DESC]
      ) {
        max {
          objectCount
          uploadCount
          payloadSize
          metadataSize
        }
        dimensions {
          datetime
          bucketName
        }
      }
      r2StorageByBucket: r2StorageAdaptiveGroups(
        limit: ${R2_STORAGE_GRAPHQL_BUCKET_LIMIT}
        filter: { datetime_geq: $startDate, datetime_leq: $endDate }
      ) {
        max {
          objectCount
          uploadCount
          payloadSize
          metadataSize
        }
        dimensions {
          bucketName
        }
      }
      r2StorageByDay: r2StorageAdaptiveGroups(
        limit: ${R2_STORAGE_GRAPHQL_DAY_LIMIT}
        filter: { datetime_geq: $startDate, datetime_leq: $endDate }
      ) {
        max {
          objectCount
          uploadCount
          payloadSize
          metadataSize
        }
        dimensions {
          date
          bucketName
        }
      }
    }
  }
}
`;

function utcMonthStartIso(now: Date): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0)
  ).toISOString();
}

/** Fresh-sample window start (`now − lookback`).  Month coverage is a separate group. */
export function utcStorageLookbackIso(now: Date): string {
  return new Date(now.getTime() - R2_STORAGE_GRAPHQL_LOOKBACK_MS).toISOString();
}

/**
 * Parse a Cloudflare GraphQL R2 analytics response into free-tier counters.
 * Exported for unit tests.
 */
export type R2StorageGraphqlGroup = {
  max?: {
    objectCount?: number | null;
    uploadCount?: number | null;
    payloadSize?: number | null;
    metadataSize?: number | null;
  } | null;
  dimensions?: {
    datetime?: string | null;
    date?: string | null;
    bucketName?: string | null;
  } | null;
};

function groupStoredBytes(group: R2StorageGraphqlGroup): number {
  const payload = Number(group.max?.payloadSize ?? 0);
  const metadata = Number(group.max?.metadataSize ?? 0);
  return (
    (Number.isFinite(payload) ? payload : 0) +
    (Number.isFinite(metadata) ? metadata : 0)
  );
}

function graphqlDateKey(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 10) return null;
  const key = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
  return key;
}

function utcDateKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function addUtcDays(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  return utcDateKey(new Date(Date.UTC(year, month - 1, day + days)));
}

/** Inclusive UTC calendar dates from `startKey` through `endKey`. */
export function eachUtcDateInclusive(startKey: string, endKey: string): string[] {
  const out: string[] = [];
  let current = startKey;
  for (let i = 0; i < 40 && current <= endKey; i += 1) {
    out.push(current);
    current = addUtcDays(current, 1);
  }
  return out;
}

/**
 * Free-tier storage stock: the larger of the live snapshot and GB-month.
 * A post-prune 284 MB card must not hide a multi-GiB month; a 22 GiB peak
 * day must not keep the kill switch on after the objects are gone.
 */
export function resolveBillingStorageBytes(
  currentBytes: number,
  gbMonthBytes: number | null | undefined
): number {
  if (gbMonthBytes == null || !Number.isFinite(gbMonthBytes) || gbMonthBytes < 0) {
    return currentBytes;
  }
  return Math.max(currentBytes, gbMonthBytes);
}

export interface R2StoragePeriodSummary {
  gbMonthBytes: number;
  monthPeakBytes: number;
  monthPeakDate: string | null;
  previousWeekGbMonthBytes: number;
  previousWeekPeakBytes: number;
}

/**
 * Build GB-month / week / peak from one row per bucket per UTC date.
 * Missing calendar days count as zero so a short peak does not look like
 * the whole month.
 */
export function summarizeR2DailyStorage(
  groups: R2StorageGraphqlGroup[],
  now: Date
): R2StoragePeriodSummary | null {
  if (groups.length === 0) return null;

  const perDay = new Map<string, number>();
  for (const group of groups) {
    const dateKey =
      graphqlDateKey(group.dimensions?.date) ??
      graphqlDateKey(group.dimensions?.datetime);
    if (!dateKey) continue;
    perDay.set(dateKey, (perDay.get(dateKey) ?? 0) + groupStoredBytes(group));
  }
  if (perDay.size === 0) return null;

  const todayKey = utcDateKey(now);
  const monthStartKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
  const monthDays = eachUtcDateInclusive(monthStartKey, todayKey);
  if (monthDays.length === 0) return null;

  let monthSum = 0;
  let monthPeakBytes = 0;
  let monthPeakDate: string | null = null;
  for (const day of monthDays) {
    const total = perDay.get(day) ?? 0;
    monthSum += total;
    if (total >= monthPeakBytes) {
      monthPeakBytes = total;
      monthPeakDate = day;
    }
  }

  const weekStartKey = addUtcDays(todayKey, -(R2_PREVIOUS_WEEK_DAYS - 1));
  const weekDays = eachUtcDateInclusive(weekStartKey, todayKey);
  let weekSum = 0;
  let previousWeekPeakBytes = 0;
  for (const day of weekDays) {
    const total = perDay.get(day) ?? 0;
    weekSum += total;
    if (total > previousWeekPeakBytes) previousWeekPeakBytes = total;
  }

  return {
    gbMonthBytes: monthSum / monthDays.length,
    monthPeakBytes,
    monthPeakDate,
    previousWeekGbMonthBytes: weekSum / weekDays.length,
    previousWeekPeakBytes,
  };
}

function sampleFromStorageGroup(group: R2StorageGraphqlGroup): R2BucketStorageSample {
  const bucketName = group.dimensions?.bucketName || "(unknown)";
  const payload = Number(group.max?.payloadSize ?? 0);
  const metadata = Number(group.max?.metadataSize ?? 0);
  const objectCount = Number(group.max?.objectCount ?? 0);
  return {
    bucketName,
    bytes:
      (Number.isFinite(payload) ? payload : 0) +
      (Number.isFinite(metadata) ? metadata : 0),
    objectCount: Number.isFinite(objectCount) ? objectCount : 0,
    asOf: group.dimensions?.datetime ?? null,
  };
}

export function parseR2GraphqlUsage(
  payload: unknown,
  now: Date = new Date()
): FetchedR2UsageMetrics {
  const root = payload as {
    data?: {
      viewer?: {
        accounts?: Array<{
          r2OperationsAdaptiveGroups?: Array<{
            sum?: { requests?: number | null } | null;
            dimensions?: { actionType?: string | null } | null;
          }>;
          r2StorageAdaptiveGroups?: R2StorageGraphqlGroup[];
          r2StorageByBucket?: R2StorageGraphqlGroup[];
          r2StorageByDay?: R2StorageGraphqlGroup[];
        }>;
      };
    };
    errors?: Array<{ message?: string }>;
  };

  if (Array.isArray(root.errors) && root.errors.length > 0) {
    const msg = root.errors
      .map((e) => e.message || "unknown")
      .slice(0, 3)
      .join("; ");
    throw new Error(`Cloudflare GraphQL errors: ${msg}`);
  }

  const accounts = root.data?.viewer?.accounts;
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new Error("Cloudflare GraphQL returned no accounts for R2 usage");
  }

  const account = accounts[0];
  const rawActionCounts: Record<string, number> = {};
  let classAOps = 0;
  let classBOps = 0;

  for (const group of account.r2OperationsAdaptiveGroups ?? []) {
    const action = group.dimensions?.actionType || "unknown";
    const n = Number(group.sum?.requests ?? 0);
    if (!Number.isFinite(n) || n < 0) continue;
    rawActionCounts[action] = (rawActionCounts[action] ?? 0) + n;
    if (classifyR2Action(action) === "B") classBOps += n;
    else classAOps += n;
  }

  // Month groups are one row per bucket (no datetime dimension) so idle
  // orphans still appear.  Overlay 24h latest-per-bucket so a prune is not
  // stuck on the month-window max.
  const latestByBucket = new Map<string, R2BucketStorageSample>();
  for (const group of account.r2StorageByBucket ?? []) {
    const sample = sampleFromStorageGroup(group);
    latestByBucket.set(sample.bucketName, sample);
  }
  const seenFresh = new Set<string>();
  for (const group of account.r2StorageAdaptiveGroups ?? []) {
    const sample = sampleFromStorageGroup(group);
    if (seenFresh.has(sample.bucketName)) continue;
    seenFresh.add(sample.bucketName);
    latestByBucket.set(sample.bucketName, sample);
  }

  const buckets = [...latestByBucket.values()].sort((a, b) => b.bytes - a.bytes);
  const currentBytes = buckets.reduce((sum, b) => sum + b.bytes, 0);
  const daily = summarizeR2DailyStorage(account.r2StorageByDay ?? [], now);
  const monthPeakFromBuckets = (account.r2StorageByBucket ?? []).reduce(
    (sum, group) => sum + groupStoredBytes(group),
    0
  );
  const gbMonthBytes = daily?.gbMonthBytes ?? null;
  const monthPeakBytes =
    daily?.monthPeakBytes ??
    (monthPeakFromBuckets > 0 ? monthPeakFromBuckets : currentBytes);

  return {
    storageBytes: resolveBillingStorageBytes(currentBytes, gbMonthBytes),
    currentBytes,
    gbMonthBytes,
    monthPeakBytes,
    monthPeakDate: daily?.monthPeakDate ?? null,
    previousWeekGbMonthBytes: daily?.previousWeekGbMonthBytes ?? null,
    previousWeekPeakBytes: daily?.previousWeekPeakBytes ?? null,
    classAOps,
    classBOps,
    buckets,
    rawActionCounts,
  };
}

/**
 * True when Cloudflare says this account does not have the R2 product.
 * GraphQL can still return leftover analytics for a disabled account
 * (Jay Old: 116 GiB of ghost buckets, 0 Class A/B, REST 10042).
 */
export function isR2ProductDisabledPayload(payload: unknown): boolean {
  const root = payload as {
    errors?: Array<{ code?: number | string; message?: string }>;
    error?: { code?: number | string; message?: string };
  };
  const errors = Array.isArray(root.errors)
    ? root.errors
    : root.error
      ? [root.error]
      : [];
  for (const entry of errors) {
    const code = Number(entry?.code);
    if (code === R2_PRODUCT_DISABLED_ERROR_CODE) return true;
    const message = String(entry?.message ?? "");
    if (/please enable r2/i.test(message)) return true;
  }
  return false;
}

export type R2ProductStatus = "enabled" | "disabled" | "unknown";

/**
 * REST ListBuckets is Class A.  Call only when GraphQL storage would trip the
 * guard (or for the retired `old` slot).  Cache the verdict for 24h.
 */
export interface R2BucketInventory {
  status: R2ProductStatus;
  /** Live bucket names from REST ListBuckets, or null when unknown/unlistable. */
  bucketNames: string[] | null;
}

/** Bucket names from a Cloudflare REST ListBuckets payload, or null if unparseable. */
export function parseR2BucketNames(payload: unknown): string[] | null {
  const root = payload as {
    result?: { buckets?: Array<{ name?: unknown }> } | Array<{ name?: unknown }>;
    buckets?: Array<{ name?: unknown }>;
  };
  const list = Array.isArray(root.result)
    ? root.result
    : Array.isArray(root.result?.buckets)
      ? root.result.buckets
      : Array.isArray(root.buckets)
        ? root.buckets
        : null;
  if (!list) return null;
  const names: string[] = [];
  for (const entry of list) {
    if (typeof entry?.name === "string" && entry.name.length > 0) {
      names.push(entry.name);
    }
  }
  return names;
}

export async function probeR2BucketInventory(
  credentials: R2UsageCredentials,
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date(),
  cache: Map<
    string,
    { atMs: number; status: "enabled" | "disabled"; bucketNames: string[] | null }
  > = r2ProductStatusCache
): Promise<R2BucketInventory> {
  const cached = cache.get(credentials.accountId);
  if (
    cached &&
    now.getTime() - cached.atMs < R2_PRODUCT_STATUS_CACHE_TTL_MS
  ) {
    return { status: cached.status, bucketNames: cached.bucketNames };
  }

  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(credentials.accountId)}/r2/buckets`;
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { authorization: `Bearer ${credentials.apiToken}` },
    });
    const text = await res.text();
    let payload: unknown = null;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { errors: [{ message: text.slice(0, 200) }] };
    }
    if (isR2ProductDisabledPayload(payload)) {
      cache.set(credentials.accountId, {
        atMs: now.getTime(),
        status: "disabled",
        bucketNames: null,
      });
      return { status: "disabled", bucketNames: null };
    }
    if (res.ok) {
      const bucketNames = parseR2BucketNames(payload);
      cache.set(credentials.accountId, {
        atMs: now.getTime(),
        status: "enabled",
        bucketNames,
      });
      return { status: "enabled", bucketNames };
    }
    // 403/10000 = token cannot list.  Do not treat that as disabled — UM's
    // JAY token GraphQL-reads Usage.Jays.Services but REST-lists 403.
    return { status: "unknown", bucketNames: null };
  } catch {
    return { status: "unknown", bucketNames: null };
  }
}

export async function probeR2ProductStatus(
  credentials: R2UsageCredentials,
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date(),
  cache: Map<
    string,
    { atMs: number; status: "enabled" | "disabled"; bucketNames: string[] | null }
  > = r2ProductStatusCache
): Promise<R2ProductStatus> {
  return (await probeR2BucketInventory(credentials, fetchImpl, now, cache)).status;
}

function r2NotEnabledSnapshot(
  id: R2FleetAppId,
  label: string,
  accountId: string
): R2FleetAccountSnapshot {
  return {
    id,
    label,
    accountIdSuffix: accountId.slice(-8),
    configured: true,
    status: "ok",
    storage: null,
    classA: null,
    classB: null,
    overallOnTrackToExceed70Pct: false,
    metricsSource: "r2_not_enabled",
    buckets: [],
  };
}


export interface R2S3ListCredentials {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function resolveR2S3ListCredentials(
  env: Record<string, string | undefined> = process.env
): R2S3ListCredentials | null {
  const endpoint = (
    env.LITESTREAM_S3_ENDPOINT ||
    env.AWS_S3_ENDPOINT ||
    ""
  ).trim();
  const accessKeyId = (
    env.LITESTREAM_S3_ACCESS_KEY_ID ||
    env.AWS_ACCESS_KEY_ID ||
    ""
  ).trim();
  const secretAccessKey = (
    env.LITESTREAM_S3_SECRET_ACCESS_KEY ||
    env.AWS_SECRET_ACCESS_KEY ||
    ""
  ).trim();
  const region = (
    env.LITESTREAM_S3_REGION ||
    env.AWS_REGION ||
    "auto"
  ).trim() || "auto";
  if (!endpoint || !accessKeyId || !secretAccessKey) return null;
  if (!isLitestreamR2Endpoint(endpoint)) return null;
  return { endpoint, region, accessKeyId, secretAccessKey };
}

/**
 * Buckets to ListObjects for live storage (Class A!). Prefer the litestream
 * primary only. Optional `R2_USAGE_EXTRA_BUCKETS` (comma-separated) for
 * receipts/legacy inventory. Do NOT hardcode every historical bucket — listing
 * large orphan buckets every maintenance tick burned free-tier Class A with no
 * product benefit (2026-08-05 free-tier survival).
 */
export function resolveR2StorageBucketNames(
  env: Record<string, string | undefined> = process.env
): string[] {
  const names = new Set<string>();
  const primary = (
    env.LITESTREAM_S3_BUCKET ||
    env.AWS_S3_BUCKET_NAME ||
    ""
  ).trim();
  if (primary) names.add(primary);
  const extra = (env.R2_USAGE_EXTRA_BUCKETS || "").trim();
  for (const part of extra.split(",")) {
    const n = part.trim();
    if (n) names.add(n);
  }
  // Fallback when env has no bucket name yet (local/dev): only the current prod
  // litestream target — not legacy usage-monitor-bucket (often multi-GiB orphans).
  if (names.size === 0) {
    names.add("usage-monitor-prod-v3");
  }
  return [...names];
}

function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/**
 * ListObjectsV2 size sum for one R2 bucket via the same S3 credentials
 * Litestream uses. This is live inventory — not GraphQL analytics lag.
 */
export async function listR2BucketStorageViaS3(
  creds: R2S3ListCredentials,
  bucket: string,
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date()
): Promise<R2BucketStorageSample> {
  const endpoint = creds.endpoint.replace(/\/$/, "");
  const host = new URL(
    /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(endpoint)
      ? endpoint
      : `https://${endpoint}`
  ).host;
  const region = creds.region === "auto" ? "us-east-1" : creds.region;
  const service = "s3";
  let continuation: string | undefined;
  let bytes = 0;
  let objectCount = 0;
  let pages = 0;

  do {
    pages += 1;
    if (pages > 200) throw new Error(`ListObjectsV2 page cap for bucket ${bucket}`);
    const qs = new URLSearchParams({ "list-type": "2", "max-keys": "1000" });
    if (continuation) qs.set("continuation-token", continuation);
    // Path-style: https://account.r2.cloudflarestorage.com/bucket?list-type=2
    const canonicalUri = `/${bucket}`;
    const queryPairs = [...qs.entries()]
      .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)] as const)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1));
    const canonicalQuery = queryPairs.map(([k, v]) => `${k}=${v}`).join("&");
    const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = sha256Hex("");
    const canonicalHeaders =
      `host:${host}\n` + `x-amz-content-sha256:${payloadHash}\n` + `x-amz-date:${amzDate}\n`;
    const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
    const canonicalRequest = [
      "GET",
      canonicalUri,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");
    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      credentialScope,
      sha256Hex(canonicalRequest),
    ].join("\n");
    const kDate = hmac(`AWS4${creds.secretAccessKey}`, dateStamp);
    const kRegion = hmac(kDate, region);
    const kService = hmac(kRegion, service);
    const kSigning = hmac(kService, "aws4_request");
    const signature = hmac(kSigning, stringToSign).toString("hex");
    const authorization =
      `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;
    const url = `${endpoint.startsWith("http") ? endpoint : `https://${endpoint}`}/${bucket}?${canonicalQuery}`;
    const res = await fetchImpl(url, {
      method: "GET",
      headers: {
        host,
        "x-amz-date": amzDate,
        "x-amz-content-sha256": payloadHash,
        authorization,
      },
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `ListObjectsV2 ${bucket} HTTP ${res.status}: ${text.slice(0, 200)}`
      );
    }
    // Minimal XML parse for <Size> and NextContinuationToken / IsTruncated
    const sizeMatches = [...text.matchAll(/<Size>(\d+)<\/Size>/g)];
    for (const m of sizeMatches) {
      bytes += Number(m[1]) || 0;
      objectCount += 1;
    }
    // Contents count via Key tags is more accurate than Size alone when empty files
    const keyCount = (text.match(/<Key>/g) || []).length;
    if (keyCount > 0 && keyCount !== sizeMatches.length) {
      // Prefer key count for objectCount; sizes still summed from Size tags
      objectCount = keyCount;
    }
    const trunc = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(text);
    const next = text.match(
      /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/
    );
    continuation = trunc && next ? next[1] : undefined;
  } while (continuation);

  return {
    bucketName: bucket,
    bytes,
    objectCount,
    asOf: now.toISOString(),
  };
}

export interface R2ObjectListing {
  key: string;
  size: number;
  lastModified?: string;
}

type LtxListing = R2ObjectListing & { maxTx: number; minTx: number };

/**
 * Pure planner: keep newest tip (highest max-txid) per Litestream LTX level;
 * delete the rest. Non-LTX keys are always kept. Exported for unit tests.
 */
export function planLtxTipPrune(objects: R2ObjectListing[]): {
  keep: R2ObjectListing[];
  delete: R2ObjectListing[];
  byLevel: Record<string, { keep: string; deleteCount: number; freeBytes: number }>;
} {
  const byLevel = new Map<string, LtxListing[]>();
  const other: R2ObjectListing[] = [];
  for (const obj of objects) {
    const m = LTX_OBJECT_KEY_RE.exec(obj.key);
    if (!m) {
      other.push(obj);
      continue;
    }
    const levelKey = `${m[1]}${m[2]}`;
    const entry: LtxListing = {
      ...obj,
      minTx: Number.parseInt(m[3], 16),
      maxTx: Number.parseInt(m[4], 16),
    };
    const arr = byLevel.get(levelKey) ?? [];
    arr.push(entry);
    byLevel.set(levelKey, arr);
  }

  const keep: R2ObjectListing[] = [...other];
  const del: R2ObjectListing[] = [];
  const summary: Record<string, { keep: string; deleteCount: number; freeBytes: number }> =
    {};

  for (const [levelKey, items] of [...byLevel.entries()].sort((a, b) =>
    a[0].localeCompare(b[0])
  )) {
    const sorted = items.slice().sort((a, b) => {
      if (a.maxTx !== b.maxTx) return a.maxTx - b.maxTx;
      if (a.minTx !== b.minTx) return a.minTx - b.minTx;
      return (a.lastModified ?? "").localeCompare(b.lastModified ?? "");
    });
    const tip = sorted[sorted.length - 1];
    keep.push({ key: tip.key, size: tip.size, lastModified: tip.lastModified });
    let freeBytes = 0;
    for (const it of sorted.slice(0, -1)) {
      del.push({ key: it.key, size: it.size, lastModified: it.lastModified });
      freeBytes += it.size;
    }
    summary[levelKey] = {
      keep: tip.key,
      deleteCount: sorted.length - 1,
      freeBytes,
    };
  }

  return { keep, delete: del, byLevel: summary };
}

/**
 * List full object keys+sizes for one bucket (Class A). Used by tip-prune.
 */
export async function listR2BucketObjectsViaS3(
  creds: R2S3ListCredentials,
  bucket: string,
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date()
): Promise<R2ObjectListing[]> {
  const endpoint = creds.endpoint.replace(/\/$/, "");
  const host = new URL(
    /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(endpoint)
      ? endpoint
      : `https://${endpoint}`
  ).host;
  const region = creds.region === "auto" ? "us-east-1" : creds.region;
  const service = "s3";
  let continuation: string | undefined;
  const objects: R2ObjectListing[] = [];
  let pages = 0;

  do {
    pages += 1;
    if (pages > 200) throw new Error(`ListObjectsV2 page cap for bucket ${bucket}`);
    const qs = new URLSearchParams({ "list-type": "2", "max-keys": "1000" });
    if (continuation) qs.set("continuation-token", continuation);
    const canonicalUri = `/${bucket}`;
    const queryPairs = [...qs.entries()]
      .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)] as const)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1));
    const canonicalQuery = queryPairs.map(([k, v]) => `${k}=${v}`).join("&");
    const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = sha256Hex("");
    const canonicalHeaders =
      `host:${host}\n` + `x-amz-content-sha256:${payloadHash}\n` + `x-amz-date:${amzDate}\n`;
    const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
    const canonicalRequest = [
      "GET",
      canonicalUri,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");
    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      credentialScope,
      sha256Hex(canonicalRequest),
    ].join("\n");
    const kDate = hmac(`AWS4${creds.secretAccessKey}`, dateStamp);
    const kRegion = hmac(kDate, region);
    const kService = hmac(kRegion, service);
    const kSigning = hmac(kService, "aws4_request");
    const signature = hmac(kSigning, stringToSign).toString("hex");
    const authorization =
      `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;
    const url = `${endpoint.startsWith("http") ? endpoint : `https://${endpoint}`}/${bucket}?${canonicalQuery}`;
    const res = await fetchImpl(url, {
      method: "GET",
      headers: {
        host,
        "x-amz-date": amzDate,
        "x-amz-content-sha256": payloadHash,
        authorization,
      },
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `ListObjectsV2 ${bucket} HTTP ${res.status}: ${text.slice(0, 200)}`
      );
    }
    // Parse Contents blocks for Key/Size/LastModified
    const contentBlocks = text.match(/<Contents>[\s\S]*?<\/Contents>/g) ?? [];
    for (const block of contentBlocks) {
      const key = block.match(/<Key>([^<]*)<\/Key>/)?.[1];
      const size = Number(block.match(/<Size>(\d+)<\/Size>/)?.[1] ?? 0);
      const lastModified = block.match(/<LastModified>([^<]*)<\/LastModified>/)?.[1];
      if (key) {
        objects.push({
          key,
          size: Number.isFinite(size) ? size : 0,
          lastModified,
        });
      }
    }
    const trunc = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(text);
    const next = text.match(
      /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/
    );
    continuation = trunc && next ? next[1] : undefined;
  } while (continuation);

  return objects;
}

/**
 * DeleteObjects (up to 1000 keys per call). Class A. Returns deleted count.
 */
export async function deleteR2ObjectsViaS3(
  creds: R2S3ListCredentials,
  bucket: string,
  keys: string[],
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date()
): Promise<{ deleted: number; errors: number }> {
  if (keys.length === 0) return { deleted: 0, errors: 0 };
  const endpoint = creds.endpoint.replace(/\/$/, "");
  const host = new URL(
    /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(endpoint)
      ? endpoint
      : `https://${endpoint}`
  ).host;
  const region = creds.region === "auto" ? "us-east-1" : creds.region;
  const service = "s3";
  let deleted = 0;
  let errors = 0;
  const BATCH = 500;

  for (let i = 0; i < keys.length; i += BATCH) {
    const batch = keys.slice(i, i + BATCH);
    const body =
      `<?xml version="1.0" encoding="UTF-8"?><Delete>` +
      batch.map((k) => `<Object><Key>${escapeXml(k)}</Key></Object>`).join("") +
      `</Delete>`;
    const payload = Buffer.from(body, "utf8");
    const payloadHash = sha256Hex(payload);
    const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const dateStamp = amzDate.slice(0, 8);
    const canonicalUri = `/${bucket}`;
    const canonicalQuery = "delete=";
    const contentType = "application/xml";
    const canonicalHeaders =
      `content-type:${contentType}\n` +
      `host:${host}\n` +
      `x-amz-content-sha256:${payloadHash}\n` +
      `x-amz-date:${amzDate}\n`;
    const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
    const canonicalRequest = [
      "POST",
      canonicalUri,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");
    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      credentialScope,
      sha256Hex(canonicalRequest),
    ].join("\n");
    const kDate = hmac(`AWS4${creds.secretAccessKey}`, dateStamp);
    const kRegion = hmac(kDate, region);
    const kService = hmac(kRegion, service);
    const kSigning = hmac(kService, "aws4_request");
    const signature = hmac(kSigning, stringToSign).toString("hex");
    const authorization =
      `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;
    const url = `${endpoint.startsWith("http") ? endpoint : `https://${endpoint}`}/${bucket}?delete=`;
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        host,
        "content-type": contentType,
        "x-amz-date": amzDate,
        "x-amz-content-sha256": payloadHash,
        authorization,
      },
      body: payload,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `DeleteObjects ${bucket} HTTP ${res.status}: ${text.slice(0, 200)}`
      );
    }
    const delCount = (text.match(/<Deleted>/g) || []).length;
    const errCount = (text.match(/<Error>/g) || []).length;
    deleted += delCount || batch.length;
    errors += errCount;
  }
  return { deleted, errors };
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export interface R2TipPruneResult {
  attempted: boolean;
  deletedObjects: number;
  freedBytes: number;
  keptObjects: number;
  error?: string;
}

/**
 * If live storage ≥ soft threshold, tip-prune Litestream LTX on the primary
 * bucket. No-op when under threshold, missing creds, or nothing to delete.
 */
export async function pruneR2LtxTipsIfNeeded(
  storageBytes: number,
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date(),
  env: Record<string, string | undefined> = process.env,
  limits: R2UsageLimits = DEFAULT_R2_FREE_TIER_LIMITS,
  softPct: number = R2_SOFT_PRUNE_STORAGE_PCT
): Promise<R2TipPruneResult> {
  const mtdPct = (storageBytes / limits.storageBytes) * 100;
  if (mtdPct < softPct) {
    return { attempted: false, deletedObjects: 0, freedBytes: 0, keptObjects: 0 };
  }
  const creds = resolveR2S3ListCredentials(env);
  if (!creds) {
    return {
      attempted: false,
      deletedObjects: 0,
      freedBytes: 0,
      keptObjects: 0,
      error: "S3 list credentials unavailable for tip-prune",
    };
  }
  const bucket = (
    env.LITESTREAM_S3_BUCKET ||
    env.AWS_S3_BUCKET_NAME ||
    ""
  ).trim();
  if (!bucket) {
    return {
      attempted: false,
      deletedObjects: 0,
      freedBytes: 0,
      keptObjects: 0,
      error: "no primary litestream bucket for tip-prune",
    };
  }

  try {
    const objects = await listR2BucketObjectsViaS3(creds, bucket, fetchImpl, now);
    const plan = planLtxTipPrune(objects);
    if (plan.delete.length === 0) {
      return {
        attempted: true,
        deletedObjects: 0,
        freedBytes: 0,
        keptObjects: plan.keep.length,
      };
    }
    const freedBytes = plan.delete.reduce((s, o) => s + o.size, 0);
    const { deleted, errors } = await deleteR2ObjectsViaS3(
      creds,
      bucket,
      plan.delete.map((o) => o.key),
      fetchImpl,
      now
    );
    invalidateLiveR2StorageCache();
    console.warn(
      `[r2-usage] tip-prune ${bucket}: deleted=${deleted} errors=${errors} ` +
        `freedGiB=${(freedBytes / (1024 * 1024 * 1024)).toFixed(3)} ` +
        `kept=${plan.keep.length} (storage was ${mtdPct.toFixed(1)}% ≥ soft ${softPct}%)`
    );
    return {
      attempted: true,
      deletedObjects: deleted,
      freedBytes,
      keptObjects: plan.keep.length,
      error: errors > 0 ? `${errors} DeleteObjects errors` : undefined,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[r2-usage] tip-prune failed: ${message}`);
    return {
      attempted: true,
      deletedObjects: 0,
      freedBytes: 0,
      keptObjects: 0,
      error: message,
    };
  }
}

/** In-process cache for live ListObjects inventory (Class A). Default 6h. */
const LIVE_S3_LIST_CACHE_MS = (() => {
  const raw = process.env.R2_LIVE_LIST_CACHE_HOURS?.trim();
  const n = raw ? Number(raw) : 6;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n * 3600_000) : 6 * 3600_000;
})();

/**
 * While kill-switch is on, re-list at most this often so an external tip-prune
 * can auto-resume within an hour. The previous 24h killed-cache stuck storage
 * at the pre-prune value and blocked resume after ops deleted LTX.
 */
const LIVE_S3_LIST_CACHE_WHILE_KILLED_MS = 60 * 60 * 1000;

/** Test/ops: drop the live ListObjects cache so the next check re-lists. */
export function invalidateLiveR2StorageCache(): void {
  liveS3ListCache = null;
}

export async function fetchLiveR2StorageViaS3(
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date(),
  env: Record<string, string | undefined> = process.env
): Promise<{ storageBytes: number; buckets: R2BucketStorageSample[] } | null> {
  // Cache ListObjects (Class A). While killed, cap cache at 1h so tip-prunes
  // are visible for auto-resume without listing every 15m maintenance tick.
  if (LIVE_S3_LIST_CACHE_MS > 0 && liveS3ListCache) {
    const maxAge = isR2AutoDisabled()
      ? Math.min(LIVE_S3_LIST_CACHE_MS, LIVE_S3_LIST_CACHE_WHILE_KILLED_MS)
      : LIVE_S3_LIST_CACHE_MS;
    if (now.getTime() - liveS3ListCache.atMs < maxAge) {
      return liveS3ListCache.value;
    }
  }

  const creds = resolveR2S3ListCredentials(env);
  if (!creds) return null;
  const names = resolveR2StorageBucketNames(env);
  const buckets: R2BucketStorageSample[] = [];
  for (const name of names) {
    try {
      const sample = await listR2BucketStorageViaS3(creds, name, fetchImpl, now);
      buckets.push(sample);
    } catch (err) {
      // AccessDenied / NoSuchBucket are expected for unrelated names.
      const msg = err instanceof Error ? err.message : String(err);
      if (/404|NoSuchBucket|AccessDenied|403|InvalidAccessKeyId/i.test(msg)) {
        continue;
      }
      console.warn(`[r2-usage] live list failed for bucket ${name}: ${msg}`);
    }
  }
  if (buckets.length === 0) return null;
  buckets.sort((a, b) => b.bytes - a.bytes);
  const storageBytes = buckets.reduce((s, b) => s + b.bytes, 0);
  const value = { storageBytes, buckets };
  liveS3ListCache = { atMs: now.getTime(), value };
  return value;
}

export function graphqlStorageSamplesAreFresh(
  buckets: R2BucketStorageSample[],
  now: Date = new Date(),
  maxAgeMs: number = R2_GRAPHQL_STORAGE_MAX_AGE_MS
): boolean {
  if (buckets.length === 0) return false;
  // Orphan buckets (deleted or renamed) can linger in the month-window
  // r2StorageByBucket series with no 24-hour sample (asOf null).  They must
  // not poison the freshness check and block GraphQL-based auto-resume.
  // Only buckets with a current sample count; zero sampled buckets is stale.
  const sampled = buckets.filter((b) => b.asOf);
  if (sampled.length === 0) return false;
  return sampled.every((b) => {
    const t = Date.parse(b.asOf as string);
    return Number.isFinite(t) && now.getTime() - t <= maxAgeMs;
  });
}

/**
 * Merge per-bucket live S3 inventory into GraphQL account storage.
 *
 * Cloudflare bills the **whole account** (all buckets).  A live ListObjects overlay
 * only covers litestream-primary + optional extras — after B2 cutover that list is
 * tiny (weekly archives) while orphan buckets still count toward the free tier.
 * Never replace the account total with a partial live sum.
 */
export function mergeGraphqlStorageWithLiveOverlay(
  graphqlBuckets: R2BucketStorageSample[],
  live: { buckets: R2BucketStorageSample[] } | null
): {
  storageBytes: number;
  buckets: R2BucketStorageSample[];
  storageIsLive: boolean;
  metricsSource: R2MetricsSource;
} {
  if (!live || live.buckets.length === 0) {
    const storageBytes = graphqlBuckets.reduce((sum, bucket) => sum + bucket.bytes, 0);
    return {
      storageBytes,
      buckets: graphqlBuckets,
      storageIsLive: false,
      metricsSource: "cloudflare_graphql",
    };
  }

  const merged = new Map<string, R2BucketStorageSample>();
  for (const bucket of graphqlBuckets) {
    merged.set(bucket.bucketName, bucket);
  }
  for (const liveBucket of live.buckets) {
    merged.set(liveBucket.bucketName, liveBucket);
  }
  const buckets = [...merged.values()].sort((a, b) => b.bytes - a.bytes);
  const storageBytes = buckets.reduce((sum, bucket) => sum + bucket.bytes, 0);
  return {
    storageBytes,
    buckets,
    storageIsLive: true,
    metricsSource: "live_s3_storage+graphql_ops",
  };
}

/**
 * Live S3 may replace configured-bucket snapshots.  Recompute billing after
 * that overlay so a 284 MB weekly archive cannot hide a multi-GiB GB-month.
 */
export function applyStorageOverlay(
  metrics: FetchedR2UsageMetrics,
  live: { buckets: R2BucketStorageSample[] } | null
): {
  currentBytes: number;
  billingBytes: number;
  buckets: R2BucketStorageSample[];
  storageIsLive: boolean;
  metricsSource: R2MetricsSource;
} {
  const merged = mergeGraphqlStorageWithLiveOverlay(metrics.buckets, live);
  return {
    currentBytes: merged.storageBytes,
    billingBytes: resolveBillingStorageBytes(
      merged.storageBytes,
      metrics.gbMonthBytes
    ),
    buckets: merged.buckets,
    storageIsLive: merged.storageIsLive,
    metricsSource: merged.metricsSource,
  };
}

/** Short fleet rollup lines for the UM daily Pushover digest. */
export function formatFleetR2DigestLines(
  fleet: R2FleetSummary
): string[] {
  if (!fleet.configured) return [];

  const lines = ["Fleet R2 free tiers (account-wide GraphQL):"];
  for (const account of fleet.accounts) {
    if (!account.configured || account.status === "unconfigured") continue;
    if (account.metricsSource === "r2_not_enabled") {
      lines.push(`  ${account.label}: R2 not enabled (retired account)`);
      continue;
    }
    if (account.status === "error") {
      const err = account.error?.slice(0, 100) ?? "unknown error";
      lines.push(`  ${account.label}: error — ${err}`);
      continue;
    }
    const storageGiB = (account.storage?.actual ?? 0) / (1024 * 1024 * 1024);
    const mtdPct = account.storage?.mtdPct ?? 0;
    const flag = account.overallOnTrackToExceed70Pct ? " ⚠️" : "";
    const details: string[] = [];
    if (
      account.currentBytes != null &&
      Math.abs(account.currentBytes - (account.storage?.actual ?? 0)) > 1024 * 1024
    ) {
      details.push(
        `now ${(account.currentBytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`
      );
    }
    if (
      account.monthPeakBytes != null &&
      account.monthPeakBytes > (account.storage?.actual ?? 0) + 1024 * 1024
    ) {
      const peakGiB = (account.monthPeakBytes / (1024 * 1024 * 1024)).toFixed(2);
      const peakWhen = account.monthPeakDate ? ` ${account.monthPeakDate}` : "";
      details.push(`peak ${peakGiB} GiB${peakWhen}`);
    }
    if (account.previousWeekGbMonthBytes != null) {
      details.push(
        `last 7d ${(account.previousWeekGbMonthBytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`
      );
    }
    const extra = details.length > 0 ? `; ${details.join("; ")}` : "";
    lines.push(
      `  ${account.label}: ${storageGiB.toFixed(2)} GiB (${mtdPct.toFixed(1)}% MTD)${extra}${flag}`
    );
  }
  return lines;
}



/**
 * Fetch account-wide R2 storage + Class A/B ops for the current UTC month
 * from Cloudflare GraphQL analytics.
 */
export async function fetchR2UsageMetrics(
  credentials: R2UsageCredentials,
  now: Date = new Date(),
  fetchImpl: typeof fetch = fetch
): Promise<FetchedR2UsageMetrics> {
  const body = JSON.stringify({
    query: R2_USAGE_GRAPHQL_QUERY,
    variables: {
      accountTag: credentials.accountId,
      startDate: utcMonthStartIso(now),
      endDate: now.toISOString(),
      storageStartDate: utcStorageLookbackIso(now),
    },
  });

  const res = await fetchImpl("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: {
      authorization: `Bearer ${credentials.apiToken}`,
      "content-type": "application/json",
    },
    body,
  });

  const text = await res.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(
      `Cloudflare GraphQL returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`
    );
  }

  if (!res.ok) {
    throw new Error(
      `Cloudflare GraphQL HTTP ${res.status}: ${text.slice(0, 200)}`
    );
  }

  return parseR2GraphqlUsage(payload, now);
}

// ── Fleet (4 Cloudflare accounts = 4 free tiers) ─────────────────────────────
// Owner ops hub: show UM / ST / CT / Old R2 free-tier side-by-side.
// Kill-switch still only runs against THIS app's UM account via runR2UsageCheck.
//
// Account map (confirmed via GET /accounts on the fleet token):
//   um  Usage.Jays.Services   R2_USAGE_* / CLOUDFLARE_JAY_* / CLOUDFLARE_ACCOUNT_ID
//   st  SocraticTrade.com     CLOUDFLARE_ST_ACCOUNT_ID
//   ct  Congress.Trade        CLOUDFLARE_CT_ACCOUNT_ID
//   old jay (legacy)          CLOUDFLARE_OLD_ACCOUNT_ID
// CLOUDFLARE_JAY_* is a historical alias for the UM account, not the "jay"
// dashboard account. Do not point the UM slot at CLOUDFLARE_OLD_*.

export type R2FleetAppId = "um" | "st" | "ct" | "old";

export interface R2FleetAccountConfig {
  id: R2FleetAppId;
  label: string;
  accountId: string;
  apiToken: string;
}

export interface R2FleetAccountSnapshot {
  id: R2FleetAppId;
  label: string;
  /** Last 8 chars of account id for operator correlation (no secrets). */
  accountIdSuffix: string | null;
  configured: boolean;
  status: "ok" | "error" | "unconfigured";
  error?: string;
  storage: R2MetricStatus | null;
  classA: R2MetricStatus | null;
  classB: R2MetricStatus | null;
  overallOnTrackToExceed70Pct: boolean;
  metricsSource: R2MetricsSource | "unconfigured";
  buckets: Array<{ bucketName: string; bytes: number }>;
  /**
   * Buckets GraphQL still reports for this month but REST ListBuckets says no
   * longer exist — excluded from `currentBytes`/`buckets` (deleted buckets
   * linger in month-window analytics until the UTC month rolls over).
   */
  ghostBuckets?: string[];
  /** True only for the Usage Monitor (Jay) account when this host's kill flag is set. */
  autoDisabled?: boolean;
  litestreamUsesR2?: boolean;
  currentBytes?: number;
  gbMonthBytes?: number | null;
  monthPeakBytes?: number;
  monthPeakDate?: string | null;
  previousWeekGbMonthBytes?: number | null;
  previousWeekPeakBytes?: number | null;
}

export interface R2FleetSummary {
  configured: boolean;
  thresholdPct: number;
  freeTier: {
    storageBytes: number;
    classAOps: number;
    classBOps: number;
  };
  accounts: R2FleetAccountSnapshot[];
  anyOnTrackToExceed: boolean;
  fetchedAt: string;
  /** Local litestream/kill state for this host (UM only). */
  localBackup: {
    autoDisabled: boolean;
    litestreamUsesR2: boolean;
  };
}

const FLEET_SLOTS: Array<{
  id: R2FleetAppId;
  label: string;
  accountEnv: string[];
  tokenEnv: string[];
}> = [
  {
    id: "um",
    label: "Usage Monitor",
    accountEnv: ["R2_USAGE_ACCOUNT_ID", "CLOUDFLARE_JAY_ACCOUNT_ID", "CLOUDFLARE_ACCOUNT_ID"],
    tokenEnv: [
      "CLOUDFLARE_JAY_API_TOKEN",
      "R2_USAGE_API_TOKEN",
      "CLOUDFLARE_FLEET_API_TOKEN",
      "CLOUDFLARE_API_TOKEN",
    ],
  },
  {
    id: "st",
    label: "Socratic Trade",
    accountEnv: ["CLOUDFLARE_ST_ACCOUNT_ID"],
    tokenEnv: ["CLOUDFLARE_FLEET_API_TOKEN", "CLOUDFLARE_ST_API_TOKEN"],
  },
  {
    id: "ct",
    label: "Congress.Trade",
    accountEnv: ["CLOUDFLARE_CT_ACCOUNT_ID"],
    tokenEnv: ["CLOUDFLARE_FLEET_API_TOKEN", "CLOUDFLARE_CT_API_TOKEN"],
  },
  {
    id: "old",
    label: "Jay (Old)",
    accountEnv: ["CLOUDFLARE_OLD_ACCOUNT_ID"],
    tokenEnv: ["CLOUDFLARE_FLEET_API_TOKEN", "CLOUDFLARE_OLD_API_TOKEN"],
  },
];

function firstEnv(
  env: Record<string, string | undefined>,
  keys: string[]
): string {
  for (const k of keys) {
    const v = env[k]?.trim();
    if (v) return v;
  }
  return "";
}

/**
 * Load any configured fleet account credentials (UM / ST / CT / Old).
 * Unset slots are skipped so a subset still works.
 */
export function loadR2FleetAccounts(
  env: Record<string, string | undefined> = process.env
): R2FleetAccountConfig[] {
  const out: R2FleetAccountConfig[] = [];
  for (const slot of FLEET_SLOTS) {
    const accountId = firstEnv(env, slot.accountEnv);
    const apiToken = firstEnv(env, slot.tokenEnv);
    if (accountId && apiToken) {
      out.push({
        id: slot.id,
        label: slot.label,
        accountId,
        apiToken,
      });
    }
  }
  return out;
}

function emptyMetric(): R2MetricStatus {
  return {
    actual: 0,
    limit: 0,
    mtdPct: 0,
    projected: 0,
    projectedPct: 0,
    onTrackToExceed: false,
  };
}

function unconfiguredAccount(
  id: R2FleetAppId,
  label: string
): R2FleetAccountSnapshot {
  return {
    id,
    label,
    accountIdSuffix: null,
    configured: false,
    status: "unconfigured",
    storage: null,
    classA: null,
    classB: null,
    overallOnTrackToExceed70Pct: false,
    metricsSource: "unconfigured",
    buckets: [],
  };
}

/**
 * Read-only fleet snapshot for the Ops dashboard. Does **not** engage the
 * kill-switch (that remains UM-only in {@link runR2UsageCheck}).
 */
export async function fetchR2FleetSummary(
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date(),
  env: Record<string, string | undefined> = process.env
): Promise<R2FleetSummary> {
  const configured = loadR2FleetAccounts(env);
  const byId = new Map(configured.map((a) => [a.id, a]));
  const accounts: R2FleetAccountSnapshot[] = await Promise.all(
    FLEET_SLOTS.map(async (slot) => {
    const cfg = byId.get(slot.id);
    if (!cfg) {
      return unconfiguredAccount(slot.id, slot.label);
    }
    try {
      const metrics = await fetchR2UsageMetrics(
        { accountId: cfg.accountId, apiToken: cfg.apiToken },
        now,
        fetchImpl
      );
      let overlaid = applyStorageOverlay(metrics, null);
      if (slot.id === "um") {
        try {
          const live = await fetchLiveR2StorageViaS3(fetchImpl, now, env);
          overlaid = applyStorageOverlay(metrics, live);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(
            `[r2-usage] live S3 overlay failed; keeping GraphQL storage: ${message}`
          );
        }
      }
      let assessment = assessR2Usage(
        overlaid.billingBytes,
        metrics.classAOps,
        metrics.classBOps,
        DEFAULT_R2_FREE_TIER_LIMITS,
        now,
        {
          metricsSource: overlaid.metricsSource,
          buckets: overlaid.buckets,
          currentBytes: overlaid.currentBytes,
          gbMonthBytes: metrics.gbMonthBytes,
          monthPeakBytes: metrics.monthPeakBytes,
          monthPeakDate: metrics.monthPeakDate,
          previousWeekGbMonthBytes: metrics.previousWeekGbMonthBytes,
          previousWeekPeakBytes: metrics.previousWeekPeakBytes,
        }
      );
      // GraphQL keeps serving leftover analytics after R2 is turned off
      // (Jay Old 2026-08-15: 116 GiB, REST 10042).  ListBuckets is Class A,
      // so only confirm when storage would trip the guard or this is the
      // retired `old` slot.
      let ghostBuckets: string[] | undefined;
      const storageWouldTrip = assessment.storage.onTrackToExceed;
      if (storageWouldTrip || slot.id === "old") {
        const inventory = await probeR2BucketInventory(
          { accountId: cfg.accountId, apiToken: cfg.apiToken },
          fetchImpl,
          now
        );
        if (inventory.status === "disabled") {
          return r2NotEnabledSnapshot(slot.id, slot.label, cfg.accountId);
        }
        // A DELETED bucket keeps its month-window GraphQL row until the UTC
        // month rolls over (usage-monitor-bucket 2026-08: 15 GiB ghost weeks
        // after deletion).  Drop non-existent buckets from the CURRENT
        // snapshot; GB-month stays untouched — the bucket's earlier residency
        // this month really does bill.
        if (inventory.status === "enabled" && inventory.bucketNames) {
          const liveNames = new Set(inventory.bucketNames);
          const ghosts = overlaid.buckets.filter(
            (b) => !liveNames.has(b.bucketName)
          );
          if (ghosts.length > 0) {
            ghostBuckets = ghosts.map((b) => b.bucketName);
            const kept = overlaid.buckets.filter((b) =>
              liveNames.has(b.bucketName)
            );
            const keptBytes = kept.reduce((sum, b) => sum + b.bytes, 0);
            overlaid = { ...overlaid, buckets: kept, currentBytes: keptBytes };
            assessment = assessR2Usage(
              resolveBillingStorageBytes(keptBytes, metrics.gbMonthBytes),
              metrics.classAOps,
              metrics.classBOps,
              DEFAULT_R2_FREE_TIER_LIMITS,
              now,
              {
                metricsSource: overlaid.metricsSource,
                buckets: kept,
                currentBytes: keptBytes,
                gbMonthBytes: metrics.gbMonthBytes,
                monthPeakBytes: metrics.monthPeakBytes,
                monthPeakDate: metrics.monthPeakDate,
                previousWeekGbMonthBytes: metrics.previousWeekGbMonthBytes,
                previousWeekPeakBytes: metrics.previousWeekPeakBytes,
              }
            );
          }
        }
      }
      return {
        id: slot.id,
        label: slot.label,
        accountIdSuffix: cfg.accountId.slice(-8),
        configured: true,
        status: "ok",
        storage: assessment.storage,
        classA: assessment.classA,
        classB: assessment.classB,
        overallOnTrackToExceed70Pct: assessment.overallOnTrackToExceed70Pct,
        metricsSource: overlaid.metricsSource,
        buckets: overlaid.buckets.map((b) => ({
          bucketName: b.bucketName,
          bytes: b.bytes,
        })),
        ghostBuckets,
        autoDisabled: slot.id === "um" ? isR2AutoDisabled() : undefined,
        litestreamUsesR2:
          slot.id === "um" ? isLitestreamR2Endpoint() : undefined,
        currentBytes: overlaid.currentBytes,
        gbMonthBytes: metrics.gbMonthBytes,
        monthPeakBytes: metrics.monthPeakBytes,
        monthPeakDate: metrics.monthPeakDate,
        previousWeekGbMonthBytes: metrics.previousWeekGbMonthBytes,
        previousWeekPeakBytes: metrics.previousWeekPeakBytes,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        id: slot.id,
        label: slot.label,
        accountIdSuffix: cfg.accountId.slice(-8),
        configured: true,
        status: "error",
        error: message,
        storage: emptyMetric(),
        classA: emptyMetric(),
        classB: emptyMetric(),
        overallOnTrackToExceed70Pct: false,
        metricsSource: "unavailable",
        buckets: [],
      };
    }
    })
  );

  return {
    configured: configured.length > 0,
    thresholdPct: R2_THRESHOLD_PCT,
    freeTier: {
      storageBytes: DEFAULT_R2_FREE_TIER_LIMITS.storageBytes,
      classAOps: DEFAULT_R2_FREE_TIER_LIMITS.classAOps,
      classBOps: DEFAULT_R2_FREE_TIER_LIMITS.classBOps,
    },
    accounts,
    anyOnTrackToExceed: accounts.some((a) => a.overallOnTrackToExceed70Pct),
    fetchedAt: now.toISOString(),
    localBackup: {
      autoDisabled: isR2AutoDisabled(),
      litestreamUsesR2: isLitestreamR2Endpoint(),
    },
  };
}

export async function runR2UsageCheck(
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date()
): Promise<R2UsageAssessment> {
  let checkpointTransitionError: string | undefined;
  const recordCheckpointTransitionError = (message: string, error: unknown) => {
    checkpointTransitionError ??= message;
    const errorName = error instanceof Error ? error.name.slice(0, 48) : "unknown";
    console.error(`[r2-usage] ${message} (error=${errorName})`);
  };

  // Retry prior checkpoint transfers before cached inventory or other paths.
  try {
    await retryPendingR2CheckpointHandoff();
  } catch (error) {
    recordCheckpointTransitionError(
      "SQLite checkpoint handoff retry failed; the R2 kill remains active",
      error
    );
  }
  const credentials = resolveR2UsageCredentials();
  let assessment: R2UsageAssessment;
  const failClosed = r2FreeTierFailClosedRequired();
  let storageIsLive = false;
  let storageSampleStale = false;

  // Live S3 inventory is authoritative for storage (GraphQL lag caused a late
  // false 15 GiB kill after the bucket was already emptied).
  const liveStorage = await fetchLiveR2StorageViaS3(fetchImpl, now);

  if (!credentials) {
    if (liveStorage) {
      // Ops unknown without GraphQL; storage is live. Enforce storage-only.
      assessment = assessR2Usage(
        liveStorage.storageBytes,
        0,
        0,
        DEFAULT_R2_FREE_TIER_LIMITS,
        now,
        {
          metricsSource: "live_s3_storage+graphql_ops",
          metricsError:
            "GraphQL analytics credentials missing — Class A/B ops not measured; storage from live S3 list",
          buckets: liveStorage.buckets,
        }
      );
      // Zero ops will not trip ops thresholds; storage will if absolute ≥ 90%.
      storageIsLive = true;
      console.warn(
        "[r2-usage] GraphQL credentials missing; enforcing storage from live S3 list only"
      );
    } else {
      const errMsg =
        "R2 usage credentials not configured (set R2_USAGE_ACCOUNT_ID + R2_USAGE_API_TOKEN, or CLOUDFLARE_JAY_ACCOUNT_ID + CLOUDFLARE_JAY_API_TOKEN) and live S3 list unavailable";
      assessment = assessR2Usage(0, 0, 0, DEFAULT_R2_FREE_TIER_LIMITS, now, {
        metricsSource: "unavailable",
        metricsError: errMsg,
      });
      if (failClosed) {
        console.error(
          "[r2-usage] FAIL CLOSED: cannot measure R2 free tier with R2 Litestream in production — disabling R2 writes"
        );
        if (!isR2AutoDisabled()) {
          try {
            await enforceR2AutoDisable(
              `fail-closed: ${errMsg} (cannot enforce ${R2_THRESHOLD_PCT}% free-tier policy blind)`
            );
          } catch (error) {
            recordCheckpointTransitionError(
              "R2 fail-closed kill persisted; checkpoint handoff is pending",
              error
            );
          }
        }
      } else {
        console.warn(
          "[r2-usage] skipping free-tier enforcement (non-production): no live S3 list and no GraphQL credentials"
        );
      }
    }
  } else {
    try {
      const metrics = await fetchR2UsageMetrics(credentials, now, fetchImpl);
      const overlaid = applyStorageOverlay(metrics, liveStorage);
      let billingBytes = overlaid.billingBytes;
      let buckets = overlaid.buckets;
      let source: R2MetricsSource = overlaid.metricsSource;
      let currentBytes = overlaid.currentBytes;
      storageIsLive = overlaid.storageIsLive;

      if (
        !liveStorage &&
        !graphqlStorageSamplesAreFresh(metrics.buckets, now)
      ) {
        // Stale GraphQL storage caused a delayed false 15 GiB alert after prune.
        // Refuse to kill on storage when samples are old; still enforce ops.
        // Exclude the stale current snapshot while preserving the GB-month series.
        storageSampleStale = true;
        currentBytes = 0;
        billingBytes =
          metrics.gbMonthBytes != null && Number.isFinite(metrics.gbMonthBytes)
            ? metrics.gbMonthBytes
            : 0;
        console.warn(
          "[r2-usage] GraphQL storage samples are stale; ignoring storage for kill decisions (ops still enforced)"
        );
      } else if (!liveStorage) {
        // Samples are fresh, but an orphan bucket (deleted/renamed, asOf null)
        // can still carry its stale month-max size into currentBytes and trip a
        // false kill or block auto-resume.  Drop orphans from the CURRENT
        // snapshot; GB-month stays untouched — the bucket's earlier residency
        // this month really does bill (same rule as the fleet rollup).
        const liveSamples = buckets.filter((b) => b.asOf);
        if (liveSamples.length !== buckets.length) {
          const orphans = buckets
            .filter((b) => !b.asOf)
            .map((b) => b.bucketName);
          console.warn(
            `[r2-usage] dropping ${orphans.length} orphan bucket(s) from current storage: ${orphans.join(", ")}`
          );
          buckets = liveSamples;
          currentBytes = liveSamples.reduce((sum, b) => sum + b.bytes, 0);
          billingBytes = resolveBillingStorageBytes(
            currentBytes,
            metrics.gbMonthBytes
          );
        }
      }

      assessment = assessR2Usage(
        billingBytes,
        metrics.classAOps,
        metrics.classBOps,
        DEFAULT_R2_FREE_TIER_LIMITS,
        now,
        {
          metricsSource: source,
          buckets,
          currentBytes,
          gbMonthBytes: metrics.gbMonthBytes,
          monthPeakBytes: metrics.monthPeakBytes,
          monthPeakDate: metrics.monthPeakDate,
          previousWeekGbMonthBytes: metrics.previousWeekGbMonthBytes,
          previousWeekPeakBytes: metrics.previousWeekPeakBytes,
          metricsError: storageSampleStale
            ? "GraphQL storage samples stale; storage kill deferred until live list or fresh sample"
            : undefined,
        }
      );

      // If storage was zeroed due to stale GraphQL, do not treat storage as breached.
      if (storageSampleStale && assessment.exceededMetric === "storage") {
        assessment = {
          ...assessment,
          overallOnTrackToExceed70Pct:
            assessment.classA.onTrackToExceed || assessment.classB.onTrackToExceed,
          exceededMetric: assessment.classA.onTrackToExceed
            ? "classA"
            : assessment.classB.onTrackToExceed
              ? "classB"
              : undefined,
        };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[r2-usage] failed to fetch Cloudflare R2 metrics:", message);
      if (liveStorage) {
        assessment = assessR2Usage(
          liveStorage.storageBytes,
          0,
          0,
          DEFAULT_R2_FREE_TIER_LIMITS,
          now,
          {
            metricsSource: "live_s3_storage+graphql_ops",
            metricsError: `GraphQL failed (${message}); storage from live S3 list`,
            buckets: liveStorage.buckets,
          }
        );
        storageIsLive = true;
      } else {
        assessment = assessR2Usage(0, 0, 0, DEFAULT_R2_FREE_TIER_LIMITS, now, {
          metricsSource: "unavailable",
          metricsError: message,
        });
        if (failClosed && !isR2AutoDisabled()) {
          try {
            await enforceR2AutoDisable(
              `fail-closed: R2 metrics unavailable (${message}) — cannot enforce ${R2_THRESHOLD_PCT}% free-tier policy blind`
            );
          } catch (error) {
            recordCheckpointTransitionError(
              "R2 fail-closed kill persisted; checkpoint handoff is pending",
              error
            );
          }
        }
      }
    }
  }

  assessment.storageIsLive = storageIsLive;
  assessment.storageSampleStale = storageSampleStale;

  // Soft tip-prune before kill: multi-level LTX history is DR-optional; free
  // tier is not. Re-list after a successful prune so kill/resume use new bytes.
  const currentStorageBytes =
    assessment.currentBytes != null && Number.isFinite(assessment.currentBytes)
      ? assessment.currentBytes
      : assessment.storage.actual;
  const currentStoragePct =
    assessment.storage.limit > 0
      ? (currentStorageBytes / assessment.storage.limit) * 100
      : 0;

  if (
    storageIsLive &&
    currentStoragePct >= R2_SOFT_PRUNE_STORAGE_PCT &&
    isLitestreamR2Endpoint()
  ) {
    const prune = await pruneR2LtxTipsIfNeeded(
      currentStorageBytes,
      fetchImpl,
      now
    );
    if (prune.attempted && prune.deletedObjects > 0) {
      const refreshed = await fetchLiveR2StorageViaS3(fetchImpl, now);
      if (refreshed) {
        const opsA = assessment.classA.actual;
        const opsB = assessment.classB.actual;
        assessment = assessR2Usage(
          resolveBillingStorageBytes(
            refreshed.storageBytes,
            assessment.gbMonthBytes
          ),
          opsA,
          opsB,
          DEFAULT_R2_FREE_TIER_LIMITS,
          now,
          {
            metricsSource: "live_s3_storage+graphql_ops",
            buckets: refreshed.buckets,
            metricsError: assessment.metricsError,
            currentBytes: refreshed.storageBytes,
            gbMonthBytes: assessment.gbMonthBytes,
            monthPeakBytes: assessment.monthPeakBytes,
            monthPeakDate: assessment.monthPeakDate,
            previousWeekGbMonthBytes: assessment.previousWeekGbMonthBytes,
            previousWeekPeakBytes: assessment.previousWeekPeakBytes,
          }
        );
        assessment.storageIsLive = true;
        storageIsLive = true;
      }
    }
  }

  // Kill only on trustworthy measurements — never on stale GraphQL storage alone.
  // Storage kill requires a trustworthy sample: live S3 list, or fresh GraphQL
  // (stale GraphQL storage is zeroed above and must never re-alert hours late).
  const mayKillStorage =
    assessment.exceededMetric === "storage" && !storageSampleStale;
  const mayKillOps =
    assessment.exceededMetric === "classA" ||
    assessment.exceededMetric === "classB";
  const shouldKill =
    assessment.metricsSource !== "unavailable" &&
    assessment.overallOnTrackToExceed70Pct &&
    (mayKillStorage || mayKillOps) &&
    !isR2AutoDisabled();

  if (shouldKill) {
    const metric = assessment.exceededMetric || "storage";
    const status = assessment[metric];
    const reason =
      metric === "storage"
        ? `R2 free-tier absolute storage ≥ ${R2_THRESHOLD_PCT}% (live MTD ${status.mtdPct}%)`
        : `R2 free-tier ${metric} ≥ ${R2_THRESHOLD_PCT}% absolute or projected (MTD ${status.mtdPct}%, projected ${status.projectedPct}%)`;
    try {
      await enforceR2AutoDisable(reason);
    } catch (error) {
      recordCheckpointTransitionError(
        "R2 kill persisted; checkpoint handoff is pending",
        error
      );
    }
  }

  // Auto-resume when storage is healthy (hysteresis) and ops are fine.
  // Fixes sticky kill from stale GraphQL after a successful prune.
  // UM-1609: after the litestream B2 cutover, deploy env carries no S3-list
  // creds, so a live list can be impossible on every tick and the kill flag
  // would stick forever. Accept a fresh GraphQL storage sample in that case -
  // but never stale or unavailable metrics, the same trust bar kill
  // decisions use.
  const storageResumeSource = storageIsLive
    ? "live"
    : assessment.metricsSource === "cloudflare_graphql" && !storageSampleStale
      ? "graphql"
      : null;
  if (
    isR2AutoDisabled() &&
    storageResumeSource &&
    assessment.storage.mtdPct < R2_RESUME_STORAGE_PCT &&
    !assessment.classA.onTrackToExceed &&
    !assessment.classB.onTrackToExceed
  ) {
    console.warn(
      `[r2-usage] auto-resume: ${storageResumeSource} storage ${assessment.storage.mtdPct}% < ${R2_RESUME_STORAGE_PCT}% resume threshold; clearing kill switch`
    );
    try {
      await clearR2AutoDisable(
        `${storageResumeSource} storage ${assessment.storage.mtdPct}% < ${R2_RESUME_STORAGE_PCT}% resume threshold`
      );
    } catch (error) {
      recordCheckpointTransitionError(
        "R2 resume transition failed; the kill remains active",
        error
      );
    }
  }

  if (checkpointTransitionError) {
    assessment.checkpointTransitionError = checkpointTransitionError.slice(0, 160);
  }
  assessment.autoDisabled = isR2AutoDisabled();
  assessment.litestreamUsesR2 = isLitestreamR2Endpoint();

  // Retry priority-1 emergency notification until successfully delivered
  if (isR2AutoDisabled() && !isR2EmergencyAlertSent()) {
    const metric = assessment.exceededMetric || "storage";
    const status = assessment[metric];
    const alertTitle = "🚨 ALERT: Cloudflare R2 Free Tier Kill Switch";
    const alertBody = [
      `R2 free-tier usage reached ${R2_THRESHOLD_PCT}% threshold.`,
      `Metric: ${metric}`,
      `MTD: ${status.mtdPct}%  Projected: ${status.projectedPct}%`,
      `Storage: ${(assessment.storage.actual / (1024 * 1024 * 1024)).toFixed(2)} / 10.00 GiB`,
      `Class A: ${assessment.classA.actual.toLocaleString()} / 1,000,000`,
      `Class B: ${assessment.classB.actual.toLocaleString()} / 10,000,000`,
      `Source: ${assessment.metricsSource}`,
      `Litestream→R2: ${assessment.litestreamUsesR2 ? "yes (replication stopped/blocked)" : "no (endpoint not detected as R2)"}`,
      `Flag: /data/${R2_DISABLED_FLAG_FILENAME}`,
      formatOwnBackupRegimenLine({
        killEngaged: true,
        litestreamUsesR2: assessment.litestreamUsesR2,
      }),
    ].join("\n");

    const res = await sendPushoverNotification(
      alertTitle,
      alertBody,
      1,
      fetchImpl,
      { subject: "um" }
    );
    if (res.ok) {
      recordR2EmergencyAlertSent();
    } else {
      console.error(
        "[r2-usage] emergency Pushover not delivered (will retry next tick):",
        res.error
      );
    }
  }

  // Fleet digest stagger: UM prefers UTC hour 8 (ST=14, CT=20) so three daily
  // free-tier digests don't land minutes apart. After the preferred hour, the
  // next maintenance tick still sends once (watermark) so a missed 08Z is fine.
  const todayStr = now.toISOString().slice(0, 10);
  const digestUtcHour = Number(process.env.R2_USAGE_DIGEST_UTC_HOUR ?? "8");
  const hourOk =
    !Number.isFinite(digestUtcHour) ||
    digestUtcHour < 0 ||
    digestUtcHour > 23 ||
    now.getUTCHours() >= digestUtcHour;
  if (getLastDailyPushoverDate() !== todayStr && hourOk) {
    const { title, body } = formatDailyPushoverMessage(
      assessment,
      isR2AutoDisabled()
    );
    let digestBody = body;
    try {
      const fleet = await fetchR2FleetSummary(fetchImpl, now);
      const fleetLines = formatFleetR2DigestLines(fleet);
      if (fleetLines.length > 0) {
        digestBody = `${body}\n\n${fleetLines.join("\n")}`;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[r2-usage] fleet digest append failed: ${message}`);
    }
    const res = await sendPushoverNotification(title, digestBody, 0, fetchImpl, {
      subject: "um",
    });
    if (res.ok) {
      recordDailyPushoverSent(todayStr);
    }
  }

  return assessment;
}
