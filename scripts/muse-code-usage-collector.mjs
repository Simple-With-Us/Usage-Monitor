#!/usr/bin/env node
// Mac-side quota collector for Meta's Muse Code (NOT Anthropic's Muse CLI,
// NOT MiniMax's mcode).  This is a tiny tool that:
//   1. Reads the Muse Code OAuth access token from the macOS keychain
//      (service "ai.meta.dev.credentials", account "meta").
//   2. POSTs to https://api.meta.ai/muse-code/key with that Bearer token.
//   3. Emits one "quota" event per remaining-percent window
//      (5h rolling + weekly) via the existing /api/ingest/usage contract.
//
// Why this runs on the Mac and not on the server: the /muse-code/key endpoint
// is the one the Meta CLI itself calls with the OAuth token it stored in the
// user's keychain.  A server-side connector impersonating that product stays
// out by the same owner ruling that keeps the subscription-quota-collector on
// the laptop (issue #1411, 2026-09-03).  Tokens stay on the Mac.
//
// Usage:
//   node scripts/muse-code-usage-collector.mjs [--dry-run] [--debug]
//
// Env:
//   MUSE_CODE_INGEST_TOKEN  - per-producer scoped token, the value half of the
//                             "muse-code:<token>" pair added to
//                             USAGE_INGEST_PRODUCER_TOKENS.  Falls back to
//                             USAGE_INGEST_TOKEN.
//   USAGE_MONITOR_INGEST_URL - defaults to https://usage.jays.services/api/ingest/usage
//   MUSE_CODE_KEYCHAIN_SERVICE - defaults to "ai.meta.dev.credentials"
//   MUSE_CODE_KEYCHAIN_ACCOUNT - defaults to "meta"
//   MUSE_CODE_KEYCHAIN_TIMEOUT_MS - defaults to 9_000 (8–10s per the brief)
//
// SECRETS:
//   The keychain entry holds the OAuth access token.  We read it via
//   `security find-generic-password -w` and never log, persist, or echo the
//   token or the raw keychain stdout.  We also never log the HTTP response
//   body under any flag — it carries the API key id, plan, and account
//   email — and we treat 3xx as an error (no redirect-following).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { postUsageBatches } from "./lib/session-token-collectors.mjs";
import { resolveCollectorToken } from "./lib/run-session-token-collector.mjs";
import { buildQuotaEvent, clampPercent, toIsoTimestamp } from "./lib/quota-event.mjs";

const execFileAsync = promisify(execFile);

const PRODUCER_ID = "muse-code";
const PROVIDER = "muse-code";
const SERVICE = "muse-code";

const KEYCHAIN_SERVICE = process.env.MUSE_CODE_KEYCHAIN_SERVICE || "ai.meta.dev.credentials";
const KEYCHAIN_ACCOUNT = process.env.MUSE_CODE_KEYCHAIN_ACCOUNT || "meta";
const KEYCHAIN_TIMEOUT_MS = (() => {
  const raw = Number(process.env.MUSE_CODE_KEYCHAIN_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 9_000;
})();
const KEYCHAIN_MAX_STDOUT_BYTES = 1_048_576;

const KEY_ENDPOINT = "https://api.meta.ai/muse-code/key";
const REQUEST_TIMEOUT_MS = 20_000;

const INGEST_URL =
  process.env.USAGE_MONITOR_INGEST_URL ||
  "https://usage.jays.services/api/ingest/usage";

const DRY_RUN = process.argv.includes("--dry-run");
const DEBUG = process.argv.includes("--debug");

const LOG_PREFIX = "[muse-code-usage-collector]";

function log(message) {
  console.log(`${LOG_PREFIX} ${message}`);
}

function debugLog(message) {
  if (DEBUG) console.log(`${LOG_PREFIX} [debug] ${message}`);
}

// ---------------------------------------------------------------- helpers ---

/** macOS keychain read for the Muse Code OAuth access token.
 *
 *  Returns the access_token string (trimmed) or null on:
 *    - non-darwin host
 *    - execFile timeout / non-zero exit (keychain ACL prompt, missing entry)
 *    - non-JSON stdout (legacy / wrong entry shape)
 *    - JSON without a string access_token
 *
 *  Never logs or echoes the token.  On darwin, every failure path prints the
 *  explicit Always-Allow hint and returns null so the caller can skip cleanly.
 */
export async function readMuseCodeAccessTokenFromKeychain({
  execFileImpl = execFileAsync,
  platform = process.platform,
  service = KEYCHAIN_SERVICE,
  account = KEYCHAIN_ACCOUNT,
  timeoutMs = KEYCHAIN_TIMEOUT_MS,
  maxBuffer = KEYCHAIN_MAX_STDOUT_BYTES,
} = {}) {
  if (platform !== "darwin") {
    log(
      `not on macOS; keychain unavailable for "${service}"; muse-code quota is skipped on non-darwin hosts (the access token never leaves the laptop).`,
    );
    return null;
  }
  let stdout = "";
  try {
    const result = await execFileImpl(
      "security",
      ["find-generic-password", "-s", service, "-a", account, "-w"],
      {
        timeout: timeoutMs,
        maxBuffer,
        encoding: "utf8",
      },
    );
    stdout = String(result?.stdout ?? "");
  } catch (error) {
    // execFile's timeout kills the child with SIGTERM; its rejection has
    // code=null, signal=SIGTERM, killed=true (not ETIMEDOUT).  A non-zero
    // exit from a keychain ACL prompt (rc=36 "user interaction not allowed")
    // lands here too.  Both are operator-visible: the first read needs an
    // "Always Allow" grant.
    if (
      error &&
      typeof error === "object" &&
      error.killed === true &&
      error.signal === "SIGTERM"
    ) {
      log(
        `muse-code: macOS keychain lookup for "${service}" timed out after ${timeoutMs}ms; ` +
          'the keychain entry exists but the first read from this process / LaunchAgent ' +
          'needs a one-time "Always Allow" grant so subsequent reads succeed.  Open ' +
          "Keychain Access, search for the entry, open it, click \"Access Control\", " +
          'and add this collector (e.g. /opt/homebrew/bin/node) with "Allow" once — ' +
          "after that the keychain returns the token without prompting.  Nothing will " +
          "appear for Muse Code in Usage Monitor until the grant is in place.  " +
          "Skipping this run (exit 0, zero events).",
      );
      return null;
    }
    const code = error && typeof error === "object" ? error.code : null;
    log(
      `muse-code: macOS keychain lookup for "${service}" failed` +
          (code ? ` (${code})` : "") +
          "; the keychain entry exists but the first read from this process / LaunchAgent " +
          'needs a one-time "Always Allow" grant so subsequent reads succeed.  Open ' +
          "Keychain Access, search for the entry, open it, click \"Access Control\", " +
          'and add this collector (e.g. /opt/homebrew/bin/node) with "Allow" once — ' +
          "after that the keychain returns the token without prompting.  Nothing will " +
          "appear for Muse Code in Usage Monitor until the grant is in place.  " +
          "Skipping this run (exit 0, zero events).",
    );
    return null;
  }
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    log(
      `muse-code: macOS keychain entry "${service}" returned non-JSON content; ` +
        "the CLI may have stored a non-standard payload.  Nothing will appear " +
        "for Muse Code in Usage Monitor until the entry shape is correct.  " +
        "Skipping this run (exit 0, zero events).",
    );
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const token = parsed.access_token;
  if (typeof token !== "string" || !token.trim()) return null;
  return token.trim();
}

// ----------------------------------------------------------------- parse ---

/**
 * Pure parser from a parsed `/muse-code/key` JSON payload to two
 * quota-window readings (5h rolling + weekly).  Returns `[]` (not throws)
 * when the payload is missing, the subscription is inactive, or `subs_usage`
 * is absent / malformed.  This keeps the collector from ever emitting a
 * misleading "0% remaining" event when Meta simply didn't include the field.
 *
 * `observedAt` is the wall-clock at parse time and is the value the caller
 * should pass to `occurredAtIso`.  It defaults to `new Date()` and is
 * surfaced separately so the function has no hidden global clock.
 */
export function quotaReadingsFromMuseCode(payload, { observedAt = new Date() } = {}) {
  if (!payload || typeof payload !== "object") return [];
  // is_subs_active false => subscription not currently enabled.  Emit zero
  // events: a fake 0% reading would surface as "Muse Code plan exhausted"
  // on the dashboard when the user simply hasn't subscribed.
  if (payload.is_subs_active === false) return [];
  const subsUsage = payload.subs_usage;
  if (!subsUsage || typeof subsUsage !== "object") return [];

  const observedIso = observedAt.toISOString();
  const readings = [];

  const window = subsUsage.window;
  if (window && typeof window === "object") {
    const usedRaw = window.used_percent;
    const resetAt = toIsoTimestamp(window.resets_at);
    // Number(null) === 0 is finite, so we must also reject null / undefined /
    // non-numbers explicitly.  A present-but-non-numeric value (e.g. "nope")
    // is treated the same as a missing field: the window is skipped, not
    // emitted as a fake 100%.
    if (typeof usedRaw === "number" && Number.isFinite(usedRaw)) {
      const remaining = clampPercent(100 - usedRaw);
      readings.push({
        bucketId: "rolling-5h",
        label: "5h window",
        quotaWindow: "5h",
        remainingPercent: remaining,
        usedPercent: clampPercent(usedRaw),
        resetAt,
        planType: null,
        modelId: null,
        remainingUnknown: false,
        isExhausted: remaining === 0,
        // Owner scope note (2026-10-05): the only tier signal the reversed
        // /muse-code/key payload exposes is is_subs_active.  At this point
        // it is always true (the false branch short-circuits above), but we
        // still pass it through metadataExtras so buildQuotaEvent surfaces
        // it as the canonical tier marker on every event.  planType stays
        // null: the payload does not name a tier.  No bonus-credits field
        // exists on the payload, so we do not invent one.
        metadataExtras: { is_subs_active: true },
      });
    }
  }

  const weekly = subsUsage.weekly;
  if (weekly && typeof weekly === "object") {
    const usedRaw = weekly.used_percent;
    const resetAt = toIsoTimestamp(weekly.resets_at);
    if (typeof usedRaw === "number" && Number.isFinite(usedRaw)) {
      const remaining = clampPercent(100 - usedRaw);
      readings.push({
        bucketId: "weekly",
        label: "weekly",
        quotaWindow: "weekly",
        remainingPercent: remaining,
        usedPercent: clampPercent(usedRaw),
        resetAt,
        planType: null,
        modelId: null,
        remainingUnknown: false,
        isExhausted: remaining === 0,
        metadataExtras: { is_subs_active: true },
      });
    }
  }

  // Expose observedAt so the caller can stamp every event with the same wall
  // clock without re-reading it; tests assert exact equality.
  for (const reading of readings) {
    reading.observedAtIso = observedIso;
  }
  return readings;
}

/** Pure parser from a payload to the full quota event array (the shape the
 *  collector actually posts).  Convenience wrapper that mirrors the pattern
 *  used by the other collectors. */
export function quotaEventsFromMuseCode(payload, observedAt = new Date()) {
  const occurredAtIso = (observedAt instanceof Date ? observedAt : new Date()).toISOString();
  return quotaReadingsFromMuseCode(payload, { observedAt: new Date(occurredAtIso) }).map((reading) =>
    buildQuotaEvent({
      provider: PROVIDER,
      service: SERVICE,
      reading,
      source: "api.meta.ai",
      occurredAtIso,
    }),
  );
}

// ----------------------------------------------------------------- http ---

/**
 * Fetch the /muse-code/key envelope for the given bearer token.
 * Never follows redirects (3xx is treated as an error); never logs the
 * response body (it carries the API key id, plan and account email).  The
 * caller never sees the bearer or any header value either.
 */
export async function fetchMuseCodeKey(accessToken, {
  fetchImpl = (url, init) => fetch(url, init),
  url = KEY_ENDPOINT,
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      // `redirect: "manual"` makes a 3xx resolve as `type: "opaqueredirect"`
      // with status 0; the catch below promotes that to a clean error.
      redirect: "manual",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "x-api-version": "1.0.0",
        accept: "application/json",
        "content-type": "application/json",
      },
      body: "{}",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const cause = error && typeof error === "object" ? error.cause : null;
    const code =
      cause && typeof cause === "object" ? cause.code || cause.errno || cause.syscall : null;
    if (error && error.name === "TimeoutError") {
      throw new Error("timeout from api.meta.ai");
    }
    throw new Error(`fetch failed from api.meta.ai${code ? ` (${code})` : ""}`);
  }
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    throw new Error(`unexpected redirect from api.meta.ai (HTTP ${response.status || "3xx"})`);
  }
  if (!response.ok) {
    // Deliberately do not include the response body: it can carry the API
    // key id and account email.
    throw new Error(`HTTP ${response.status} from api.meta.ai`);
  }
  let parsed = null;
  try {
    parsed = await response.json();
  } catch {
    throw new Error("Non-JSON response from api.meta.ai");
  }
  return parsed;
}

// ----------------------------------------------------------------- main ---

export async function collectMuseCode({
  execFileImpl = execFileAsync,
  fetchImpl,
  platform = process.platform,
  now = new Date(),
} = {}) {
  const accessToken = await readMuseCodeAccessTokenFromKeychain({ execFileImpl, platform });
  if (!accessToken) {
    return { provider: PROVIDER, status: "skipped", events: [] };
  }
  const payload = await fetchMuseCodeKey(accessToken, { fetchImpl });
  if (DEBUG) debugLog("fetched /muse-code/key payload (keys omitted)");
  const events = quotaEventsFromMuseCode(payload, now);
  return {
    provider: PROVIDER,
    status: events.length === 0 ? "skipped" : "ok",
    events,
  };
}

async function main() {
  const token = resolveCollectorToken(["MUSE_CODE_INGEST_TOKEN", "USAGE_INGEST_TOKEN"]);
  if (!token && !DRY_RUN) {
    log(
      "Missing MUSE_CODE_INGEST_TOKEN or USAGE_INGEST_TOKEN. Ensure token is set in environment or ~/.secrets/global-api-keys.",
    );
    process.exit(1);
  }

  let result;
  try {
    result = await collectMuseCode();
  } catch (error) {
    log(`FAILED (${error instanceof Error ? error.message : String(error)})`);
    // A failed fetch is an operator-visible problem (not the keychain ACL
    // case, which already short-circuited inside readMuseCodeKey), so this
    // exit 1 is intentional: launchd will retry on the next 15-minute tick.
    process.exit(1);
  }

  if (result.status === "skipped") {
    log(
      result.events.length === 0
        ? "skipped (no quota windows emitted; keychain ACL or inactive subscription)"
        : "skipped",
    );
    process.exit(0);
  }

  log(`parsed ${result.events.length} quota window(s):`);
  for (const event of result.events) {
    const remaining = event.credits == null ? "not reported" : `${event.credits}%`;
    log(
      `  - ${event.label}: ${remaining} remaining (resets ${event.metadata.resetAt ?? "unknown"})`,
    );
  }

  if (DRY_RUN) {
    // Dry-run logs a per-window summary only — never the full event payload.
    log("--dry-run set; not posting. Windows that would be sent:");
    for (const event of result.events) {
      const remaining = event.credits == null ? "not reported" : `${event.credits}%`;
      log(
        `  - ${event.label}: ${remaining} remaining (resets ${event.metadata.resetAt ?? "unknown"})`,
      );
    }
    process.exit(0);
  }

  const ack = await postUsageBatches({
    events: result.events,
    ingestUrl: INGEST_URL,
    ingestToken: token,
    producerId: PRODUCER_ID,
    dryRun: false,
    log,
  });
  log(
    `ingest ack: received=${ack.received} persisted=${ack.persisted} rejected=${ack.rejected}`,
  );
  if (ack.rejected > 0) {
    log(`Ingest reported rejections: ${ack.rejected}`);
    process.exit(1);
  }
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(
      `${LOG_PREFIX} ${error instanceof Error ? error.stack || error.message : String(error)}`,
    );
    process.exit(1);
  });
}

export const MUSE_CODE_PRODUCER_ID = PRODUCER_ID;
export { KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, KEYCHAIN_TIMEOUT_MS, KEY_ENDPOINT, INGEST_URL };