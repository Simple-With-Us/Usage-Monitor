#!/usr/bin/env node
// Local collector for Anthropic Claude Code session JSONL.
//
// Reads ${CLAUDE_HOME:-~/.claude}/projects/*/*.jsonl.
// Extracts exact model, input_tokens, output_tokens, cache_read, cache_creation,
// thinking tokens, and speed tier.
// Pushes estimated token events to Usage Monitor ingest. Not a billing API. Not cash.
//
// WHY THIS EXISTS (UM-1636, 2026-10-25): Claude Code's own OTLP exporter
// stopped emitting claude_code.token.usage, claude_code.cost.usage and the
// claude_code.api_request log event on 2026-10-23, while the model-less
// session.count and active_time.total metrics kept arriving.  A canary
// payload POSTed to production was accepted and persisted, so the receiver
// was healthy and the exporter was the side that stopped.  The transcripts
// carry the same usage per request, so they are the exact source that is
// still available.
//
// DOUBLE COUNTING: the native OTLP path and this collector describe the same
// calls, and their idempotency keys do not collide (one is the shared v2
// eventId hash, the other an OTLP attribute hash).  The receiver therefore
// applies a native-preference rule: a transcript event is dropped when the
// native feed delivered a token row close enough in time to have covered it
// (src/lib/native-telemetry-coverage.ts).  Every event this collector sends
// carries metadata.collector="transcript" so that rule can tell the two
// feeds apart, and so the ledger can show which feed produced a row.
//
// Usage:
//   node scripts/claude-usage-collector.mjs [--dry-run] [--debug] [--days N] [--since ISO]
//
// Env:
//   USAGE_INGEST_TOKEN or CLAUDE_INGEST_TOKEN
//   USAGE_MONITOR_INGEST_URL (required; the deployment's ingest endpoint)
//   CLAUDE_HOME (default ~/.claude)

import { hostname } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  CLAUDE_PRODUCER_ID,
  filterEventsSince,
  parseClaudeSessionJsonl,
  postUsageBatches,
} from "./lib/session-token-collectors.mjs";
import {
  canAdvanceCollectorCheckpoint,
  expandHome,
  fileMayContainEventsSince,
  isBotFleetSessionPath,
  readIfFresh,
  recordCollectorSuccess,
  resolveCollectorArgs,
  resolveCollectorToken,
  sessionKeyFor,
  walkFiles,
} from "./lib/run-session-token-collector.mjs";

const DRY = process.argv.includes("--dry-run");
const DEBUG = process.argv.includes("--debug");
const PRODUCER_ID = process.env.CLAUDE_PRODUCER_ID || CLAUDE_PRODUCER_ID;
// The ingest endpoint is deployment-specific, so it is never hardcoded here:
// the operator supplies it (the Mac's LaunchAgent and the server's runner
// both set it), and a missing value fails loudly inside main() instead of
// quietly pointing at one deployment.  A dry run never needs it.
function resolveIngestUrl(env = process.env) {
  const url = env.USAGE_MONITOR_INGEST_URL?.trim();
  if (!url) {
    throw new Error(
      "USAGE_MONITOR_INGEST_URL is not set; refusing to guess an ingest endpoint."
    );
  }
  return url;
}

/** Marks these rows as coming from the local transcript feed. */
export const TRANSCRIPT_COLLECTOR_MARKER = "transcript";

/**
 * Bootstrap lookback for the first pass, in days.
 *
 * The Mac holds 4,000+ transcript files (3+ GB); a 180 day default would read
 * all of them on the first run.  Three days covers the native-outage window
 * (the native feed stopped on 2026-10-23) and the period after it, and older
 * usage is either covered by the native feed or can be pulled on purpose with
 * `--days N`.
 */
export const DEFAULT_CLAUDE_LOOKBACK_DAYS = 3;

/**
 * Replay overlap in minutes.
 *
 * The shared default is 24 hours, which is right for the small session
 * collectors but wrong here: the Mac's transcripts carry tens of thousands of
 * token events a day, so re-sending a whole day on every 15-minute pass would
 * put that many duplicate rows through the ingest path every time.  A
 * transcript is written seconds after the request it describes, so an hour of
 * overlap is a wide margin for a late write.
 */
export const CLAUDE_STATE_OVERLAP_MINUTES = 60;

function log(message) {
  console.log(`[claude-usage-collector] ${message}`);
}

function fail(message, code = 1) {
  console.error(`[claude-usage-collector] ${message}`);
  process.exit(code);
}

export async function collectClaudeEvents({
  claudeHome = expandHome(process.env.CLAUDE_HOME || join(homedir(), ".claude")),
  since,
  scanStatus,
} = {}) {
  const markIncomplete = () => {
    if (scanStatus) scanStatus.complete = false;
  };
  const projectsDir = join(claudeHome, "projects");
  const files = await walkFiles(projectsDir, { suffix: ".jsonl", onTraversalError: markIncomplete });
  const events = [];
  for (const file of files) {
    // BotFleet owns its child-turn usage under producer `botfleet`, and ingest
    // idempotency is producer-scoped, so those sessions must not be sent here.
    if (isBotFleetSessionPath(file)) continue;
    if (!(await fileMayContainEventsSince(file, since, { onStatError: markIncomplete }))) continue;
    const text = await readIfFresh(file, { onReadError: markIncomplete });
    if (!text) continue;
    const parsed = parseClaudeSessionJsonl(text, {
      sessionKey: sessionKeyFor(claudeHome, file),
      extraMetadata: {
        collector: TRANSCRIPT_COLLECTOR_MARKER,
        // The machine identity, so the receiver can tell this machine's
        // transcript rows from another machine's native OTLP rows.
        "host.name": hostname(),
      },
    });
    events.push(...filterEventsSince(parsed, since));
  }
  return events;
}

async function main() {
  const passStartedAt = new Date();
  let args;
  try {
    args = await resolveCollectorArgs(process.argv, PRODUCER_ID, {
      now: passStartedAt,
      defaultLookbackDays: DEFAULT_CLAUDE_LOOKBACK_DAYS,
      stateOverlapMinutes: CLAUDE_STATE_OVERLAP_MINUTES,
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const scanStatus = { complete: true };
  const events = await collectClaudeEvents({ since: args.since, scanStatus });
  log(
    `parsed ${events.length} token event(s) since ${args.since.toISOString()}${
      args.resumedFromState ? " (incremental)" : ""
    }`
  );
  if (DEBUG) {
    const models = new Set(events.map((e) => e.producerKeyRef).filter(Boolean));
    log(`models: ${[...models].join(", ") || "(none)"}`);
  }
  if (events.length === 0) {
    log("nothing to send");
    if (!DRY && canAdvanceCollectorCheckpoint(args, { scanComplete: scanStatus.complete })) {
      await recordCollectorSuccess(PRODUCER_ID, passStartedAt);
    }
    return;
  }
  const token = resolveCollectorToken(["CLAUDE_INGEST_TOKEN", "USAGE_INGEST_TOKEN"]);
  let ingestUrl;
  try {
    ingestUrl = resolveIngestUrl();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  try {
    const ack = await postUsageBatches({
      events,
      ingestUrl,
      ingestToken: token,
      producerId: PRODUCER_ID,
      dryRun: DRY || args.dryRun,
      log,
    });
    log(
      `ingest ack: ${JSON.stringify({
        received: ack.received,
        persisted: ack.persisted,
        duplicates: ack.duplicates ?? 0,
        rejected: ack.rejected,
        dryRun: ack.dryRun ?? false,
      })}`
    );
    if (ack.rejected > 0) fail(`Ingest reported rejections: ${ack.rejected}`);
    if (!DRY && canAdvanceCollectorCheckpoint(args, { scanComplete: scanStatus.complete })) {
      await recordCollectorSuccess(PRODUCER_ID, passStartedAt);
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
}
