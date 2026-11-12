#!/usr/bin/env node
// Sends exact Antigravity CLI status-line token snapshots to Usage Monitor.
// The companion status-line sink stores only model and token counters; it
// never stores prompts, transcript paths, workspace paths, email, or tools.

import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { flushCollectorSentry } from "./lib/collector-sentry-bridge.mjs";

import {
  ANTIGRAVITY_STATUSLINE_PRODUCER_ID,
  filterEventsSince,
  parseAntigravityStatuslineJsonl,
  postUsageBatches,
} from "./lib/session-token-collectors.mjs";
import {
  canAdvanceCollectorCheckpoint,
  expandHome,
  readIfFresh,
  recordCollectorSuccess,
  resolveCollectorArgs,
  resolveCollectorToken,
} from "./lib/antigravity-session-run-session-token-collector.mjs";

const DRY = process.argv.includes("--dry-run");
const PRODUCER_ID =
  process.env.ANTIGRAVITY_STATUSLINE_PRODUCER_ID ||
  ANTIGRAVITY_STATUSLINE_PRODUCER_ID;
export const STATUSLINE_TOKEN_ENV_NAMES = ["ANTIGRAVITY_STATUSLINE_INGEST_TOKEN", "USAGE_INGEST_TOKEN"];
const INGEST_URL = process.env.USAGE_MONITOR_INGEST_URL || "https://usage.jays.services/api/ingest/usage";

function log(message) {
  console.log(`[antigravity-session-collector] ${message}`);
}

function fail(message, code = 1) {
  console.error(`[antigravity-session-collector] ${message}`);
  process.exit(code);
}

export async function collectAntigravitySessionEvents({
  snapshotPath = expandHome(
    process.env.ANTIGRAVITY_TELEMETRY_SNAPSHOT ||
      join(homedir(), ".cache", "usage-monitor", "antigravity-statusline", "usage.jsonl"),
  ),
  since,
  scanStatus,
} = {}) {
  const text = await readIfFresh(snapshotPath, {
    onReadError: () => {
      if (scanStatus) scanStatus.complete = false;
    },
  });
  if (!text) return [];
  return filterEventsSince(parseAntigravityStatuslineJsonl(text), since);
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
  const events = await collectAntigravitySessionEvents({
    since: args.since,
    scanStatus,
  });
  log(`parsed ${events.length} token event(s) since ${args.since.toISOString()}${args.resumedFromState ? " (incremental)" : ""}`);
  if (events.length === 0) {
    await flushCollectorSentry({ producerId: PRODUCER_ID, dryRun: DRY || args.dryRun, log });
    log("nothing to send");
    if (!DRY && canAdvanceCollectorCheckpoint(args, { scanComplete: scanStatus.complete })) {
      await recordCollectorSuccess(PRODUCER_ID, passStartedAt);
    }
    return;
  }
  // ANTIGRAVITY_INGEST_TOKEN is scoped to the antigravity-cli producer, not
  // this one, so it is deliberately not a candidate here.
  const token = await resolveCollectorToken(STATUSLINE_TOKEN_ENV_NAMES);
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
  main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
}
