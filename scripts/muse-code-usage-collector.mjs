#!/usr/bin/env node
// Mac-side quota collector for Meta's Muse Code (NOT Anthropic's Muse CLI,
// NOT MiniMax's mcode).  It reads MUSE_CODE_ACCESS_TOKEN injected into the
// process by the scoped Usage Monitor Infisical binding, POSTs to Meta's
// /muse-code/key endpoint, then emits 5h rolling + weekly quota windows.  The
// collector does not read Keychain or refresh credentials.  It never logs,
// persists, or echoes the access token, and never logs Meta's response body
// (which carries the API key id, plan, and account email).  Redirects are treated as errors.  Invocation:
//
// Usage:
//   node scripts/muse-code-usage-collector.mjs [--dry-run] [--debug]
//
// Env:
//   MUSE_CODE_ACCESS_TOKEN - Meta OAuth access token, injected by Infisical.
//   MUSE_CODE_INGEST_TOKEN - per-producer scoped token, injected by Infisical.
//   USAGE_INGEST_TOKEN - optional compatibility name, also environment-only.
//   USAGE_MONITOR_INGEST_URL - defaults to https://usage.jays.services/api/ingest/usage

import { pathToFileURL } from "node:url";

import { postUsageBatches } from "./lib/session-token-collectors.mjs";
import { buildQuotaEvent, clampPercent, toIsoTimestamp } from "./lib/quota-event.mjs";

const PRODUCER_ID = "muse-code";
const PROVIDER = "muse-code";
const SERVICE = "muse-code";

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

/** Resolve the scoped Meta access token injected by the Infisical runner. */
export function resolveMuseCodeAccessToken(env = process.env) {
  const token = env.MUSE_CODE_ACCESS_TOKEN;
  return typeof token === "string" && token.trim() ? token.trim() : null;
}

/** Resolve only ingest tokens injected into this collector's environment. */
export function resolveMuseCodeIngestToken(env = process.env) {
  for (const name of ["MUSE_CODE_INGEST_TOKEN", "USAGE_INGEST_TOKEN"]) {
    const token = env[name];
    if (typeof token === "string" && token.trim()) return token.trim();
  }
  return null;
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
  // Pass the payload's own tier marker through (kody re-review): the guard
  // above rejects only strict `false`, so a missing field must NOT be
  // recorded as `true` in metadata.  `undefined` drops out on JSON
  // serialization, which is the honest representation of "unknown".
  const subsActive = payload.is_subs_active;

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
        // /muse-code/key payload exposes is is_subs_active.  We pass the
        // payload's own value through metadataExtras so buildQuotaEvent
        // surfaces it as the canonical tier marker on every event; a missing
        // field stays missing rather than being recorded as true.
        // planType stays null: the payload does not name a tier.  No
        // bonus-credits field exists on the payload, so we do not invent one.
        metadataExtras: { is_subs_active: subsActive },
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
        metadataExtras: { is_subs_active: subsActive },
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
    if (response.status === 401 || response.status === 403) {
      const error = new Error(`authorization required from api.meta.ai (HTTP ${response.status})`);
      error.code = "MUSE_CODE_AUTH_REQUIRED";
      throw error;
    }
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
  accessToken = resolveMuseCodeAccessToken(),
  fetchImpl,
  now = new Date(),
} = {}) {
  if (!accessToken) {
    return { provider: PROVIDER, status: "skipped", reason: "access-token-missing", events: [] };
  }
  let payload;
  try {
    payload = await fetchMuseCodeKey(accessToken, { fetchImpl });
  } catch (error) {
    if (error?.code === "MUSE_CODE_AUTH_REQUIRED") {
      return { provider: PROVIDER, status: "skipped", reason: "access-token-rejected", events: [] };
    }
    throw error;
  }
  if (DEBUG) debugLog("fetched /muse-code/key payload (keys omitted)");
  const events = quotaEventsFromMuseCode(payload, now);
  return {
    provider: PROVIDER,
    status: events.length === 0 ? "skipped" : "ok",
    events,
  };
}

async function main() {
  const accessToken = resolveMuseCodeAccessToken();
  if (!accessToken) {
    log("skipped (MUSE_CODE_ACCESS_TOKEN is unavailable from the configured Infisical source)");
    process.exit(0);
  }

  const token = resolveMuseCodeIngestToken();
  if (!token && !DRY_RUN) {
    log(
      "Missing MUSE_CODE_INGEST_TOKEN or USAGE_INGEST_TOKEN from the configured Infisical source.",
    );
    process.exit(1);
  }

  let result;
  try {
    result = await collectMuseCode({ accessToken });
  } catch (error) {
    log(`FAILED (${error instanceof Error ? error.message : String(error)})`);
    // Network and non-auth API failures remain operator-visible so launchd
    // retries on its next 15-minute tick.  Missing/rejected auth is skipped
    // above and does not post an empty batch or clear prior readings.
    process.exit(1);
  }

  if (result.status === "skipped") {
    if (result.reason === "access-token-missing") {
      log("skipped (MUSE_CODE_ACCESS_TOKEN is unavailable from the configured Infisical source)");
    } else if (result.reason === "access-token-rejected") {
      log("skipped (Meta rejected MUSE_CODE_ACCESS_TOKEN; update the scoped Infisical secret)");
    } else {
      log(result.events.length === 0 ? "skipped (inactive subscription or no quota windows)" : "skipped");
    }
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
export { KEY_ENDPOINT, INGEST_URL };