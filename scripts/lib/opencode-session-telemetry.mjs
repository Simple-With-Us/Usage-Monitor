/**
 * Extra opencode telemetry on top of the raw token rows: project attribution,
 * the real reported cost, context-window utilization, session-level facts and
 * compaction / model-switch lifecycle signals.
 *
 * The token rows themselves still come from the shared parser
 * (parseOpencodeMessageRows in session-token-collectors.mjs).  Nothing here
 * changes a token row's event id, label, quantity or unit, so rows already
 * stored in Usage Monitor keep their idempotency key and are never duplicated.
 *
 * UM semantics this module is built against (read before changing a field):
 *
 *   - Token totals are summed ONLY from rows with metricType "usage" AND unit
 *     "token" (src/lib/llm-burn.ts, src/lib/cost-by-session.ts,
 *     src/lib/external-usage-events.ts loadAnalyticsTokenRows,
 *     src/lib/agents-overview.ts).  The context row therefore uses
 *     metricType "quota" and the session / lifecycle rows use unit "row", so
 *     neither can be summed into a token total.
 *   - A quota row's remaining percent is credits / limit * 100
 *     (src/lib/quota-windows.ts projectQuotaWindows) and UM's own quota
 *     producers send credits = percent REMAINING with limit = 100
 *     (scripts/lib/quota-event.mjs).  The context row follows that shape:
 *     limit 100, credits = percent remaining, raw context limit in
 *     metadata.contextLimit.
 *   - The shared v2 contract restricts limitWindow to minute|day|month|run
 *     (@jaywedgeworth22/congress-trading-shared UsageTelemetryLimitWindowSchema),
 *     so the context window token rides in metadata.quotaWindow like every
 *     other quota producer's window token.
 *   - The top-level `project` field is authoritative and is stamped into
 *     metadata.project server-side (src/app/api/ingest/usage/route.ts); the
 *     replay comparison ignores metadata.project
 *     (src/lib/external-usage-events.ts metadataComparableForReplay), so
 *     adding it never re-keys or re-attributes a stored row.
 */

import { basename } from "node:path";

import {
  OPENCODE_PRODUCER_ID,
  estimatedCostEvent,
  opencodeProviderInfo,
  parseOpencodeMessageRows,
  shaEventId,
} from "./session-token-collectors.mjs";

/** opencode message types that are lifecycle signals rather than usage. */
export const OPENCODE_LIFECYCLE_TYPES = Object.freeze([
  "compaction",
  "model-switched",
  "agent-switched",
  "location-switched",
]);

/**
 * Instant from which the token rows carry `metadata.sessionId`.
 *
 * Usage Monitor compares a replay against the stored row and answers HTTP 409
 * idempotency_conflict when any compared field differs
 * (src/lib/external-usage-events.ts comparableEvent / sameEvent; the replay
 * comparison strips `project`, `_producerInstanceId` and `machine` only).
 * `metadata.sessionId` IS compared, so attaching it to the token rows UM
 * already stored turns every replayed row into a conflict: the 24 hour replay
 * window holds ~9,800 opencode token rows, which would cost ~20,000 ingest
 * requests per 15 minute pass for a day (the same trap the DSH collector hit
 * and fixed with DSH_LEGACY_EVENT_CUTOFF_MS).
 *
 * The boundary therefore has to be ONE FIXED INSTANT, set to the moment the
 * new collector is installed: rows completed before it keep the shape UM
 * already stored and replay byte-identically, rows completed after it carry
 * the session id on every later replay too.  A moving boundary is wrong in a
 * different way -- each pass would re-shape the rows the previous pass sent.
 *
 * The default here is "never": no token row ever gains a session id, so a
 * deploy that forgets to set the env var can never conflict.  That costs
 * nothing today, because Usage Monitor's per-session view reads
 * `metadata."session.id"` (src/lib/cost-by-session.ts) and not
 * `metadata.sessionId`, so no consumer reads it off the token rows; the
 * context, cost, session-fact and lifecycle rows carry the session id
 * regardless, and they are new event kinds UM has never stored.
 *
 * To turn it on, set OPENCODE_SESSION_ID_CUTOFF_MS to the install instant in
 * epoch milliseconds -- a few minutes AFTER the files are copied, so the rows
 * the previous collector version is still sending keep their stored shape --
 * and restart the LaunchAgent.  See resolveOpencodeSessionIdCutoffMs.
 */
export const OPENCODE_SESSION_ID_CUTOFF_MS = Number.MAX_SAFE_INTEGER;

/**
 * The shape boundary for this run.  OPENCODE_SESSION_ID_CUTOFF_MS overrides
 * the default; a malformed or missing value falls back to the default, which
 * is "never", so a typo in the plist cannot start a 409 storm.
 */
export function resolveOpencodeSessionIdCutoffMs(env = {}) {
  const raw = env?.OPENCODE_SESSION_ID_CUTOFF_MS;
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return OPENCODE_SESSION_ID_CUTOFF_MS;
  }
  const parsed = Number(String(raw).trim());
  if (!Number.isFinite(parsed) || parsed < 0) return OPENCODE_SESSION_ID_CUTOFF_MS;
  return Math.floor(parsed);
}

const SESSION_COLUMNS = [
  "id",
  "project_id",
  "parent_id",
  "directory",
  "title",
  "cost",
  "tokens_input",
  "tokens_output",
  "tokens_reasoning",
  "tokens_cache_read",
  "tokens_cache_write",
  "summary_additions",
  "summary_deletions",
  "summary_files",
  "time_created",
  "time_updated",
  "time_compacting",
  "time_archived",
].join(", ");

/** Stay well under SQLite's bound parameter limit when fanning out ids. */
const SQL_ID_CHUNK = 150;

function safeAll(db, sql, params = []) {
  try {
    return db.prepare(sql).all(...params);
  } catch {
    // An older opencode build (or a fixture without the table) must not stop
    // the token rows from flowing.
    return [];
  }
}

function safeGet(db, sql, params = []) {
  try {
    return db.prepare(sql).get(...params) ?? null;
  } catch {
    return null;
  }
}

function uniqueIds(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    if (typeof value !== "string" || !value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function chunkIds(ids, size = SQL_ID_CHUNK) {
  const chunks = [];
  for (let index = 0; index < ids.length; index += size) chunks.push(ids.slice(index, index + size));
  return chunks;
}

function marks(count) {
  return new Array(count).fill("?").join(", ");
}

function clampPercent(value) {
  if (!Number.isFinite(value)) return null;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return Math.round(value * 100) / 100;
}

function isoFromMs(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseJson(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Read every row this collector needs in ONE read-only connection: the
 * assistant rows (tokens), the session rows (facts, project), the per-session
 * message counts, the lifecycle rows and the models.dev catalog.
 *
 * Read-only on purpose: opencode keeps writing while this runs, and the file
 * is 100MB+ and growing.  Every query is bounded by the incremental window
 * (the assistant and lifecycle reads) or by the number of sessions seen in
 * that window (the session / count / project reads), so the collector never
 * pulls the whole table into memory.
 */
export async function readOpencodeTelemetry(dbPath, since) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const sinceMs = since ? since.getTime() : 0;

    const assistantRows = safeAll(
      db,
      "SELECT id, session_id, data FROM session_message " +
        "WHERE type = 'assistant' AND time_updated >= ? ORDER BY time_created, id",
      [sinceMs],
    );
    const lifecycleRows = safeAll(
      db,
      "SELECT id, session_id, type, time_created, time_updated, data FROM session_message " +
        `WHERE type IN (${marks(OPENCODE_LIFECYCLE_TYPES.length)}) AND time_created >= ? ` +
        "ORDER BY time_created, id",
      [...OPENCODE_LIFECYCLE_TYPES, sinceMs],
    );

    const sessionIds = uniqueIds(assistantRows.map((row) => row.session_id));
    const sessions = [];
    for (const chunk of chunkIds(sessionIds)) {
      sessions.push(
        ...safeAll(
          db,
          `SELECT ${SESSION_COLUMNS} FROM session_v2 WHERE id IN (${marks(chunk.length)})`,
          chunk,
        ),
      );
    }

    const messageCounts = [];
    for (const chunk of chunkIds(sessionIds)) {
      messageCounts.push(
        ...safeAll(
          db,
          "SELECT session_id, type, COUNT(*) AS count FROM session_message " +
            `WHERE session_id IN (${marks(chunk.length)}) GROUP BY session_id, type`,
          chunk,
        ),
      );
    }

    const projectIds = uniqueIds(sessions.map((row) => row.project_id));
    const projects = [];
    for (const chunk of chunkIds(projectIds)) {
      projects.push(
        ...safeAll(db, `SELECT id, name FROM project WHERE id IN (${marks(chunk.length)})`, chunk),
      );
    }

    const catalogRow = safeGet(db, "SELECT value FROM kv WHERE key = 'models-dev:catalog'");
    return {
      assistantRows,
      lifecycleRows,
      sessions,
      messageCounts,
      projects,
      catalogValue: catalogRow?.value ?? null,
    };
  } finally {
    db.close();
  }
}

/**
 * Parse opencode's cached models.dev catalog (kv key `models-dev:catalog`).
 *
 * The kv value is `{"updatedAt":..,"digest":..,"body":"<json string>"}`, so the
 * body is a JSON string that has to be parsed a second time.  Inside it,
 * body[providerId].models[modelId].limit.context is the context window size
 * in tokens.  Only the limits are kept, so the parsed catalog is released as
 * soon as this returns.
 */
export function parseModelsDevCatalog(rawValue) {
  const outer = parseJson(rawValue);
  if (!outer || typeof outer !== "object") return null;
  const body = typeof outer.body === "string" ? parseJson(outer.body) : outer.body;
  if (!body || typeof body !== "object") return null;

  const limits = new Map();
  const byModelId = new Map();
  for (const [providerId, provider] of Object.entries(body)) {
    const models = provider?.models;
    if (!models || typeof models !== "object") continue;
    for (const [modelId, model] of Object.entries(models)) {
      const context = numberOrNull(model?.limit?.context);
      if (!context || context <= 0) continue;
      limits.set(`${providerId}\u0000${modelId}`, context);
      const key = modelId.toLowerCase();
      if (!byModelId.has(key)) byModelId.set(key, { providerId, context });
    }
  }

  return {
    updatedAt: typeof outer.updatedAt === "string" ? outer.updatedAt : null,
    /** Context limit for one provider + model pair, or null. */
    limitFor(providerId, modelId) {
      if (!providerId || !modelId) return null;
      return limits.get(`${providerId}\u0000${modelId}`) ?? null;
    },
    /** Same model id under any other provider, or null. */
    limitByModelId(modelId) {
      if (!modelId) return null;
      const hit = byModelId.get(String(modelId).toLowerCase());
      return hit ? hit.context : null;
    },
  };
}

/** Folder names that carry no project identity. */
const GENERIC_DIRECTORY_NAMES = new Set([
  "workspaces",
  "releases",
  "scratchpad",
  "tmp",
  "temp",
  "var",
  "folders",
  "private",
  "users",
  "code",
  "apps",
  "projects",
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isMeaningfulSegment(segment) {
  if (!segment) return false;
  if (UUID_PATTERN.test(segment)) return false;
  if (GENERIC_DIRECTORY_NAMES.has(segment.toLowerCase())) return false;
  if (/^\d+$/.test(segment)) return false;
  return true;
}

/**
 * Project name for one session: the project table's name when it has one,
 * otherwise the basename of the session's working directory.  A basename that
 * is a UUID (BotFleet's per-task workspaces) names nothing, so the nearest
 * meaningful ancestor is used instead.  The shared v2 contract trims the name
 * and caps it at 120 characters.
 */
export function projectNameForSession(session, projectRow) {
  const fromProject = typeof projectRow?.name === "string" ? projectRow.name.trim() : "";
  if (fromProject) return fromProject.slice(0, 120);
  const directory = typeof session?.directory === "string" ? session.directory.trim() : "";
  if (!directory) return null;
  const segments = directory.split("/").filter(Boolean);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index].trim();
    if (!isMeaningfulSegment(segment)) continue;
    return segment.replace(/^\./, "").slice(0, 120);
  }
  const fallback = basename(directory).trim();
  return fallback ? fallback.slice(0, 120) : null;
}

/** project name per session id, for the sessions seen in the window. */
export function projectNamesBySession(sessions, projects) {
  const projectById = new Map();
  for (const project of projects) {
    if (project?.id) projectById.set(project.id, project);
  }
  const bySession = new Map();
  for (const session of sessions) {
    if (!session?.id) continue;
    bySession.set(session.id, projectNameForSession(session, projectById.get(session.project_id)));
  }
  return bySession;
}

/** Attach the project + session id to one event without touching its id. */
export function withOpencodeAttribution(event, { sessionId, project }) {
  if (!event) return event;
  if (!event.metadata || typeof event.metadata !== "object") event.metadata = {};
  if (sessionId) event.metadata.sessionId = sessionId;
  if (project) {
    event.project = project;
    event.metadata.project = project;
  }
  return event;
}

/**
 * Token rows, one assistant row at a time so the session id can be attached
 * without touching the shared parser or the token event ids.
 *
 * The project rides on every token row: UM ignores `project` when it compares
 * a replay against the stored row, so this never 409s and it back-fills the
 * project attribution onto the rows UM already stored.  The session id is
 * attached only to rows completed after OPENCODE_SESSION_ID_CUTOFF_MS, for
 * the reason documented on that constant.
 */
export function buildOpencodeTokenEvents({
  assistantRows,
  projectBySession,
  sessionIdCutoffMs = OPENCODE_SESSION_ID_CUTOFF_MS,
}) {
  const events = [];
  for (const row of assistantRows) {
    const sessionId = typeof row?.session_id === "string" && row.session_id ? row.session_id : null;
    const project = sessionId ? projectBySession.get(sessionId) ?? null : null;
    for (const event of parseOpencodeMessageRows([row])) {
      // The token row's occurredAt is the message's completion instant.
      const completedMs = Date.parse(event.occurredAt);
      if (sessionId && Number.isFinite(completedMs) && completedMs >= sessionIdCutoffMs) {
        event.metadata.sessionId = sessionId;
      }
      if (project) {
        event.project = project;
        event.metadata.project = project;
      }
      events.push(event);
    }
  }
  return events;
}

/**
 * The real cost opencode reported for one assistant message.  Zero cost (the
 * free tier) produces nothing; the shared helper owns the idempotency key.
 */
export function opencodeCostEvent({
  sessionId,
  messageId,
  modelId,
  providerId,
  provider,
  costUsd,
  occurredAtIso,
  project,
}) {
  if (!sessionId || !messageId) return null;
  const event = estimatedCostEvent({
    producerId: OPENCODE_PRODUCER_ID,
    provider,
    service: "opencode",
    sessionKey: sessionId,
    occurredAtIso,
    model: modelId || undefined,
    costUsd,
    extraId: `${messageId}:cost`,
  });
  if (!event) return null;
  if (providerId) event.metadata.providerId = providerId;
  return withOpencodeAttribution(event, { sessionId, project });
}

/**
 * Context-window utilization for one assistant message.
 *
 * contextTokens = tokens.input + tokens.cache.read + tokens.output, which is
 * exactly what opencode's own UI shows as "Total Tokens".  The limit comes
 * from the models.dev catalog; without a known limit the row is skipped
 * rather than guessed.
 *
 * metricType "quota" keeps the row out of every token total (UM only sums
 * metricType "usage" with unit "token"), and credits/limit follow UM's quota
 * convention (credits = percent remaining, limit = 100) so the dashboard
 * reads the remaining percent correctly.
 */
export function opencodeContextEvent({
  sessionId,
  messageId,
  modelId,
  providerId,
  provider,
  contextTokens,
  contextLimit,
  occurredAtIso,
  project,
}) {
  if (!sessionId || !messageId) return null;
  if (!Number.isFinite(contextTokens) || contextTokens <= 0) return null;
  if (!Number.isFinite(contextLimit) || contextLimit <= 0) return null;
  const usedPercent = clampPercent((contextTokens / contextLimit) * 100);
  if (usedPercent === null) return null;
  const remainingPercent = clampPercent(100 - usedPercent);
  return withOpencodeAttribution(
    {
      eventId: shaEventId([
        OPENCODE_PRODUCER_ID,
        sessionId,
        `${messageId}:context`,
        modelId || "",
        "context",
        String(contextTokens),
      ]),
      provider,
      service: "opencode",
      producerKeyRef: modelId || undefined,
      label: `context:${modelId}`,
      metricType: "quota",
      unit: "token",
      quantity: contextTokens,
      limit: 100,
      credits: remainingPercent,
      billingMode: "estimated",
      confidence: "actual",
      occurredAt: occurredAtIso,
      metadata: {
        contextTokens,
        contextLimit,
        contextUsedPercent: usedPercent,
        contextRemainingPercent: remainingPercent,
        ...(modelId ? { model: modelId } : {}),
        ...(providerId ? { providerId } : {}),
        quotaWindow: "context",
        usedPercent,
        isExhausted: remainingPercent <= 0,
        remainingUnknown: false,
        scale: "percent_0_100",
        source: "opencode",
      },
    },
    { sessionId, project },
  );
}

/** Message-count keys the session event carries, per opencode message type. */
const MESSAGE_COUNT_KEYS = {
  assistant: "messageCountAssistant",
  user: "messageCountUser",
  system: "messageCountSystem",
  synthetic: "messageCountSynthetic",
  idle: "messageCountIdle",
  compaction: "messageCountCompaction",
  "model-switched": "messageCountModelSwitched",
  "agent-switched": "messageCountAgentSwitched",
  "location-switched": "messageCountLocationSwitched",
};

/**
 * Session-level facts, one row per (session, last-activity timestamp).  The
 * session cost stays in metadata: the per-message cost events already carry
 * the cash, and a top-level costUsd here would double count it.
 */
export function opencodeSessionEvent({
  session,
  counts,
  provider,
  project,
  lastActivityMs,
}) {
  const sessionId = typeof session?.id === "string" ? session.id : null;
  if (!sessionId) return null;
  const lastActivity = numberOrNull(lastActivityMs);
  if (!lastActivity || lastActivity <= 0) return null;
  const occurredAtIso = isoFromMs(lastActivity);
  if (!occurredAtIso) return null;

  const countByType = new Map();
  for (const row of counts || []) {
    const type = typeof row?.type === "string" ? row.type : "other";
    const count = numberOrNull(row?.count) ?? 0;
    countByType.set(type, (countByType.get(type) ?? 0) + count);
  }
  const totalMessages = [...countByType.values()].reduce((sum, count) => sum + count, 0);

  const metadata = {
    sessionId,
    ...(project ? { project } : {}),
    sessionMessageCount: totalMessages,
  };
  let other = 0;
  for (const [type, count] of countByType) {
    const key = MESSAGE_COUNT_KEYS[type];
    if (key) metadata[key] = count;
    else other += count;
  }
  if (other > 0) metadata.messageCountOther = other;

  const title = typeof session.title === "string" ? session.title.trim() : "";
  if (title) metadata.sessionTitle = title.slice(0, 500);
  const createdIso = isoFromMs(session.time_created);
  if (createdIso) metadata.sessionCreatedAt = createdIso;
  metadata.sessionLastActivityAt = occurredAtIso;
  const compactingIso = isoFromMs(session.time_compacting);
  if (compactingIso) metadata.sessionCompactingAt = compactingIso;
  const archivedIso = isoFromMs(session.time_archived);
  if (archivedIso) metadata.sessionArchivedAt = archivedIso;
  if (typeof session.parent_id === "string" && session.parent_id) {
    metadata.sessionParentId = session.parent_id.slice(0, 120);
  }
  metadata.filesChangedAdditions = numberOrNull(session.summary_additions) ?? 0;
  metadata.filesChangedDeletions = numberOrNull(session.summary_deletions) ?? 0;
  metadata.filesChangedFiles = numberOrNull(session.summary_files) ?? 0;
  metadata.sessionCostUsd = numberOrNull(session.cost) ?? 0;
  metadata.sessionTokensInput = numberOrNull(session.tokens_input) ?? 0;
  metadata.sessionTokensOutput = numberOrNull(session.tokens_output) ?? 0;
  metadata.sessionTokensReasoning = numberOrNull(session.tokens_reasoning) ?? 0;
  metadata.sessionTokensCacheRead = numberOrNull(session.tokens_cache_read) ?? 0;
  metadata.sessionTokensCacheWrite = numberOrNull(session.tokens_cache_write) ?? 0;

  return withOpencodeAttribution(
    {
      eventId: shaEventId([OPENCODE_PRODUCER_ID, sessionId, String(lastActivity), "session", "facts"]),
      provider,
      service: "opencode",
      label: "session",
      metricType: "usage",
      unit: "row",
      quantity: totalMessages,
      billingMode: "estimated",
      confidence: "actual",
      occurredAt: occurredAtIso,
      metadata,
    },
    { sessionId, project },
  );
}

/**
 * Compaction / model-switch / agent-switch / location-switch signals.  The
 * event id is the row id, so a replay of the same row dedupes.
 */
export function opencodeLifecycleEvent({ row, provider, project }) {
  const rowId = typeof row?.id === "string" && row.id ? row.id : null;
  const sessionId = typeof row?.session_id === "string" && row.session_id ? row.session_id : null;
  const type = typeof row?.type === "string" ? row.type : null;
  if (!rowId || !sessionId || !type) return null;
  const occurredAtIso = isoFromMs(row.time_created) ?? isoFromMs(row.time_updated);
  if (!occurredAtIso) return null;

  const data = parseJson(row.data) ?? {};
  const metadata = {
    lifecycle: type,
    messageId: rowId,
    eventAt: occurredAtIso,
  };
  const modelId = typeof data.model?.id === "string" ? data.model.id.trim() : "";
  const providerId = typeof data.model?.providerID === "string" ? data.model.providerID : "";
  if (modelId) metadata.model = modelId.slice(0, 120);
  if (providerId) metadata.providerId = providerId.slice(0, 80);
  if (type === "compaction") {
    const reason = typeof data.reason === "string" ? data.reason : "";
    if (reason) metadata.compactionReason = reason.slice(0, 80);
    const status = typeof data.status === "string" ? data.status : "";
    if (status) metadata.compactionStatus = status.slice(0, 80);
    const keepId = typeof data.metadata?.keepID === "string" ? data.metadata.keepID : "";
    if (keepId) metadata.compactionKeepId = keepId.slice(0, 120);
  } else if (type === "agent-switched") {
    const agent = typeof data.agent === "string" ? data.agent : "";
    if (agent) metadata.agent = agent.slice(0, 80);
  } else if (type === "location-switched") {
    const directory = typeof data.location?.directory === "string" ? data.location.directory : "";
    if (directory) metadata.locationDirectory = directory.slice(0, 300);
    const previous = typeof data.previous?.location?.directory === "string"
      ? data.previous.location.directory
      : "";
    if (previous) metadata.previousLocationDirectory = previous.slice(0, 300);
  }

  return withOpencodeAttribution(
    {
      eventId: shaEventId([OPENCODE_PRODUCER_ID, sessionId, rowId, "lifecycle", type]),
      provider,
      service: "opencode",
      label: `lifecycle:${type}`,
      metricType: "usage",
      unit: "row",
      quantity: 1,
      billingMode: "estimated",
      confidence: "actual",
      occurredAt: occurredAtIso,
      metadata,
    },
    { sessionId, project },
  );
}

/**
 * Every non-token event for one window: the reported cost, the context
 * utilization, the session facts and the lifecycle signals.
 */
export function buildOpencodeExtraEvents({
  assistantRows,
  lifecycleRows,
  sessions,
  messageCounts,
  projects,
  catalogValue,
}) {
  const catalog = parseModelsDevCatalog(catalogValue);
  const projectBySession = projectNamesBySession(sessions, projects);
  const countsBySession = new Map();
  for (const row of messageCounts) {
    const sessionId = typeof row?.session_id === "string" ? row.session_id : null;
    if (!sessionId) continue;
    const list = countsBySession.get(sessionId) ?? [];
    list.push(row);
    countsBySession.set(sessionId, list);
  }
  const providerBySession = new Map();
  const lastActivityBySession = new Map();

  const events = [];
  for (const row of assistantRows) {
    const data = parseJson(row?.data);
    if (!data) continue;
    const sessionId = typeof row.session_id === "string" && row.session_id ? row.session_id : null;
    const messageId = typeof row.id === "string" && row.id ? row.id : null;
    if (!sessionId || !messageId) continue;
    const project = projectBySession.get(sessionId) ?? null;

    const modelId = typeof data.model?.id === "string" ? data.model.id.trim() : "";
    const providerId = typeof data.model?.providerID === "string" ? data.model.providerID : "";
    const info = opencodeProviderInfo(providerId, modelId);
    providerBySession.set(sessionId, info.provider);

    const completed = Number(data.time?.completed);
    const occurredAtIso = Number.isFinite(completed) ? new Date(completed).toISOString() : null;
    const messageMs = Number(data.time?.created);
    if (Number.isFinite(messageMs)) {
      const held = lastActivityBySession.get(sessionId) ?? 0;
      if (messageMs > held) lastActivityBySession.set(sessionId, messageMs);
    }

    const cost = Number(data.cost);
    if (occurredAtIso && Number.isFinite(cost) && cost > 0) {
      const costEvent = opencodeCostEvent({
        sessionId,
        messageId,
        modelId,
        providerId,
        provider: info.provider,
        costUsd: cost,
        occurredAtIso,
        project,
      });
      if (costEvent) events.push(costEvent);
    }

    const contextTokens =
      (numberOrNull(data.tokens?.input) ?? 0) +
      (numberOrNull(data.tokens?.cache?.read) ?? 0) +
      (numberOrNull(data.tokens?.output) ?? 0);
    const contextLimit =
      catalog?.limitFor(providerId, modelId) ?? catalog?.limitByModelId(modelId) ?? null;
    if (occurredAtIso && contextLimit) {
      const contextEvent = opencodeContextEvent({
        sessionId,
        messageId,
        modelId,
        providerId,
        provider: info.provider,
        contextTokens,
        contextLimit,
        occurredAtIso,
        project,
      });
      if (contextEvent) events.push(contextEvent);
    }
  }

  for (const row of lifecycleRows) {
    const sessionId = typeof row?.session_id === "string" && row.session_id ? row.session_id : null;
    if (!sessionId) continue;
    const project = projectBySession.get(sessionId) ?? null;
    const provider = providerBySession.get(sessionId) ?? "opencode";
    const event = opencodeLifecycleEvent({ row, provider, project });
    if (event) events.push(event);
    const created = Number(row.time_created);
    if (Number.isFinite(created)) {
      const held = lastActivityBySession.get(sessionId) ?? 0;
      if (created > held) lastActivityBySession.set(sessionId, created);
    }
  }

  for (const session of sessions) {
    const sessionId = typeof session?.id === "string" ? session.id : null;
    if (!sessionId) continue;
    const sessionUpdated = numberOrNull(session.time_updated) ?? 0;
    const lastActivity = Math.max(sessionUpdated, lastActivityBySession.get(sessionId) ?? 0);
    if (!lastActivity) continue;
    const project = projectBySession.get(sessionId) ?? null;
    const provider = providerBySession.get(sessionId) ?? "opencode";
    const event = opencodeSessionEvent({
      session,
      counts: countsBySession.get(sessionId) ?? [],
      provider,
      project,
      lastActivityMs: lastActivity,
    });
    if (event) events.push(event);
  }

  return events;
}
