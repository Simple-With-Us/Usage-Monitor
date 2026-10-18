#!/usr/bin/env node
// Local collector for fx generation usage.
//
// Reads ${FX_HOME:-~/.fx}/usage.jsonl `generation` facts (created_at_ms,
// model, input/output/cache_read/cache_write/reasoning tokens).  fx records
// total_cost 0 on every fact, so no cost event is sent; UM derives cost from
// tokens.  Input is inclusive of cache reads (xAI semantics); reasoning is
// included in output and kept as metadata.
//
// Usage:
//   node scripts/fx-usage-collector.mjs [--dry-run] [--debug] [--days N] [--since ISO]
//
// Env:
//   FX_INGEST_TOKEN or USAGE_INGEST_TOKEN
//   USAGE_MONITOR_INGEST_URL (default https://usage.jays.services/api/ingest/usage)
//   FX_HOME (default ~/.fx)

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  FX_PRODUCER_ID,
  filterEventsSince,
  parseFxUsageJsonl,
  postUsageBatches,
} from "./lib/session-token-collectors.mjs";
import {
  canAdvanceCollectorCheckpoint,
  expandHome,
  recordCollectorSuccess,
  resolveCollectorArgs,
  resolveCollectorToken,
} from "./lib/run-session-token-collector.mjs";

const DRY = process.argv.includes("--dry-run");
const DEBUG = process.argv.includes("--debug");
const PRODUCER_ID = process.env.FX_PRODUCER_ID || FX_PRODUCER_ID;
const INGEST_URL =
  process.env.USAGE_MONITOR_INGEST_URL ||
  "https://usage.jays.services/api/ingest/usage";

function log(message) {
  console.log(`[fx-usage-collector] ${message}`);
}

function fail(message, code = 1) {
  console.error(`[fx-usage-collector] ${message}`);
  process.exit(code);
}

export async function collectFxEvents({
  fxHome = expandHome(process.env.FX_HOME || join(homedir(), ".fx")),
  since,
  scanStatus,
} = {}) {
  let text;
  try {
    text = await readFile(join(fxHome, "usage.jsonl"), "utf8");
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ENOENT") && scanStatus) {
      scanStatus.complete = false;
    }
    return [];
  }
  return filterEventsSince(parseFxUsageJsonl(text), since);
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
  const events = await collectFxEvents({ since: args.since, scanStatus });
  log(`parsed ${events.length} token event(s) since ${args.since.toISOString()}${args.resumedFromState ? " (incremental)" : ""}`);
  if (DEBUG) {
    const models = new Set(events.map((event) => event.producerKeyRef).filter(Boolean));
    log(`models: ${[...models].join(", ") || "(none)"}`);
  }
  if (events.length === 0) {
    log("nothing to send");
    if (!DRY && canAdvanceCollectorCheckpoint(args, { scanComplete: scanStatus.complete })) {
      await recordCollectorSuccess(PRODUCER_ID, passStartedAt);
    }
    return;
  }
  const token = resolveCollectorToken(["FX_INGEST_TOKEN", "USAGE_INGEST_TOKEN"]);
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
