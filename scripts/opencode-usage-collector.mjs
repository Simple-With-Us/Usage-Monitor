#!/usr/bin/env node
// Local collector for opencode session usage.
//
// Reads assistant rows from opencode's SQLite store
// (${OPENCODE_DB:-${XDG_DATA_HOME:-~/.local/share}/opencode/opencode.db},
// table session_message, column data JSON) read-only, because opencode may be
// running.  One usage event per token type per completed assistant message:
// input, output (reasoning folded in; split kept in metadata), cacheRead and
// cacheCreation.  opencode reports cost 0 for almost every row, so no cost
// event is sent; UM derives cost from tokens.  A non-zero reported cost is
// kept in metadata.reportedCostUsd.
//
// Usage:
//   node scripts/opencode-usage-collector.mjs [--dry-run] [--debug] [--days N] [--since ISO]
//
// Env:
//   OPENCODE_INGEST_TOKEN or USAGE_INGEST_TOKEN
//   USAGE_MONITOR_INGEST_URL (default https://usage.jays.services/api/ingest/usage)
//   OPENCODE_DB (default ~/.local/share/opencode/opencode.db)

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  OPENCODE_PRODUCER_ID,
  filterEventsSince,
  parseOpencodeMessageRows,
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
const PRODUCER_ID = process.env.OPENCODE_PRODUCER_ID || OPENCODE_PRODUCER_ID;
const INGEST_URL =
  process.env.USAGE_MONITOR_INGEST_URL ||
  "https://usage.jays.services/api/ingest/usage";

function log(message) {
  console.log(`[opencode-usage-collector] ${message}`);
}

function fail(message, code = 1) {
  console.error(`[opencode-usage-collector] ${message}`);
  process.exit(code);
}

export function defaultOpencodeDbPath(env = process.env) {
  if (env.OPENCODE_DB) return expandHome(env.OPENCODE_DB);
  const dataHome = env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(expandHome(dataHome), "opencode", "opencode.db");
}

/** Read assistant rows updated since `since`, read-only. */
export async function readOpencodeRows(dbPath, since) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const sinceMs = since ? since.getTime() : 0;
    return db
      .prepare(
        "SELECT id, session_id, data FROM session_message " +
          "WHERE type = 'assistant' AND time_updated >= ? ORDER BY time_created, id",
      )
      .all(sinceMs);
  } finally {
    db.close();
  }
}

export async function collectOpencodeEvents({
  dbPath = defaultOpencodeDbPath(),
  since,
  scanStatus,
} = {}) {
  if (!existsSync(dbPath)) return [];
  try {
    const rows = await readOpencodeRows(dbPath, since);
    return filterEventsSince(parseOpencodeMessageRows(rows), since);
  } catch (error) {
    if (scanStatus) scanStatus.complete = false;
    if (DEBUG) log(`database read failed (${error instanceof Error ? error.message : "error"})`);
    return [];
  }
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
  const events = await collectOpencodeEvents({ since: args.since, scanStatus });
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
  const token = resolveCollectorToken(["OPENCODE_INGEST_TOKEN", "USAGE_INGEST_TOKEN"]);
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
