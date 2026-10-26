#!/usr/bin/env node
// Local collector for the MiniMax Code desktop runtime's exact token ledger.
//
// Reads ${MINIMAX_RUNTIME_DB:-~/.minimax/v2/sqlite/runtime-state.sqlite},
// table local_runtime_token_usage, read-only.  That table is the only exact
// per-turn token source the MiniMax desktop app writes: one row per agent
// turn with input, output, reasoning, cache-read and cache-write token
// counts, the agent name (mavis, worker, explore, verifier) and, on some
// builds, the model.  The official `mmx quota show` feed
// (scripts/minimax-usage-collector.mjs) carries only remaining-percent quota
// windows, so without this collector MiniMax token usage never reaches
// Usage Monitor at all (UM-1637).
//
// The Mac build leaves `model` empty on every row and `cost_usd` at 0, so
// events carry the model only when the row has one and never carry a cost:
// Usage Monitor derives an API-equivalent estimate from the tokens.  Token
// counts themselves are exact, not estimated from text.
//
// Events go out under the existing `minimax-code` producer (the quota
// collector's producer) with metricType "usage", so they land on the same
// Agents Overview platform as the quota windows without double counting
// them: quota rows are metricType "quota" and are never token rows.
//
// Usage:
//   node scripts/minimax-runtime-usage-collector.mjs [--dry-run] [--debug] [--days N] [--since ISO]
//
// Env:
//   MINIMAX_INGEST_TOKEN or USAGE_INGEST_TOKEN
//   USAGE_MONITOR_INGEST_URL (required; the deployment's ingest endpoint)
//   MINIMAX_RUNTIME_DB (default ~/.minimax/v2/sqlite/runtime-state.sqlite)

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

import {
  filterEventsSince,
  postUsageBatches,
  tokenEventsFromBreakdown,
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
/** Ingest producer: the MiniMax platform that already owns the quota feed. */
export const MINIMAX_RUNTIME_PRODUCER_ID = "minimax-code";
/** Watermark key: distinct from the quota collector's own state file. */
export const MINIMAX_RUNTIME_STATE_KEY = "minimax-runtime";
const PROVIDER = "minimax";
const SERVICE = "minimax-code";

/**
 * Bootstrap lookback for the first pass, in days.
 *
 * The Mac's runtime table holds months of rows (177k and growing); three
 * days covers the current gap, and older history can be pulled on purpose
 * with `--days N`.
 */
export const DEFAULT_MINIMAX_RUNTIME_LOOKBACK_DAYS = 3;

/**
 * Replay overlap in minutes.  A runtime row is written when its turn ends,
 * so an hour is a wide margin for a late write, and it keeps a 15-minute
 * pass from re-sending a whole day of rows.
 */
export const MINIMAX_RUNTIME_STATE_OVERLAP_MINUTES = 60;

/** Rows read per pass at most; the next pass continues from the watermark. */
export const MAX_RUNTIME_ROWS_PER_PASS = 50_000;

function log(message) {
  console.log(`[minimax-runtime-usage-collector] ${message}`);
}

function fail(message, code = 1) {
  console.error(`[minimax-runtime-usage-collector] ${message}`);
  process.exit(code);
}

/** "minimax/MiniMax-M3.1-Flash" -> "MiniMax-M3.1-Flash"; empty -> undefined. */
export function normalizeRuntimeModel(raw) {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

/**
 * One runtime row -> one usage event per non-zero token type.
 * The runtime's columns are already split (input excludes cache reads),
 * so the breakdown is used as written.
 */
export function runtimeRowToEvents(row) {
  const occurredAtIso = new Date(Number(row.ts)).toISOString();
  const model = normalizeRuntimeModel(row.model);
  return tokenEventsFromBreakdown({
    producerId: MINIMAX_RUNTIME_PRODUCER_ID,
    provider: PROVIDER,
    service: SERVICE,
    sessionKey: String(row.session_id ?? "minimax-runtime"),
    occurredAtIso,
    model,
    breakdown: {
      input: row.input_tokens,
      output: row.output_tokens,
      cacheRead: row.cache_read_tokens,
      cacheCreation: row.cache_write_tokens,
    },
    extraId: `mmrt-${row.id}`,
    extraMetadata: {
      collector: "runtime-db",
      ...(row.agent_name ? { agent: String(row.agent_name) } : {}),
      ...(row.framework_type ? { framework: String(row.framework_type) } : {}),
      ...(Number(row.reasoning_tokens) > 0
        ? { reasoningTokens: Number(row.reasoning_tokens) }
        : {}),
    },
  });
}

/**
 * Read the runtime rows at or after `since` and map them to events.
 * The database is opened read-only: the desktop app writes it live.
 */
export async function collectMinimaxRuntimeEvents({
  dbPath = expandHome(
    process.env.MINIMAX_RUNTIME_DB ||
      join(homedir(), ".minimax", "v2", "sqlite", "runtime-state.sqlite")
  ),
  since,
  limit = MAX_RUNTIME_ROWS_PER_PASS,
} = {}) {
  if (!existsSync(dbPath)) return [];
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const sinceMs = since ? since.getTime() : 0;
    const rows = db
      .prepare(
        `SELECT id, session_id, agent_name, framework_type, model, ts,
                input_tokens, output_tokens, reasoning_tokens,
                cache_read_tokens, cache_write_tokens
           FROM local_runtime_token_usage
          WHERE ts >= ?
          ORDER BY ts ASC, id ASC
          LIMIT ?`
      )
      .all(sinceMs, limit);
    const events = [];
    for (const row of rows) events.push(...runtimeRowToEvents(row));
    return filterEventsSince(events, since);
  } finally {
    db.close();
  }
}

// The ingest endpoint is deployment-specific, so it is never hardcoded
// here: the operator supplies it (the Mac's LaunchAgent and the server's
// runner both set it), and a missing value fails loudly inside main()
// instead of quietly pointing at one deployment.  A dry run never needs it.
function resolveIngestUrl(env = process.env) {
  const url = env.USAGE_MONITOR_INGEST_URL?.trim();
  if (!url) {
    throw new Error(
      "USAGE_MONITOR_INGEST_URL is not set; refusing to guess an ingest endpoint."
    );
  }
  return url;
}

async function main() {
  const passStartedAt = new Date();
  let args;
  try {
    args = await resolveCollectorArgs(process.argv, MINIMAX_RUNTIME_STATE_KEY, {
      now: passStartedAt,
      defaultLookbackDays: DEFAULT_MINIMAX_RUNTIME_LOOKBACK_DAYS,
      stateOverlapMinutes: MINIMAX_RUNTIME_STATE_OVERLAP_MINUTES,
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const events = await collectMinimaxRuntimeEvents({ since: args.since });
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
    if (!DRY && canAdvanceCollectorCheckpoint(args, { scanComplete: true })) {
      await recordCollectorSuccess(MINIMAX_RUNTIME_STATE_KEY, passStartedAt);
    }
    return;
  }
  const token = resolveCollectorToken(["MINIMAX_INGEST_TOKEN", "USAGE_INGEST_TOKEN"]);
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
      producerId: MINIMAX_RUNTIME_PRODUCER_ID,
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
    if (!DRY && canAdvanceCollectorCheckpoint(args, { scanComplete: true })) {
      await recordCollectorSuccess(MINIMAX_RUNTIME_STATE_KEY, passStartedAt);
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
}
