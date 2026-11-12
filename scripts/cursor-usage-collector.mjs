#!/usr/bin/env node
// Cursor Admin API producer for Usage Monitor.
//
// Reads Cursor's official Admin API (team plan) and ships it to UM in the
// shared v2 usage-telemetry contract:
//
//   POST /teams/daily-usage-data   one row per day per user  -> metricType "usage"
//   POST /teams/spend               one row per member/cycle -> metricType "cost"
//   POST /teams/filtered-usage-events  read for coverage only (see below)
//
// The usage endpoints are POST, not GET; GET on the same paths 404s.  The
// daily-usage window is capped at 30 days server side, so the collector
// clamps the window and retries a 400 instead of failing.
//
// Only SETTLED periods are published.  The daily row for a day that is not
// over yet keeps growing, and the spend endpoint reports a cycle-to-date
// total for the month its window names, so both are running totals.
// Usage Monitor stores a row under a stable event id and answers HTTP 409
// when a later replay carries different content, so publishing a running
// total would freeze the stored row at its first value.  A day is published
// once it has been over for a full day, and a month once the month after it
// has begun and a day has passed.  The spend endpoint also answers HTTP 400
// unless startDate is the first of a month ("startDate must align with the
// start of a month"), so the closed months are read one at a time.
//
// The per-event feed is read but NOT mapped: it is empty on this account and
// its billed cents belong to UM's server-side Cursor poller
// (src/lib/cursor-admin-poller.ts), so mapping it here would double count
// cash.
//
// Usage:
//   node scripts/cursor-usage-collector.mjs [--dry-run] [--debug] [--days N] [--end YYYY-MM-DD]
//
// Env:
//   CURSOR_ADMIN_API_KEY   Cursor Admin API key.  Read from the environment
//                           first, then from Infisical through `fleet-secrets
//                           get CURSOR_ADMIN_API_KEY`.  Never logged, never
//                           written to disk, never put on a command line.
//   USAGE_INGEST_TOKEN     UM ingest token.  Same env-then-fleet-secrets
//                           resolution.  Read from the environment first, then
//                           from Infisical.
//   USAGE_MONITOR_INGEST_URL  full ingest URL
//                           (default https://usage.jays.services/api/ingest/usage)
//   USAGE_MONITOR_BASE_URL    base URL (default https://usage.jays.services);
//                           the ingest path is appended to it.
//
// SECRETS: the only credential-derived value that ever leaves this process is
// the bearer token in an HTTP header.  Raw Admin API response bodies are
// never printed, because they carry account ids and member emails.

import { pathToFileURL } from "node:url";

import { postUsageBatches } from "./lib/session-token-collectors.mjs";
import { resolveCollectorToken } from "./lib/run-session-token-collector.mjs";
import { fleetSecretsGet } from "./lib/fleet-secrets.mjs";
import {
  CURSOR_ADMIN_MAX_WINDOW_DAYS,
  CURSOR_ADMIN_PRODUCER_ID,
  normalizeWindow,
  runCursorCollector,
} from "./lib/cursor-admin-telemetry.mjs";

const DEFAULT_INGEST_BASE_URL = "https://usage.jays.services";

function log(message) {
  console.log(`[cursor-usage-collector] ${message}`);
}

function fail(message, code = 1) {
  console.error(`[cursor-usage-collector] ${message}`);
  process.exit(code);
}

/** The ingest URL, from a full URL or from a base URL. */
export function ingestUrl(env = process.env) {
  const full = env.USAGE_MONITOR_INGEST_URL?.trim();
  if (full) return full;
  const base = env.USAGE_MONITOR_BASE_URL?.trim() || DEFAULT_INGEST_BASE_URL;
  return `${base.replace(/\/+$/, "")}/api/ingest/usage`;
}

/** The Cursor Admin API key: environment first, then Infisical. */
export function resolveCursorAdminApiKey(env = process.env) {
  const fromEnv = env.CURSOR_ADMIN_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const fromInfisical = fleetSecretsGet("CURSOR_ADMIN_API_KEY");
  return typeof fromInfisical === "string" ? fromInfisical.trim() : null;
}

/** Parse the CLI flags.  No secret ever arrives through argv. */
export function parseCursorCollectorArgs(argv, now = new Date()) {
  const dryRun = argv.includes("--dry-run");
  const debug = argv.includes("--debug");
  let days = CURSOR_ADMIN_MAX_WINDOW_DAYS;
  let end = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--days" && argv[i + 1]) {
      const parsed = Number.parseInt(argv[i + 1], 10);
      if (Number.isFinite(parsed) && parsed > 0) days = parsed;
    }
    if (argv[i] === "--end" && argv[i + 1]) {
      end = argv[i + 1].trim();
    }
  }
  return { dryRun, debug, days, endDate: end };
}

/** The requested window, clamped to the API's 30-day cap. */
export function resolveWindow({ days = CURSOR_ADMIN_MAX_WINDOW_DAYS, endDate = null, now = new Date() } = {}) {
  const end = endDate ? new Date(`${endDate}T00:00:00.000Z`) : now;
  if (Number.isNaN(end.getTime())) {
    throw new Error(`Invalid --end ${endDate}`);
  }
  const span = Number.isFinite(days) && days > 0 ? Math.floor(days) : 1;
  const start = new Date(end.getTime() - (span - 1) * 86_400_000);
  return normalizeWindow({ startDate: start, endDate: end });
}

async function main() {
  let args;
  try {
    args = parseCursorCollectorArgs(process.argv);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  let window;
  try {
    window = resolveWindow(args);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (window.clamped) {
    log(
      `requested ${window.requestedDays} day(s); the Admin API caps a window at ${CURSOR_ADMIN_MAX_WINDOW_DAYS} days, using ${window.startDate}..${window.endDate}`,
    );
  }
  const apiKey = resolveCursorAdminApiKey();
  if (!apiKey) {
    if (args.dryRun) {
      log("no CURSOR_ADMIN_API_KEY available; nothing to read");
      return;
    }
    fail("CURSOR_ADMIN_API_KEY is required");
  }
  const ingestToken = args.dryRun
    ? null
    : resolveCollectorToken(["CURSOR_ADMIN_INGEST_TOKEN", "USAGE_INGEST_TOKEN"]);
  if (!args.dryRun && !ingestToken) {
    fail("USAGE_INGEST_TOKEN is required");
  }
  const url = ingestUrl();
  const post = async ({ events }) =>
    postUsageBatches({
      events,
      ingestUrl: url,
      ingestToken,
      producerId: CURSOR_ADMIN_PRODUCER_ID,
      dryRun: false,
      log,
    });
  let result;
  const now = Date.now();
  try {
    result = await runCursorCollector({
      dryRun: args.dryRun,
      window,
      now,
      apiKey,
      post,
      // Retry and feed messages carry a path and a status only; no body, no
      // key, no account id.
      log,
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  log(
    `window ${window.startDate}..${window.endDate}: ${result.usageEvents.length} usage event(s), ${result.spendEvents.length} spend event(s)`,
  );
  if (args.debug) {
    // Counts and the cycle start only; no row content, no member identity.
    log(`debug: ${JSON.stringify(result.stats)}`);
  }
  if (args.dryRun) {
    log("dry run: nothing was sent to Usage Monitor");
    return;
  }
  if (result.usageAck) {
    log(
      `usage ingest ack: ${JSON.stringify({ received: result.usageAck.received, persisted: result.usageAck.persisted, rejected: result.usageAck.rejected, conflicted: result.usageAck.conflicted ?? 0 })}`,
    );
    if (result.usageAck.rejected > 0) fail(`Ingest reported rejections: ${result.usageAck.rejected}`);
  }
  if (result.spendAck) {
    log(
      `spend ingest ack: ${JSON.stringify({ received: result.spendAck.received, persisted: result.spendAck.persisted, rejected: result.spendAck.rejected, conflicted: result.spendAck.conflicted ?? 0 })}`,
    );
    if (result.spendAck.rejected > 0) fail(`Ingest reported rejections: ${result.spendAck.rejected}`);
  }
  if (result.usageEvents.length === 0 && result.spendEvents.length === 0) {
    log("nothing to send");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
}
