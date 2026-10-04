#!/usr/bin/env node
// Muse subscription usage collector.
//
// Parses `subscription-status status` text (Jay's own Muse / CodeCaps account on
// the hatch VM) and emits two quota windows to Usage Monitor:
//   - free weekly limit (with reset time)
//   - additional tokens balance (no reset reported by the CLI)
//
// Why this runs on the VM via cron, NOT a Mac LaunchAgent:
//   The CLI is not Jay's local OAuth tool; it is the hatch-managed
//   `/opt/hatch/bin/subscription-status` binary, reachable only from this VM.
//   The Mac-side rationale that justifies every other collector in this repo
//   (vendor CLI OAuth local to the laptop) does not apply here.
//
// Usage:
//   node scripts/muse-usage-collector.mjs [--dry-run] [--redacted] [--debug]
//
// Cron row (every 15 minutes, same cadence as the other collectors):
//   */15 * * * * cd <REPO> && /usr/bin/env node scripts/muse-usage-collector.mjs >> ~/.config/muse-usage-collector.log 2>&1
//
// Env:
//   SUBSCRIPTION_STATUS_BIN  Override the binary path (default /opt/hatch/bin/subscription-status).
//   MUSE_INGEST_TOKEN        Per-producer scoped ingest token
//                            (USAGE_INGEST_PRODUCER_TOKENS `muse:` entry).  Falls
//                            back to USAGE_INGEST_TOKEN (unscoped; refused once
//                            USAGE_INGEST_REQUIRE_SCOPED_TOKENS=true).
//   USAGE_MONITOR_INGEST_URL Default https://usage.jays.services/api/ingest/usage.
//
// SECRETS: this script reads the CLI binary's stdout but never logs it raw --
// the resolved percentages, window labels, and ISO reset dates are the only
// numbers that leave the process.  Tokens are loaded from the environment or
// ~/.secrets/global-api-keys via resolveCollectorToken and only used as Bearer
// headers in outbound HTTP requests; the value is never logged.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { MUSE_PRODUCER_ID, postUsageBatches } from "./lib/session-token-collectors.mjs";
import { resolveCollectorToken } from "./lib/run-session-token-collector.mjs";
import { buildQuotaEvent, clampPercent } from "./lib/quota-event.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_BIN = "/opt/hatch/bin/subscription-status";
const INGEST_URL =
  process.env.USAGE_MONITOR_INGEST_URL || "https://usage.jays.services/api/ingest/usage";
const REQUEST_TIMEOUT_MS = 20_000;

const PROVIDER = "muse";
const SERVICE = "muse-cli";
const SOURCE = "subscription-status-cli";

const WEEKLY_BUCKET = "free-weekly";
const ADDITIONAL_BUCKET = "additional-tokens";

const MONTH_INDEX = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

// Fixed UTC offset by US timezone abbreviation.  DST-aware US abbreviations only;
// an unrecognised code returns null from parseMuseResetLine so the script never
// guesses and never throws.
const TZ_OFFSET_HOURS = {
  EST: 5, EDT: 4,
  CST: 6, CDT: 5,
  MST: 7, MDT: 6,
  PST: 8, PDT: 7,
};

function log(message) {
  console.log(`[muse-usage-collector] ${message}`);
}

function monthNameToIndex(name) {
  const key = String(name || "").slice(0, 3).toLowerCase();
  return Object.prototype.hasOwnProperty.call(MONTH_INDEX, key) ? MONTH_INDEX[key] : null;
}

/**
 * Parse a reset line like "Oct 10 at 10:59 PM CDT" into an ISO-8601 UTC instant.
 * Assume the current year; if the resulting instant is already in the past
 * (compared to `now`), roll forward one year.  Returns null on any unparseable
 * shape; never throws.
 */
export function parseMuseResetLine(resetLine, now = new Date()) {
  if (typeof resetLine !== "string") return null;
  const trimmed = resetLine.trim();
  if (!trimmed) return null;
  const tzMatch = /([A-Za-z]{2,4})\s*$/.exec(trimmed);
  if (!tzMatch) return null;
  const tz = tzMatch[1].toUpperCase();
  const offset = TZ_OFFSET_HOURS[tz];
  if (offset == null) return null;
  const localPart = trimmed.slice(0, tzMatch.index).trim().replace(/\s+at\s+/i, " ");
  // "Mon DD" with optional "HH:MM am/pm"
  const m =
    /^([A-Za-z]+)\s+(\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?:\s*(AM|PM|am|pm))?)?$/.exec(localPart);
  if (!m) return null;
  const month = monthNameToIndex(m[1]);
  const day = Number(m[2]);
  if (month == null || !Number.isFinite(day) || day < 1 || day > 31) return null;
  let hour = m[3] != null ? Number(m[3]) : 0;
  const minute = m[4] != null ? Number(m[4]) : 0;
  const ampm = m[5] ? m[5].toUpperCase() : null;
  if (ampm === "PM" && hour < 12) hour += 12;
  if (ampm === "AM" && hour === 12) hour = 0;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  const baseYear = now.getFullYear();
  const buildInstant = (year) => {
    // Wall-clock UTC: the wall-clock time IS the local Chicago time; the UTC
    // instant equals wall + offset (Chicago is behind UTC).
    const utcMs = Date.UTC(year, month, day, hour, minute) + offset * 3600 * 1000;
    return new Date(utcMs);
  };
  let candidate = buildInstant(baseYear);
  // If the reset is more than a day in the past, the CLI is reading the next
  // period that hasn't rolled yet -- bump the year forward.
  if (candidate.getTime() < now.getTime() - 86_400_000) {
    candidate = buildInstant(baseYear + 1);
  }
  return Number.isNaN(candidate.getTime()) ? null : candidate.toISOString();
}

/**
 * Parse one textual block of `subscription-status status` output into a list of
 * quota readings in the Antigravity-compatible shape (credits=remaining,
 * limit=100, bucketId stable, resetAt ISO or null).  Defensive: never throws,
 * returns an empty array for an unrecognisable shape so a future CLI change
 * shows "no quota report yet" rather than a 500.
 *
 * Emits two readings when both blocks are present:
 *   - `free-weekly`: weekly window with a reported reset time
 *   - `additional-tokens`: balance window with no reset, raw "1.9B tokens left"
 *     string preserved in metadata only
 */
export function parseMuseSubscriptionStatus(text, { now = new Date() } = {}) {
  const lines = String(text || "").split(/\r?\n/);
  let planType = null;
  let weeklyUsed = null;
  let weeklyResetLine = null;
  let additionalUsed = null;
  let additionalTokensLeftRaw = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    if (i === 0) {
      // First line: plan-state summary.  The free account prints
      // "The user does not have a subscription."; a paid plan will surface its
      // plan name here.  Keep the literal in metadata so a future shape can
      // round-trip without a code change.
      if (/does not have a subscription/i.test(line)) {
        planType = "free";
      } else {
        planType = line.replace(/[.:]+\s*$/, "").trim() || line;
      }
      continue;
    }
    let m = /^Usage:\s*(\d+(?:\.\d+)?)%\s*of\s*free\s*weekly\s*limit/i.exec(line);
    if (m) {
      weeklyUsed = Number(m[1]);
      continue;
    }
    m = /^Weekly\s+limit\s+resets\s+(.+)$/i.exec(line);
    if (m) {
      weeklyResetLine = m[1].trim();
      continue;
    }
    m = /^Additional\s+tokens:\s*(\d+(?:\.\d+)?)%\s*used(?:\s*\(([^)]+)\))?/i.exec(line);
    if (m) {
      additionalUsed = Number(m[1]);
      additionalTokensLeftRaw = m[2] ? m[2].trim() : null;
      continue;
    }
  }

  const readings = [];
  if (Number.isFinite(weeklyUsed)) {
    const weeklyRemaining = clampPercent(100 - weeklyUsed);
    if (weeklyRemaining != null) {
      readings.push({
        bucketId: WEEKLY_BUCKET,
        label: "Free weekly limit",
        quotaWindow: "weekly",
        remainingPercent: weeklyRemaining,
        usedPercent: clampPercent(weeklyUsed),
        resetAt: parseMuseResetLine(weeklyResetLine, now),
        planType,
        modelId: null,
        remainingUnknown: false,
        isExhausted: weeklyRemaining <= 0,
      });
    }
  }
  if (Number.isFinite(additionalUsed)) {
    const additionalRemaining = clampPercent(100 - additionalUsed);
    if (additionalRemaining != null) {
      readings.push({
        bucketId: ADDITIONAL_BUCKET,
        label: "Additional tokens",
        quotaWindow: "balance",
        remainingPercent: additionalRemaining,
        usedPercent: clampPercent(additionalUsed),
        resetAt: null,
        planType,
        modelId: null,
        remainingUnknown: false,
        isExhausted: additionalRemaining <= 0,
        ...(additionalTokensLeftRaw
          ? { metadataExtras: { tokensLeftLabel: additionalTokensLeftRaw } }
          : {}),
      });
    }
  }
  return readings;
}

/** Convert readings into ingest-ready v2 quota events. */
export function quotaEventsFromMuse(
  text,
  { now = new Date(), occurredAtIso = now.toISOString() } = {},
) {
  const readings = parseMuseSubscriptionStatus(text, { now });
  return readings.map((reading) =>
    buildQuotaEvent({
      provider: PROVIDER,
      service: SERVICE,
      reading,
      source: SOURCE,
      occurredAtIso,
    }),
  );
}

export function parseArgs(argv) {
  return {
    dryRun: argv.includes("--dry-run"),
    redacted: argv.includes("--redacted"),
    debug: argv.includes("--debug"),
  };
}

async function runSubscriptionStatus({ bin, env, debug }) {
  const { stdout } = await execFileAsync(bin, ["status"], {
    env: { ...env, NO_COLOR: "1", LANG: "C.UTF-8" },
    encoding: "utf8",
    timeout: REQUEST_TIMEOUT_MS,
    maxBuffer: 256 * 1024,
  });
  if (debug) {
    // Length only -- never log the raw output, it can carry account markers.
    log(`stdout ${stdout.length} chars (raw output redacted)`);
  }
  return String(stdout || "");
}

function summarise(events, { redacted }) {
  for (const event of events) {
    const remaining = event.credits == null ? "not reported" : `${event.credits}%`;
    const reset = event.metadata?.resetAt ?? "unknown";
    log(
      `${event.provider} | ${event.label} | remaining ${remaining} | resets ${reset} | plan ${event.metadata?.planType ?? "unknown"}`,
    );
  }
  if (!redacted) {
    // These events only carry derived numbers, labels, ISO dates, and the
    // optional `tokensLeftLabel` metadata string.  No account id is exposed.
    log(`events: ${JSON.stringify(events)}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const bin = process.env.SUBSCRIPTION_STATUS_BIN?.trim() || DEFAULT_BIN;
  const text = await runSubscriptionStatus({ bin, env: process.env, debug: args.debug });
  const events = quotaEventsFromMuse(text, { now: new Date() });
  log(`parsed ${events.length} quota event(s) from ${bin}`);
  if (events.length === 0) {
    log("no quota windows found; exiting without an ingest call");
    return;
  }
  summarise(events, { redacted: args.redacted });
  const token = resolveCollectorToken(["MUSE_INGEST_TOKEN", "USAGE_INGEST_TOKEN"]);
  const ack = await postUsageBatches({
    events,
    ingestUrl: INGEST_URL,
    ingestToken: token,
    producerId: MUSE_PRODUCER_ID,
    dryRun: args.dryRun,
    log,
  });
  log(
    `ingest ack: ${JSON.stringify({
      received: ack.received,
      persisted: ack.persisted,
      rejected: ack.rejected,
      dryRun: ack.dryRun ?? false,
    })}`,
  );
  if (ack.rejected > 0) {
    throw new Error(`Ingest reported rejections: ${ack.rejected}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[muse-usage-collector] ${message}`);
    process.exit(1);
  });
}