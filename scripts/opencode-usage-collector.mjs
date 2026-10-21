#!/usr/bin/env node
// Local collector for opencode session usage.
//
// Reads opencode's SQLite store
// (${OPENCODE_DB:-${XDG_DATA_HOME:-~/.local/share}/opencode/opencode.db},
// table session_message, column data JSON) read-only, because opencode may be
// running.  One usage event per token type per completed assistant message:
// input, output (reasoning folded in; split kept in metadata), cacheRead and
// cacheCreation.  opencode reports cost 0 for almost every row, so no cost
// event is sent for those; UM derives cost from tokens.  A non-zero reported
// cost is kept in metadata.reportedCostUsd.
//
// On top of the token rows the collector sends (scripts/lib/opencode-session-telemetry.mjs):
//   - the top-level `project` (session directory basename or project name) on
//     every event, plus metadata.sessionId on a token row only when that row
//     was completed after the one fixed shape boundary (see
//     resolveOpencodeSessionIdCutoffMs), so a replay of a row Usage Monitor
//     already stored still dedupes instead of answering HTTP 409,
//   - a cost event for every assistant message that reported a real cost,
//   - one context-window utilization row per assistant message (how full the
//     context was on that turn), read from opencode's models-dev catalog,
//   - one session-fact row per session (title, activity, message counts,
//     files changed, session cost),
//   - compaction / model-switch / agent-switch / location-switch lifecycle rows.
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
  postUsageBatches,
} from "./lib/session-token-collectors.mjs";
import {
  buildOpencodeExtraEvents,
  buildOpencodeTokenEvents,
  projectNamesBySession,
  readOpencodeTelemetry,
  OPENCODE_SESSION_ID_CUTOFF_MS,
  resolveOpencodeSessionIdCutoffMs,
} from "./lib/opencode-session-telemetry.mjs";
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

/**
 * Every event for the window: the token rows (unchanged ids), the reported
 * cost, the context utilization, the session facts and the lifecycle signals.
 */
export async function collectOpencodeEvents({
  dbPath = defaultOpencodeDbPath(),
  since,
  scanStatus,
  sessionIdCutoffMs = OPENCODE_SESSION_ID_CUTOFF_MS,
} = {}) {
  if (!existsSync(dbPath)) return [];
  try {
    const telemetry = await readOpencodeTelemetry(dbPath, since);
    const projectBySession = projectNamesBySession(telemetry.sessions, telemetry.projects);
    const tokenEvents = buildOpencodeTokenEvents({
      assistantRows: telemetry.assistantRows,
      projectBySession,
      sessionIdCutoffMs,
    });
    const extraEvents = buildOpencodeExtraEvents(telemetry);
    // The session fact is dated at the session's creation instant, so the
    // window filter would drop it for every session that was created before
    // the window even though the session is still discovered through its
    // in-window messages.  Its content never moves and its id is the
    // session's, so the row is stored once and every later pass dedupes
    // against it; only sessions seen in the window emit it.
    const sessionFacts = [];
    const windowedExtraEvents = [];
    for (const event of extraEvents) {
      if (event?.label === "session") sessionFacts.push(event);
      else windowedExtraEvents.push(event);
    }
    return [...filterEventsSince([...tokenEvents, ...windowedExtraEvents], since), ...sessionFacts];
  } catch (error) {
    if (scanStatus) scanStatus.complete = false;
    if (DEBUG) log(`database read failed (${error instanceof Error ? error.message : "error"})`);
    return [];
  }
}

/** Bucket the window's events by kind for the run log. */
export function countEventKinds(events) {
  const counts = { token: 0, cost: 0, context: 0, session: 0, lifecycle: 0 };
  for (const event of events) {
    const label = typeof event?.label === "string" ? event.label : "";
    if (label.startsWith("token:")) counts.token += 1;
    else if (label.startsWith("context:")) counts.context += 1;
    else if (label.startsWith("lifecycle:")) counts.lifecycle += 1;
    else if (label === "session" || label === "session-snapshot") counts.session += 1;
    else if (event?.metricType === "cost") counts.cost += 1;
  }
  return counts;
}

/** One example event per kind, for --dry-run inspection. */
export function sampleEventPerKind(events) {
  const samples = new Map();
  for (const event of events) {
    const label = typeof event?.label === "string" ? event.label : "";
    const kind = label.startsWith("token:")
      ? "token"
      : label.startsWith("context:")
        ? "context"
        : label.startsWith("lifecycle:")
          ? "lifecycle"
          : label === "session" || label === "session-snapshot"
            ? "session"
            : event?.metricType === "cost"
              ? "cost"
              : null;
    if (!kind || samples.has(kind)) continue;
    samples.set(kind, event);
  }
  return [...samples.entries()];
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
  const dryRun = DRY || args.dryRun;
  // One fixed instant decides whether a token row carries the session id.  It
  // is read from OPENCODE_SESSION_ID_CUTOFF_MS and defaults to "never", so the
  // token rows keep exactly the shape Usage Monitor already stored unless an
  // operator sets the boundary to the install moment on purpose.  A dry run
  // previews the shape this run sends, not a different one.
  const sessionIdCutoffMs = resolveOpencodeSessionIdCutoffMs(process.env);
  const events = await collectOpencodeEvents({
    since: args.since,
    scanStatus,
    sessionIdCutoffMs,
  });
  const kinds = countEventKinds(events);
  log(
    `parsed ${events.length} event(s) since ${args.since.toISOString()}${args.resumedFromState ? " (incremental)" : ""}: ` +
      `${JSON.stringify(kinds)}`,
  );
  if (DEBUG) {
    const models = new Set(events.map((event) => event.producerKeyRef).filter(Boolean));
    log(`models: ${[...models].join(", ") || "(none)"}`);
    for (const [kind, sample] of sampleEventPerKind(events)) {
      log(`sample ${kind}: ${JSON.stringify(sample)}`);
    }
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
      dryRun,
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
