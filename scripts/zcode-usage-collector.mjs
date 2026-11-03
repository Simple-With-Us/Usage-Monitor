#!/usr/bin/env node
// Exact ZCode model-request token collector.
//
// ZCode documents model_usage as its canonical token source.  The database is
// opened read-only, and only terminal rows are emitted so a stable request id
// never changes quantity after Usage Monitor accepts it.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { flushCollectorSentry } from "./lib/collector-sentry-bridge.mjs";
import {
  parseZcodeModelUsageRows,
  ZCODE_PRODUCER_ID,
} from "./lib/kimi-zcode-telemetry.mjs";
import { filterEventsSince, postUsageBatches } from "./lib/session-token-collectors.mjs";
import {
  canAdvanceCollectorCheckpoint,
  expandHome,
  recordCollectorSuccess,
  resolveCollectorArgs,
  resolveCollectorToken,
} from "./lib/run-session-token-collector.mjs";

const PRODUCER_ID = ZCODE_PRODUCER_ID;
const INGEST_URL =
  process.env.USAGE_MONITOR_INGEST_URL ||
  "https://usage.jays.services/api/ingest/usage";
const DEBUG = process.argv.includes("--debug");

function log(message) {
  console.log(`[zcode-usage-collector] ${message}`);
}

function fail(message, code = 1) {
  console.error(`[zcode-usage-collector] ${message}`);
  process.exit(code);
}

export function defaultZcodeDbPath(env = process.env) {
  if (env.ZCODE_DB) return expandHome(env.ZCODE_DB);
  const dataRoot = env.ZCODE_DATA_BASE_DIR ? expandHome(env.ZCODE_DATA_BASE_DIR) : homedir();
  return join(dataRoot, ".zcode", "cli", "db", "db.sqlite");
}

export async function readZcodeModelUsageRows(dbPath, since) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec("PRAGMA query_only = ON");
    db.exec("PRAGMA busy_timeout = 5000");
    return db
      .prepare(
        `SELECT
          u.id, u.session_id, u.query_source, u.provider_id, u.model_id,
          u.agent, u.mode, u.task_type, u.status, u.started_at,
          u.completed_at, u.duration_ms, u.time_to_first_token_ms,
          u.input_tokens, u.output_tokens, u.reasoning_tokens,
          u.cache_creation_input_tokens, u.cache_read_input_tokens,
          s.project_id, s.directory
        FROM model_usage u
        LEFT JOIN session s ON s.id = u.session_id
        WHERE u.status IN ('completed', 'error', 'cancelled')
          AND COALESCE(u.completed_at, u.started_at) >= ?
        ORDER BY u.started_at, u.id`,
      )
      .all(since ? since.getTime() : 0);
  } finally {
    db.close();
  }
}

export async function collectZcodeEvents({
  dbPath = defaultZcodeDbPath(),
  since,
  scanStatus = { complete: true },
} = {}) {
  if (!existsSync(dbPath)) return [];
  try {
    return filterEventsSince(parseZcodeModelUsageRows(await readZcodeModelUsageRows(dbPath, since)), since);
  } catch (error) {
    scanStatus.complete = false;
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
  const dbPath = defaultZcodeDbPath();
  const sourceAvailable = existsSync(dbPath);
  const scanStatus = { complete: true };
  const events = await collectZcodeEvents({ dbPath, since: args.since, scanStatus });
  log(
    `parsed ${events.length} event(s) since ${args.since.toISOString()}${args.resumedFromState ? " (incremental)" : ""}`,
  );
  if (DEBUG) {
    const providers = [...new Set(events.map((event) => event.provider).filter(Boolean))];
    const models = [...new Set(events.map((event) => event.producerKeyRef).filter(Boolean))];
    log(`providers: ${providers.join(", ") || "(none)"}; models: ${models.join(", ") || "(none)"}`);
  }
  if (!sourceAvailable) {
    await flushCollectorSentry({ producerId: PRODUCER_ID, dryRun: args.dryRun, log });
    log(`source database is absent at ${dbPath}; checkpoint unchanged`);
    return;
  }
  if (events.length === 0) {
    await flushCollectorSentry({ producerId: PRODUCER_ID, dryRun: args.dryRun, log });
    log("nothing to send");
    if (canAdvanceCollectorCheckpoint(args, { scanComplete: scanStatus.complete })) {
      await recordCollectorSuccess(PRODUCER_ID, passStartedAt);
    }
    return;
  }
  const token = resolveCollectorToken([
    "ZCODE_INGEST_TOKEN",
    "ZAI_INGEST_TOKEN",
    "USAGE_INGEST_TOKEN",
  ]);
  try {
    const ack = await postUsageBatches({
      events,
      ingestUrl: INGEST_URL,
      ingestToken: token,
      producerId: PRODUCER_ID,
      dryRun: args.dryRun,
      log,
    });
    log(
      `ingest ack: ${JSON.stringify({ received: ack.received, persisted: ack.persisted, rejected: ack.rejected, dryRun: ack.dryRun ?? false })}`,
    );
    if (ack.rejected > 0) fail(`Ingest reported rejections: ${ack.rejected}`);
    if (canAdvanceCollectorCheckpoint(args, { scanComplete: scanStatus.complete })) {
      await recordCollectorSuccess(PRODUCER_ID, passStartedAt);
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
}
