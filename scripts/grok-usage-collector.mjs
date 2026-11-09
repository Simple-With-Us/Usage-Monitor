#!/usr/bin/env node
// Local collector for Grok Build CLI session logs.
//
// Reads ${GROK_HOME:-~/.grok}/sessions/**/updates.jsonl turn_completed rows
// (same layout as ccusage). Pushes estimated token events plus Grok's
// costUsdTicks converted to USD. Not SuperGrok billing. Not cash.
//
// Usage:
//   node scripts/grok-usage-collector.mjs [--dry-run] [--debug] [--days N] [--since ISO]
//
// Env:
//   USAGE_INGEST_TOKEN or GROK_INGEST_TOKEN
//   USAGE_MONITOR_INGEST_URL (default https://usage.jays.services/api/ingest/usage)
//   GROK_HOME (default ~/.grok)

import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { flushCollectorSentry } from "./lib/collector-sentry-bridge.mjs";

import {
  GROK_PRODUCER_ID,
  filterEventsSince,
  parseGrokUpdatesJsonl,
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
} from "./lib/grok-run-session-token-collector.mjs";

const DRY = process.argv.includes("--dry-run");
const DEBUG = process.argv.includes("--debug");
const PRODUCER_ID = process.env.GROK_PRODUCER_ID || GROK_PRODUCER_ID;
const INGEST_URL =
  process.env.USAGE_MONITOR_INGEST_URL ||
  "https://usage.jays.services/api/ingest/usage";

function log(message) {
  console.log(`[grok-usage-collector] ${message}`);
}

function fail(message, code = 1) {
  console.error(`[grok-usage-collector] ${message}`);
  process.exit(code);
}

export async function collectGrokEvents({
  grokHome = expandHome(process.env.GROK_HOME || join(homedir(), ".grok")),
  since,
  scanStatus,
} = {}) {
  const markIncomplete = () => {
    if (scanStatus) scanStatus.complete = false;
  };
  const root = join(grokHome, "sessions");
  const files = await walkFiles(root, { name: "updates.jsonl", onTraversalError: markIncomplete });
  const events = [];
  for (const file of files) {
    if (!(await fileMayContainEventsSince(file, since, { onStatError: markIncomplete }))) continue;
    const text = await readIfFresh(file, { onReadError: markIncomplete });
    if (!text) continue;
    const parsed = parseGrokUpdatesJsonl(text, {
      sessionKey: sessionKeyFor(grokHome, file),
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
  const events = await collectGrokEvents({ since: args.since, scanStatus });
  const tokenEvents = events.filter((e) => e.metricType === "usage").length;
  const costEvents = events.filter((e) => e.metricType === "cost").length;
  log(
    `parsed ${events.length} event(s) (${tokenEvents} token, ${costEvents} cost) since ${args.since.toISOString()}${args.resumedFromState ? " (incremental)" : ""}`
  );
  if (DEBUG) {
    const models = new Set(events.map((e) => e.producerKeyRef).filter(Boolean));
    log(`models: ${[...models].join(", ") || "(none)"}`);
  }
  if (events.length === 0) {
    await flushCollectorSentry({ producerId: PRODUCER_ID, dryRun: DRY || args.dryRun, log });
    log("nothing to send");
    if (!DRY && canAdvanceCollectorCheckpoint(args, { scanComplete: scanStatus.complete })) {
      await recordCollectorSuccess(PRODUCER_ID, passStartedAt);
    }
    return;
  }
  const token = await resolveCollectorToken([
    "GROK_INGEST_TOKEN",
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
