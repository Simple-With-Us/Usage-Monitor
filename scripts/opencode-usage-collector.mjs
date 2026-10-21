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
//   - the project name of a session frozen the first time it is seen
//     (freezeProjectNames), so a project opencode names later, or a directory
//     that gets renamed, cannot change the content of a stored row and take
//     the whole batch down with a 409,
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
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  OPENCODE_PRODUCER_ID,
  filterEventsSince,
  postUsageBatches,
} from "./lib/session-token-collectors.mjs";
import {
  buildOpencodeExtraEvents,
  buildOpencodeTokenEvents,
  freezeProjectNames,
  parseModelsDevCatalog,
  projectNamesBySession,
  readOpencodeTelemetry,
  OPENCODE_SESSION_ID_CUTOFF_MS,
  resolveOpencodeSessionIdCutoffMs,
} from "./lib/opencode-session-telemetry.mjs";
import {
  canAdvanceCollectorCheckpoint,
  collectorStatePath,
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

/**
 * Where the frozen project names live.  The file sits beside the collector's
 * checkpoint but is a file of its own, because it has to outlive the
 * checkpoint: a lost checkpoint replays the last rows, and a lost freeze
 * would let a renamed project change their content and collide with the rows
 * Usage Monitor already stored.
 */
export function opencodeProjectNamesPath(producerId = PRODUCER_ID, stateRoot) {
  return collectorStatePath(producerId, stateRoot, "project-names");
}

/**
 * The project names every session was attributed to the first time it was
 * seen.  A missing or unreadable file is an empty map, not a failure: the
 * collector then freezes the names it sees from now on.
 */
export async function readFrozenProjectNames(path) {
  const names = new Map();
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return names;
  }
  try {
    const parsed = JSON.parse(raw);
    const stored = parsed?.projectNames;
    if (!stored || typeof stored !== "object") return names;
    for (const [sessionId, name] of Object.entries(stored)) {
      if (typeof sessionId === "string" && sessionId && typeof name === "string" && name) {
        names.set(sessionId, name);
      }
    }
  } catch {
    // A corrupt file is an empty map: the names are frozen again from the
    // next pass on, which is the same state a fresh install starts in.
  }
  return names;
}

/**
 * Persist the frozen names.  The file is only written when the names moved,
 * and the keys are sorted so an unchanged freeze does not rewrite the file
 * every 15 minutes.
 */
export async function writeFrozenProjectNames(path, frozen, producerId = PRODUCER_ID) {
  const sorted = [...frozen.entries()].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const body = `${JSON.stringify({
    version: 1,
    producerId,
    projectNames: Object.fromEntries(sorted),
  })}\n`;
  try {
    if ((await readFile(path, "utf8")) === body) return false;
  } catch {
    // No file yet, so there is nothing to compare against.
  }
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.tmp`;
  await writeFile(tempPath, body, { mode: 0o600 });
  await rename(tempPath, path);
  return true;
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
  frozenProjectNames = new Map(),
  onWarning,
} = {}) {
  if (!existsSync(dbPath)) return [];
  try {
    const telemetry = await readOpencodeTelemetry(dbPath, since);
    // The project name is decided once per session and then held still, so a
    // project that opencode names later, or a directory that gets renamed,
    // cannot change the content of a row Usage Monitor already stored.  The
    // map is updated in place, so the caller can persist what this pass
    // decided.
    const projectBySession = freezeProjectNames(
      projectNamesBySession(telemetry.sessions, telemetry.projects),
      frozenProjectNames,
    );
    const tokenEvents = buildOpencodeTokenEvents({
      assistantRows: telemetry.assistantRows,
      projectBySession,
      sessionIdCutoffMs,
    });
    const catalog = parseModelsDevCatalog(telemetry.catalogValue);
    // A catalog that cannot be used is not a silent event: every context row
    // would report a null limit and the context feature would disappear
    // without a word, so the reason goes into the run log.
    if (catalog.problem) {
      onWarning?.(`models.dev catalog unusable: ${catalog.problem}`);
    }
    // A catalog that IS usable but is not the expected shape is reported the
    // same way: the limits still work, so the run log has to say that the
    // envelope changed instead of letting the change pass unnoticed.
    if (catalog.warning) {
      onWarning?.(`models.dev catalog warning: ${catalog.warning}`);
    }
    const extraEvents = buildOpencodeExtraEvents({
      ...telemetry,
      catalog,
      projectBySession,
      onWarning,
    });
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
  // The project names are read before the pass and written straight after it,
  // before anything is posted.  A pass that fails to post must still leave
  // the names where they were, or the next pass would change the content of
  // the rows the failed pass had already stored.
  const projectNamesPath = opencodeProjectNamesPath(PRODUCER_ID);
  const frozenProjectNames = await readFrozenProjectNames(projectNamesPath);
  const events = await collectOpencodeEvents({
    since: args.since,
    scanStatus,
    sessionIdCutoffMs,
    frozenProjectNames,
    onWarning: (message) => log(message),
  });
  if (!dryRun && (await writeFrozenProjectNames(projectNamesPath, frozenProjectNames, PRODUCER_ID))) {
    log(`froze the project name of ${frozenProjectNames.size} session(s)`);
  }
  const kinds = countEventKinds(events);
  log(
    `parsed ${events.length} event(s) since ${args.since.toISOString()}${args.resumedFromState ? " (incremental)" : ""}: ` +
      `${JSON.stringify(kinds)}`,
  );
  // A context row without a limit means the models.dev catalog has no window
  // for that provider and model, so the utilization is unknown.  Say so when
  // it happens instead of letting the context feature quietly go blank.
  const contextWithoutLimit = events.filter(
    (event) =>
      typeof event?.label === "string" &&
      event.label.startsWith("context:") &&
      event.metadata?.contextLimit == null,
  ).length;
  if (contextWithoutLimit > 0) {
    log(
      `${contextWithoutLimit} context row(s) carry no context limit: the models.dev catalog has no window for that provider and model`,
    );
  }
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
