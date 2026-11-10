#!/usr/bin/env node
// Local collector for GitHub Copilot CLI session JSONL.
//
// Reads ~/.copilot/session-state/*/events.jsonl session.shutdown
// modelMetrics (same layout as ccusage). Pushes estimated token events to
// Usage Monitor ingest. Not GitHub org billing. Not cash. Does not open
// ~/.copilot/data.db (that SQLite file holds GitHub tokens).
//
// Usage:
//   node scripts/copilot-usage-collector.mjs [--dry-run] [--debug] [--days N] [--since ISO]
//
// Env:
//   USAGE_INGEST_TOKEN or COPILOT_INGEST_TOKEN
//   USAGE_MONITOR_INGEST_URL (default https://usage.jays.services/api/ingest/usage)
//   COPILOT_HOME (default ~/.copilot)

import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  COPILOT_PRODUCER_ID,
  filterEventsSince,
  parseCopilotEventsJsonl,
  postUsageBatches,
} from "./lib/session-token-collectors.mjs";
import {
  canAdvanceCollectorCheckpoint,
  expandHome,
  fileMayContainEventsSince,
  readIfFresh,
  recordCollectorSuccess,
  resolveCollectorArgs,
  resolveCollectorToken,
  sessionKeyFor,
  walkFiles,
} from "./lib/run-session-token-collector.mjs";

const DRY = process.argv.includes("--dry-run");
const DEBUG = process.argv.includes("--debug");
const PRODUCER_ID = process.env.COPILOT_PRODUCER_ID || COPILOT_PRODUCER_ID;
const INGEST_URL =
  process.env.USAGE_MONITOR_INGEST_URL ||
  "https://usage.jays.services/api/ingest/usage";

function log(message) {
  console.log(`[copilot-usage-collector] ${message}`);
}

function fail(message, code = 1) {
  console.error(`[copilot-usage-collector] ${message}`);
  process.exit(code);
}

export async function collectCopilotEvents({
  copilotHome = expandHome(process.env.COPILOT_HOME || join(homedir(), ".copilot")),
  since,
  scanStatus,
} = {}) {
  const markIncomplete = () => {
    if (scanStatus) scanStatus.complete = false;
  };
  const root = join(copilotHome, "session-state");
  const files = await walkFiles(root, { name: "events.jsonl", onTraversalError: markIncomplete });
  const events = [];
  for (const file of files) {
    if (!(await fileMayContainEventsSince(file, since, { onStatError: markIncomplete }))) continue;
    const text = await readIfFresh(file, { onReadError: markIncomplete });
    if (!text) continue;
    const parsed = parseCopilotEventsJsonl(text, {
      sessionKey: sessionKeyFor(copilotHome, file),
    });
    events.push(...filterEventsSince(parsed, since));
  }
  return events;
}

async function main() {
  const passStartedAt = new Date();
  let args;
  try {
    args = await resolveCollectorArgs(process.argv, PRODUCER_ID, { now: passStartedAt });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const scanStatus = { complete: true };
  const events = await collectCopilotEvents({ since: args.since, scanStatus });
  log(`parsed ${events.length} token event(s) since ${args.since.toISOString()}${args.resumedFromState ? " (incremental)" : ""}`);
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
  const token = resolveCollectorToken([
    "COPILOT_INGEST_TOKEN",
    "USAGE_INGEST_TOKEN",
  ]);
  try {
    const ack = await postUsageBatches({
      events,
      ingestUrl: INGEST_URL,
      ingestToken: token,
      producerId: PRODUCER_ID,
      dryRun: DRY || args.dryRun,
      log,
    });
    log(`ingest ack: ${JSON.stringify({ received: ack.received, persisted: ack.persisted, rejected: ack.rejected, dryRun: ack.dryRun ?? false })}`);
    if (ack.rejected > 0) fail(`Ingest reported rejections: ${ack.rejected}`);
    if (!DRY && canAdvanceCollectorCheckpoint(args, { scanComplete: scanStatus.complete })) {
      await recordCollectorSuccess(PRODUCER_ID, passStartedAt);
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
