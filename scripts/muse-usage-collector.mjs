#!/usr/bin/env node
// Muse subscription usage collector.
//
// Parses the provider status CLI text (Jay's own Muse / CodeCaps account on
// the collector VM) and emits two quota windows to Usage Monitor:
//   - free weekly limit (with reset time)
//   - additional tokens balance (no reset reported by the CLI)
//
// Why this runs on the collector VM via cron, NOT a Mac LaunchAgent:
//   The CLI is not Jay's local OAuth tool; it is the provider-managed
//   `subscription-status` binary, reachable only from the collector VM.
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
//   SUBSCRIPTION_STATUS_BIN  REQUIRED: absolute path to the provider status CLI
//                            binary; supplied by the runtime environment (the
//                            private operations inventory holds the value).
//                            No default -- the script fails fast without it.
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
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

import { MUSE_PRODUCER_ID, postUsageBatches } from "./lib/session-token-collectors.mjs";
import { resolveCollectorToken } from "./lib/run-session-token-collector.mjs";
import { buildQuotaEvent, clampPercent } from "./lib/quota-event.mjs";

const execFileAsync = promisify(execFile);
const INGEST_URL =
  process.env.USAGE_MONITOR_INGEST_URL || "https://usage.jays.services/api/ingest/usage";
const REQUEST_TIMEOUT_MS = 20_000;

const PROVIDER = "muse";
const SERVICE = "muse-cli";
const SOURCE = "subscription-status-cli";

// Namespaced bucket ids (T12): every other subscription-quota producer keys on
// `<provider>:<...>` already, so bare ids would risk silent cross-provider
// series collisions in `projectQuotaWindows`.  Display labels stay generic.
const WEEKLY_BUCKET = "muse:free-weekly";
const ADDITIONAL_BUCKET = "muse:additional-tokens";

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

// Trust boundary for readings emitted by parseMuseSubscriptionStatus (T7/T8).
// Strict: unknown fields, out-of-range percentages, or unrecognised bucket ids
// fail validation rather than ride along in metadata.  `metadataExtras` is
// optional but, when present, must be the exact {tokensLeftLabel} shape we
// mint; new keys require a schema bump.
const MuseReadingSchema = z
  .object({
    bucketId: z.enum([WEEKLY_BUCKET, ADDITIONAL_BUCKET]),
    label: z.string().min(1).max(120),
    quotaWindow: z.enum(["weekly", "balance"]),
    remainingPercent: z.number().min(0).max(100),
    usedPercent: z.number().min(0).max(100),
    resetAt: z.iso.datetime().nullable(),
    planType: z.string().min(1).max(200).nullable(),
    modelId: z.null(),
    remainingUnknown: z.boolean(),
    isExhausted: z.boolean(),
    metadataExtras: z
      .object({ tokensLeftLabel: z.string().min(1).max(80) })
      .strict()
      .optional(),
  })
  .strict();

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
 * Parse one textual block of the provider status CLI output into a list of
 * quota readings in the Antigravity-compatible shape (credits=remaining,
 * limit=100, bucketId stable, resetAt ISO or null).  Defensive: never throws,
 * returns an empty array for an unrecognisable shape so a future CLI change
 * shows "no quota report yet" rather than a 500.
 *
 * Emits two readings when both blocks are present:
 *   - `muse:free-weekly`: weekly window with a reported reset time
 *   - `muse:additional-tokens`: balance window with no reset, raw "1.9B tokens left"
 *     string preserved in metadata only
 *
 * Plan-line detection runs AFTER the three data-line patterns on every line
 * (T13): the first non-empty line that matches NONE of them is the plan line.
 * That keeps a leading blank line, or a future CLI shape that puts data first,
 * from causing a data line to be swallowed as planType.
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

    // Data-line patterns FIRST.  A data line appearing before the plan line
    // must be parsed as data, never swallowed as planType.
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

    // First non-empty line that matches NO data pattern is the plan line.
    // Only the FIRST such line becomes planType; later plan-shaped lines
    // (none in the current CLI) would be ignored.
    if (planType == null) {
      if (/does not have a subscription/i.test(line)) {
        planType = "free";
      } else {
        planType = line.replace(/[.:]+\s*$/, "").trim() || line;
      }
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

/**
 * Convert CLI text into ingest-ready v2 quota events.  Validates each reading
 * against the Zod trust boundary (T7/T8); any failure throws the stable
 * `muse reading validation failed` error which the run loop classifies as
 * `collect` and surfaces without leaking the raw error text.
 *
 * Empty/garbage CLI shapes never reach the validator -- parseMuseSubscriptionStatus
 * already returns [] for them, so the function returns [] without throwing.
 */
export function quotaEventsFromMuse(
  text,
  { now = new Date(), occurredAtIso = now.toISOString() } = {},
) {
  const readings = parseMuseSubscriptionStatus(text, { now });
  return validateAndBuildEvents(readings, { occurredAtIso });
}

/** Validate readings against the Zod trust boundary and emit v2 quota events;
 *  exported so unit tests can drive invalid readings directly. */
export function validateAndBuildEvents(readings, { occurredAtIso } = {}) {
  const occurred = occurredAtIso ?? new Date().toISOString();
  const events = [];
  for (const reading of readings) {
    const result = MuseReadingSchema.safeParse(reading);
    if (!result.success) {
      throw new Error("muse reading validation failed");
    }
    events.push(
      buildQuotaEvent({
        provider: PROVIDER,
        service: SERVICE,
        reading: result.data,
        source: SOURCE,
        occurredAtIso: occurred,
      }),
    );
  }
  return events;
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
  // --redacted suppresses the per-event lines; the count is already logged by
  // main() before this is called.  Plan and metadata extras are never logged
  // in any mode -- they are account-derived or CLI-shape noise (T5/T9/T10).
  if (redacted) return;
  for (const event of events) {
    const remaining = event.credits == null ? "not reported" : `${event.credits}%`;
    const reset = event.metadata?.resetAt ?? "unknown";
    log(
      `${event.provider} | ${event.label} | remaining ${remaining} | resets ${reset}`,
    );
  }
}

// Material-change snapshot (T11): ~/.cache/usage-monitor/collector-state/muse.json.
// Same root and naming convention as collectorStatePath in
// scripts/lib/run-session-token-collector.mjs.  Read defensively (missing or
// corrupt file means "no prior state"); write atomically tmp+rename at 0o600.
function collectorSnapshotPath({ stateRoot } = {}) {
  const root = stateRoot ?? join(homedir(), ".cache", "usage-monitor", "collector-state");
  return join(root, `${PROVIDER}.json`);
}

function bucketEntriesFromEvents(events) {
  const entries = {};
  for (const event of events) {
    const bucketId = event?.metadata?.bucketId;
    if (typeof bucketId !== "string" || !bucketId) continue;
    entries[bucketId] = {
      credits: event.credits ?? null,
      resetAt: event.metadata?.resetAt ?? null,
      planType: event.metadata?.planType ?? null,
    };
  }
  return entries;
}

/** Build the next snapshot from a list of validated events. */
export function snapshotFromEvents(events, { now = new Date() } = {}) {
  return {
    version: 1,
    producerId: PROVIDER,
    at: now.toISOString(),
    buckets: bucketEntriesFromEvents(events),
  };
}

/** True when the events' per-bucket credits/resetAt/planType differ from the snapshot.
 *  A missing or wrong-producer snapshot counts as "no prior state" -> changed. */
export function readingsChanged(events, snapshot) {
  const next = bucketEntriesFromEvents(events);
  if (
    !snapshot ||
    typeof snapshot !== "object" ||
    snapshot.producerId !== PROVIDER ||
    !snapshot.buckets ||
    typeof snapshot.buckets !== "object"
  ) {
    return Object.keys(next).length > 0;
  }
  const prev = snapshot.buckets;
  const bucketIds = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const bucketId of bucketIds) {
    const a = prev[bucketId];
    const b = next[bucketId];
    if (!a || !b) return true;
    if (a.credits !== b.credits) return true;
    if ((a.resetAt ?? null) !== (b.resetAt ?? null)) return true;
    if ((a.planType ?? null) !== (b.planType ?? null)) return true;
  }
  return false;
}

async function readCollectorSnapshot({ stateRoot } = {}) {
  try {
    const raw = await readFile(collectorSnapshotPath({ stateRoot }), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    // Missing or corrupt state means "no prior state".
    return null;
  }
}

async function writeCollectorSnapshot(snapshot, { stateRoot } = {}) {
  const path = collectorSnapshotPath({ stateRoot });
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
  await rename(tempPath, path);
}

/** Sentinel error carrying the failure stage; the run-loop catch prints the
 *  stable category `[muse-usage-collector] collector failed (stage=<stage>)`
 *  and never prints error.message (T4).  Internal sentinel only. */
class CollectorError extends Error {
  constructor(stage) {
    super(`stage=${stage}`);
    this.name = "CollectorError";
    this.stage = stage;
  }
}

async function runCollectStage(fn) {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof CollectorError) throw error;
    throw new CollectorError("collect");
  }
}

async function runIngestStage(fn) {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof CollectorError) throw error;
    throw new CollectorError("ingest");
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // STAGE: config -- missing SUBSCRIPTION_STATUS_BIN is a fast-fail; no other
  // work runs before the env var is supplied by the runtime.
  const bin = process.env.SUBSCRIPTION_STATUS_BIN?.trim();
  if (!bin) throw new CollectorError("config");

  // STAGE: collect -- CLI exec and reading validation.
  const text = await runSubscriptionStatus({ bin, env: process.env, debug: args.debug });
  const events = await runCollectStage(() =>
    quotaEventsFromMuse(text, { now: new Date() }),
  );
  log(`parsed ${events.length} quota event(s)`);
  if (events.length === 0) {
    // Stay BEFORE all snapshot logic; missing data must not touch state and
    // must not trigger a no-change log line.
    log("no quota windows found; exiting without an ingest call");
    return;
  }

  // Material-change gate: skip the ingest call and snapshot write entirely
  // when the per-bucket credits/resetAt/planType are identical to the last
  // successful post.  buildQuotaEvent salts eventId with occurredAtIso, so
  // an unconditional post would write 2 rows every 15-min tick and saturate
  // the read window in src/app/api/quota-windows/route.ts.
  const snapshot = await readCollectorSnapshot();
  if (!readingsChanged(events, snapshot)) {
    log("no material change since last post; skipping ingest");
    return 0;
  }

  summarise(events, { redacted: args.redacted });

  // STAGE: ingest -- token resolution + postUsageBatches.
  const token = resolveCollectorToken(["MUSE_INGEST_TOKEN", "USAGE_INGEST_TOKEN"]);
  const ack = await runIngestStage(() =>
    postUsageBatches({
      events,
      ingestUrl: INGEST_URL,
      ingestToken: token,
      producerId: MUSE_PRODUCER_ID,
      dryRun: args.dryRun,
      log,
    }),
  );
  log(
    `ingest ack: ${JSON.stringify({
      received: ack.received,
      persisted: ack.persisted,
      rejected: ack.rejected,
      dryRun: ack.dryRun ?? false,
    })}`,
  );
  if (ack.rejected > 0) {
    throw new CollectorError("ingest");
  }

  // --dry-run must NEVER write the snapshot (a dry run must never suppress
  // a later real post).  Successful real post writes the new snapshot.
  if (!args.dryRun) {
    await writeCollectorSnapshot(snapshotFromEvents(events));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    let stage = "collect";
    if (error instanceof CollectorError) {
      stage = error.stage;
    }
    console.error(`[muse-usage-collector] collector failed (stage=${stage})`);
    process.exit(1);
  });
}
