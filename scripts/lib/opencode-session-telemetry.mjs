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
 *     "token" (src/lib/external-usage-events.ts loadAnalyticsTokenRows,
 *     src/lib/cost-by-session.ts, src/app/api/llm-burn/route.ts,
 *     src/lib/agents-overview.ts).  The context row therefore uses
 *     metricType "limit" and the session / lifecycle rows use unit "row", so
 *     none of them can be summed into a token total.
 *   - The subscription quota panels are built ONLY from rows with metricType
 *     "quota": src/lib/quota-events-loader.ts filters "metricType" = 'quota'
 *     in SQL and src/lib/quota-windows.ts projectQuotaWindows projects those
 *     rows into windows.  A context window is not a subscription quota, so
 *     the context row uses metricType "limit" and never reaches a quota
 *     panel.  It carries the used tokens as quantity, the context window as
 *     limit and the utilization in metadata.
 *   - metricType "limit" is a first-class value in both contracts
 *     (@jaywedgeworth22/congress-trading-shared UsageTelemetryMetricTypeSchema
 *     and src/lib/usage-telemetry.ts), and no UM consumer reads it as usage
 *     or as quota.
 *   - The top-level `project` field is authoritative and is stamped into
 *     metadata.project server-side (src/app/api/ingest/usage/route.ts); the
 *     replay comparison ignores metadata.project
 *     (src/lib/external-usage-events.ts metadataComparableForReplay), so
 *     adding it never re-keys or re-attributes a stored row.
 *   - Every event id THIS MODULE builds is a function of every compared field
 *     of its own row that can move, so a changed field produces a NEW row
 *     instead of an HTTP 409 idempotency_conflict against the stored one
 *     (src/lib/external-usage-events.ts comparableEvent).  The fields that
 *     cannot move are the constants of a row and the completion instant,
 *     which comes from the immutable message payload.  The token rows keep
 *     the shared parser's ids (session-token-collectors.mjs
 *     tokenEventsFromBreakdown), which the shared contract fixes and which
 *     nothing here changes.
 */

import { basename } from "node:path";

import { z } from "zod";

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
 * To turn it on, set OPENCODE_SESSION_ID_CUTOFF_MS to ONE FIXED INSTANT in
 * epoch milliseconds that is AFTER the LaunchAgent restarted on the new code,
 * and restart the LaunchAgent.  The previous collector version keeps sending
 * token rows without a session id until the LaunchAgent restarts, so an
 * instant that is merely "a few minutes after the files were copied" is
 * early: a message that completed in between would be stored by the old
 * collector in the old shape and replayed by the new collector in the new
 * shape, and Usage Monitor would answer HTTP 409 for the whole batch.  The
 * boundary is compared against the message's completion instant, which never
 * moves, so the row a pass sends is the row every later pass sends.
 * See resolveOpencodeSessionIdCutoffMs.
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

/**
 * Read a table that every opencode build has.  A failure here is NOT
 * swallowed: the collector marks the scan incomplete, so the checkpoint does
 * not advance and the next pass reads the same window again.  Swallowing the
 * error would let the watermark move past rows that were never read.
 */
function readAll(db, sql, params = []) {
  return db.prepare(sql).all(...params);
}

/**
 * Read a table that an older opencode build (or a fixture) may not have.
 * A missing table must not stop the token rows from flowing.
 */
function safeAll(db, sql, params = []) {
  try {
    return db.prepare(sql).all(...params);
  } catch {
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
 * Canonical JSON with sorted object keys, so a value can be hashed into an
 * event id.  The hash of a value is the same on every machine and in every
 * pass, which is what makes an event id a function of the row's content.
 */
function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
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

    const assistantRows = readAll(
      db,
      "SELECT id, session_id, data FROM session_message " +
        "WHERE type = 'assistant' AND time_updated >= ? ORDER BY time_created, id",
      [sinceMs],
    ).map((row) => ({ ...row, data: parseJson(row.data) }));
    const lifecycleRows = readAll(
      db,
      "SELECT id, session_id, type, time_created, time_updated, data FROM session_message " +
        `WHERE type IN (${marks(OPENCODE_LIFECYCLE_TYPES.length)}) AND time_created >= ? ` +
        "ORDER BY time_created, id",
      [...OPENCODE_LIFECYCLE_TYPES, sinceMs],
    );

    // Lifecycle rows belong to sessions that may have no assistant row in the
    // window, so both row sets contribute the session ids that are loaded
    // below.  A session that only produced a lifecycle signal still gets its
    // project attribution.
    const sessionIds = uniqueIds([
      ...assistantRows.map((row) => row.session_id),
      ...lifecycleRows.map((row) => row.session_id),
    ]);
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
        ...readAll(
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
 * The models.dev catalog envelope.  The kv value is
 * `{"updatedAt":..,"digest":..,"body":"<json string>"}`, so the body is a
 * JSON string that has to be parsed a second time.  `updatedAt` is a number
 * in the live catalog and a string in older ones, so both are accepted.
 *
 * The envelope is CLOSED: an unknown top-level key is a shape violation and
 * the strict schema rejects it.  It is also ISOLATED: the violation is
 * reported as a warning and the known fields are still read, so one odd
 * field cannot erase every vendor's limits.  The earlier tolerant envelope
 * accepted the key silently, so a catalog that changed shape looked exactly
 * like a catalog that was fine.
 */
const ModelsDevCatalogEnvelopeFieldsSchema = z.object({
  updatedAt: z.union([z.string(), z.number()]).optional(),
  digest: z.string().optional(),
  body: z.union([z.string(), z.record(z.string(), z.unknown())]),
});

const ModelsDevCatalogEnvelopeSchema = ModelsDevCatalogEnvelopeFieldsSchema.strict();

/**
 * The provider / model records inside the catalog body.  The vendor records
 * carry many fields UM never reads (cost, modalities, release dates), so the
 * model and limit records stay loose and only the fields the collector reads
 * are typed.  `limit.context` is 0 for models with no context window (the
 * transcription and video models), so 0 is valid here and is treated as "no
 * limit" below.
 *
 * The records STRIP the fields UM does not read instead of retaining them:
 * an undeclared field from the external catalog never survives the parse,
 * and only the limit map leaves this module.
 */
const ModelsDevLimitSchema = z.object({
  context: z.number().finite().nonnegative().optional(),
});

const ModelsDevModelSchema = z.object({
  limit: ModelsDevLimitSchema.optional(),
});

const ModelsDevProviderSchema = z.object({
  // Each model entry is validated on its own below, so one malformed model
  // costs only itself and not every other model the vendor publishes.
  models: z.record(z.string(), z.unknown()).optional(),
});

const ModelsDevBodySchema = z.record(z.string(), z.unknown());

/**
 * Parse opencode's cached models.dev catalog (kv key `models-dev:catalog`).
 *
 * Inside the body, body[providerId].models[modelId].limit.context is the
 * context window size in tokens.  Only the limits are kept, so the parsed
 * catalog is released as soon as this returns.
 *
 * The parse is granular at every level that can drift: an unknown envelope
 * key, a body that is already an object, one malformed vendor and one
 * malformed model each cost only themselves.  A cached value with no usable
 * body at all returns an empty catalog whose `problem` says why, so the
 * collector can log it instead of losing the context limits silently.
 *
 * `problem` and `warning` say different things.  `problem` means the catalog
 * cannot be used at all and every limit is lost.  `warning` means the
 * catalog IS usable and something about it is not as expected, for example an
 * unknown envelope key: the limits are still reported, and the collector logs
 * the warning so the shape change is visible instead of silent.
 *
 * A limit is only ever reported for the EXACT provider and model the message
 * used.  The catalog defines 546 model ids under more than one provider with
 * different windows (io-net publishes moonshotai/kimi-k2-instruct-0905 with
 * 32768 tokens while huggingface publishes the same model with 262144), so a
 * cross-provider fallback would report a context window that belongs to a
 * different vendor.  A model the provider does not publish yields no limit,
 * and the context row then reports the used tokens with a null limit.
 */
export function parseModelsDevCatalog(rawValue) {
  const unusable = (problem) => ({
    updatedAt: null,
    problem,
    /** The catalog cannot be used, so there is nothing to warn about. */
    warning: null,
    /** No limit is known, because the cached catalog cannot be used. */
    limitFor: () => null,
  });
  // A missing catalog is the NORMAL state on a fresh install, or after a
  // failed catalog fetch, so it gets its own message: an operator must not
  // chase a corruption that does not exist.
  if (
    rawValue === null ||
    rawValue === undefined ||
    (typeof rawValue === "string" && !rawValue.trim())
  ) {
    return unusable("the cached catalog is missing (opencode has not cached models.dev yet)");
  }
  const outer = parseJson(rawValue);
  if (!outer || typeof outer !== "object" || Array.isArray(outer)) {
    return unusable("the cached catalog is not a JSON object");
  }
  const strict = ModelsDevCatalogEnvelopeSchema.safeParse(outer);
  let envelope = null;
  let warning = null;
  if (strict.success) {
    envelope = strict.data;
  } else {
    // The envelope is closed, so an unknown top-level key is a shape
    // violation.  It is isolated to the envelope: the known fields are still
    // read, so one odd field cannot erase every vendor's limits, and the
    // violation is reported instead of being swallowed.
    const unknownKeys = strict.error.issues
      .filter((issue) => issue.code === "unrecognized_keys")
      .flatMap((issue) => issue.keys ?? []);
    const otherIssues = strict.error.issues.filter(
      (issue) => issue.code !== "unrecognized_keys",
    );
    if (otherIssues.length > 0) return unusable("the cached catalog has no usable body");
    const known = ModelsDevCatalogEnvelopeFieldsSchema.safeParse(outer);
    if (!known.success) return unusable("the cached catalog has no usable body");
    envelope = known.data;
    warning = `the cached catalog envelope carries unknown key(s): ${unknownKeys.join(", ")}`;
  }
  const bodyRaw =
    typeof envelope.body === "string" ? parseJson(envelope.body) : envelope.body;
  if (!bodyRaw || typeof bodyRaw !== "object" || Array.isArray(bodyRaw)) {
    return unusable("the cached catalog body is not a JSON object");
  }
  const body = ModelsDevBodySchema.safeParse(bodyRaw);
  if (!body.success) return unusable("the cached catalog body is not a record of providers");

  const limits = new Map();
  for (const [providerId, rawProvider] of Object.entries(body.data)) {
    // One malformed vendor must not cost every other vendor its limit.
    const provider = ModelsDevProviderSchema.safeParse(rawProvider);
    if (!provider.success) continue;
    const models = provider.data.models;
    if (!models) continue;
    for (const [modelId, rawModel] of Object.entries(models)) {
      // The models are validated one by one, so a single malformed model
      // does not cost the vendor its other models.
      const model = ModelsDevModelSchema.safeParse(rawModel);
      if (!model.success) continue;
      const context = model.data.limit?.context;
      if (!Number.isFinite(context) || context <= 0) continue;
      limits.set(`${providerId}\u0000${modelId}`, context);
    }
  }

  return {
    updatedAt: envelope.updatedAt === undefined ? null : String(envelope.updatedAt),
    /** Null when the cached catalog was unusable. */
    problem: null,
    /**
     * Null when nothing about the catalog was off.  A non-null warning means
     * the catalog is USABLE and something about it is not as expected, for
     * example an unknown envelope key.
     */
    warning,
    /** Context limit for one provider + model pair, or null. */
    limitFor(providerId, modelId) {
      if (!providerId || !modelId) return null;
      return limits.get(`${providerId}\u0000${modelId}`) ?? null;
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

/**
 * How many session names are remembered.  The map only has to outlive the
 * sessions whose rows Usage Monitor still holds, so it is capped; the cap is
 * far above the number of opencode sessions a workstation accumulates.
 */
export const MAX_FROZEN_PROJECT_NAMES = 5_000;

/**
 * The project name a session is attributed to, decided once and never moved.
 *
 * Usage Monitor stores a row under a stable event id and answers HTTP 409 for
 * the WHOLE batch when a replay arrives with the same id and different
 * content.  The project name is part of that content: `assertCompatible-
 * ProjectAttribution` compares the stored name with the replayed one and
 * throws when they differ, so a project that opencode names after the fact,
 * or a directory that gets renamed, would take every opencode event in the
 * batch down with it.  The collector replays the last 24 hours on every pass
 * (COLLECTOR_STATE_OVERLAP_MINUTES), so the renamed name would arrive on the
 * very next pass and the producer would stay wedged until the rename was
 * undone.
 *
 * A name is therefore frozen the first time a session resolves to one.  A
 * session that resolved to NO name is not frozen: a row stored without a
 * project can still gain one, because Usage Monitor only compares two names
 * when both sides carry one.
 *
 * The frozen map is updated IN PLACE, so the caller owns the file it keeps it
 * in and can persist whatever the pass decided.
 */
export function freezeProjectNames(resolvedBySession, frozenBySession = new Map()) {
  const frozen = frozenBySession instanceof Map ? frozenBySession : new Map();
  const previous = new Map(frozen);
  const names = new Map();
  for (const [sessionId, resolvedName] of resolvedBySession instanceof Map ? resolvedBySession : []) {
    const frozenName = previous.get(sessionId);
    if (frozenName) {
      names.set(sessionId, frozenName);
      continue;
    }
    names.set(sessionId, resolvedName ?? null);
  }
  // The sessions in this window come first, so trimming keeps the ones that
  // are live and drops the oldest remembered names.
  const rebuilt = new Map();
  for (const [sessionId, name] of names) {
    if (name) rebuilt.set(sessionId, name);
    if (rebuilt.size >= MAX_FROZEN_PROJECT_NAMES) break;
  }
  for (const [sessionId, name] of previous) {
    if (rebuilt.size >= MAX_FROZEN_PROJECT_NAMES) break;
    if (!rebuilt.has(sessionId) && name) rebuilt.set(sessionId, name);
  }
  frozen.clear();
  for (const [sessionId, name] of rebuilt) frozen.set(sessionId, name);
  return names;
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
 * The project rides on every token row.  Usage Monitor strips `project` from
 * the metadata it compares, so attaching it to a row it already stored
 * back-fills the attribution instead of conflicting, and a row it stored
 * without a project can still gain one.  What it does NOT ignore is the name:
 * `assertCompatibleProjectAttribution` compares the stored name against the
 * replayed one and answers HTTP 409 for the WHOLE batch when they differ, so
 * a project that opencode names later, or a directory that gets renamed,
 * would take every opencode event down with it.  freezeProjectNames is what
 * keeps the name still.
 *
 * The session id is attached only to rows completed after
 * OPENCODE_SESSION_ID_CUTOFF_MS, for the reason documented on that constant.
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
    // The id carries the raw provider id and the normalized vendor as well,
    // because Usage Monitor compares metadata.providerId and the provider,
    // and opencodeProviderInfo folds several raw provider ids onto one
    // vendor.  No cost row is stored in Usage Monitor yet, so the id can
    // still cover every compared field.
    extraId: `${messageId}:${providerId || ""}:${provider || ""}:cost`,
  });
  if (!event) return null;
  if (providerId) event.metadata.providerId = providerId;
  return withOpencodeAttribution(event, { sessionId, project });
}

/**
 * Context-window utilization for one assistant message.
 *
 * contextTokens = tokens.input + tokens.cache.read + tokens.cache.write +
 * tokens.output + tokens.reasoning.  opencode's tokens.output EXCLUDES
 * reasoning and the shared token parser folds reasoning into the output row,
 * so the context total adds it too; cache-write tokens occupy the prompt cache
 * and therefore the window, and the shared token parser reports them as a
 * cacheCreation row: the context row then counts exactly the tokens the token
 * rows report for that message.
 *
 * The limit comes from the models.dev catalog for the EXACT provider and
 * model of the message.  A provider that does not publish the model yields no
 * limit: the row still reports the used tokens and leaves the limit null
 * rather than guessing at another vendor's window.
 *
 * The shape has to satisfy two UM rules at once:
 *
 *   - The row must not land in a token total.  UM sums tokens ONLY from rows
 *     with metricType "usage" AND unit "token" (src/lib/external-usage-events.ts
 *     loadAnalyticsTokenRows, src/lib/cost-by-session.ts,
 *     src/app/api/llm-burn/route.ts, src/lib/agents-overview.ts), so the row
 *     uses metricType "limit".
 *   - The row must not show up in the subscription quota panels.  Those are
 *     built ONLY from rows with metricType "quota" (src/lib/quota-events-loader.ts
 *     filters "metricType" = 'quota' in SQL, src/lib/quota-windows.ts
 *     projectQuotaWindows projects them), so the row uses metricType "limit"
 *     and carries no quota window token.
 *
 * The values ride where UM reads them: quantity is the used tokens, limit is
 * the context window in tokens, and metadata carries the same numbers plus
 * the utilization percent.
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
  const limit = numberOrNull(contextLimit);
  const hasLimit = limit !== null && limit > 0;
  const usedPercent = hasLimit ? clampPercent((contextTokens / limit) * 100) : null;
  const remainingPercent = usedPercent === null ? null : clampPercent(100 - usedPercent);
  return withOpencodeAttribution(
    {
      // The id covers every compared field, so a catalog that starts
      // publishing a different window for the model produces a new row
      // instead of an HTTP 409 against the row Usage Monitor already stored.
      // The RAW provider id is part of the id and not just the normalized
      // vendor: opencodeProviderInfo collapses "meta" and every "muse*" onto
      // "muse-code" and every "minimax*" onto "minimax", so a rewritten
      // providerID would keep the id while the compared metadata.providerId
      // moved, and Usage Monitor would reject the whole batch with HTTP 409.
      eventId: shaEventId([
        OPENCODE_PRODUCER_ID,
        sessionId,
        `${messageId}:context`,
        modelId || "",
        "context",
        String(contextTokens),
        hasLimit ? String(limit) : "",
        provider || "",
        providerId || "",
      ]),
      provider,
      service: "opencode",
      producerKeyRef: modelId || undefined,
      label: `context:${modelId}`,
      metricType: "limit",
      unit: "token",
      quantity: contextTokens,
      ...(hasLimit ? { limit } : {}),
      billingMode: "estimated",
      confidence: "actual",
      occurredAt: occurredAtIso,
      metadata: {
        contextTokens,
        contextLimit: hasLimit ? limit : null,
        contextUsedPercent: usedPercent,
        contextRemainingPercent: remainingPercent,
        ...(modelId ? { model: modelId } : {}),
        ...(providerId ? { providerId } : {}),
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
 * Session-level facts, one row per session.
 *
 * The row reports only the facts of a session that never change: when it was
 * created, what it belongs to and which session it continues.  Everything
 * else about a session (its message counts, its running cost, the files it
 * changed) moves as the session works, and it is reported by the snapshot
 * row below instead.
 *
 * The split is what makes the row safe to replay.  Usage Monitor answers
 * HTTP 409 idempotency_conflict for the WHOLE batch when a replayed row
 * differs from the stored one in any compared field
 * (src/lib/external-usage-events.ts comparableEvent), so a row whose content
 * moves would either 409 on every pass or have to be re-keyed every pass.
 * A row whose id is the session id and whose content is fixed is stored once
 * and every later pass dedupes against it.
 *
 * The quantity is 1: the row counts the session, it does not re-report the
 * session's message total, so a pass can never inflate a usage rollup.
 *
 * `occurredAt` is the creation instant, which is a fact about the session and
 * not about the pass, so collectOpencodeEvents keeps this row out of the
 * window filter: a session created before the window is still discovered
 * through its in-window messages, and its one fact row would otherwise never
 * be sent at all.
 */
export function opencodeSessionEvent({ session, project }) {
  const sessionId = typeof session?.id === "string" ? session.id : null;
  if (!sessionId) return null;
  const createdIso = isoFromMs(session.time_created);
  if (!createdIso) return null;

  const metadata = { sessionId, sessionCreatedAt: createdIso };
  if (typeof session.parent_id === "string" && session.parent_id) {
    metadata.sessionParentId = session.parent_id.slice(0, 120);
  }
  if (project) metadata.project = project;

  // The project rides on the row but is deliberately NOT part of the id:
  // projectNameForSession answers with the project table's name once opencode
  // has named it and the directory basename until then, so a session that is
  // named or renamed mid-life would otherwise take a new id.  Usage Monitor
  // strips metadata.project from the metadata it compares, so a new id would
  // store a SECOND fact row for the same session rather than dedupe against
  // it.  The id stays a function of the immutable facts only.
  //
  // The name itself is held still by freezeProjectNames, because Usage Monitor
  // compares the two project names separately and answers HTTP 409 for the
  // whole batch when they differ.
  const idMetadata = { ...metadata };
  delete idMetadata.project;

  return withOpencodeAttribution(
    {
      // The id covers the rest of the metadata, so a fact that changes produces
      // a new row rather than a conflict against the stored one.
      eventId: shaEventId([
        OPENCODE_PRODUCER_ID,
        sessionId,
        "session",
        "facts",
        stableJson(idMetadata),
      ]),
      // The session row describes the opencode session itself, so its
      // provider is the producer and not the vendor of one of its turns.
      // A vendor-derived provider would move when the session switches
      // model, which would turn the stable id into a conflicting replay.
      provider: OPENCODE_PRODUCER_ID,
      service: "opencode",
      label: "session",
      metricType: "usage",
      unit: "row",
      quantity: 1,
      billingMode: "estimated",
      confidence: "actual",
      occurredAt: createdIso,
      metadata,
    },
    { sessionId, project },
  );
}

/**
 * The moving state of one session at one instant: its title, its message
 * counts, its running cost, the files it changed and when it was last
 * active.
 *
 * The id is the hash of the snapshot's content, so the same snapshot always
 * carries the same id and dedupes on every later pass, while a changed
 * snapshot becomes a new row instead of a conflict against the stored one.
 * The quantity is 1 for the same reason as on the session row: a snapshot
 * counts once, it never re-reports the session's totals.
 */
export function opencodeSessionSnapshotEvent({
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
  // The session cost stays in metadata: the per-message cost events already
  // carry the cash, and a top-level costUsd here would double count it.
  metadata.sessionCostUsd = numberOrNull(session.cost) ?? 0;
  metadata.sessionTokensInput = numberOrNull(session.tokens_input) ?? 0;
  metadata.sessionTokensOutput = numberOrNull(session.tokens_output) ?? 0;
  metadata.sessionTokensReasoning = numberOrNull(session.tokens_reasoning) ?? 0;
  metadata.sessionTokensCacheRead = numberOrNull(session.tokens_cache_read) ?? 0;
  metadata.sessionTokensCacheWrite = numberOrNull(session.tokens_cache_write) ?? 0;

  const content = {
    provider: provider || OPENCODE_PRODUCER_ID,
    label: "session-snapshot",
    metricType: "usage",
    unit: "row",
    quantity: 1,
    billingMode: "estimated",
    confidence: "actual",
    occurredAt: occurredAtIso,
    metadata,
  };

  return withOpencodeAttribution(
    {
      eventId: shaEventId([
        OPENCODE_PRODUCER_ID,
        sessionId,
        "session",
        "snapshot",
        stableJson(content),
      ]),
      provider: content.provider,
      service: "opencode",
      label: content.label,
      metricType: content.metricType,
      unit: content.unit,
      quantity: content.quantity,
      billingMode: content.billingMode,
      confidence: content.confidence,
      occurredAt: content.occurredAt,
      metadata,
    },
    { sessionId, project },
  );
}

/**
 * Compaction / model-switch / agent-switch / location-switch signals.
 *
 * The provider comes from the row's own model, never from the assistant rows
 * of the current window.  A window-only lookup moves as assistant rows age
 * out of the replay window, and a provider that moves under a stable event
 * id is an HTTP 409 against the stored row.
 *
 * The id covers the row's content, so a changed field produces a new row
 * instead of a conflict.
 */
export function opencodeLifecycleEvent({ row, project }) {
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

  // The row's own model names the provider.  A row without model info falls
  // back to the producer, which is stable for every later replay.
  const provider = opencodeProviderInfo(providerId, modelId).provider || OPENCODE_PRODUCER_ID;
  const content = {
    provider,
    label: `lifecycle:${type}`,
    metricType: "usage",
    unit: "row",
    quantity: 1,
    billingMode: "estimated",
    confidence: "actual",
    occurredAt: occurredAtIso,
    metadata,
  };

  return withOpencodeAttribution(
    {
      eventId: shaEventId([
        OPENCODE_PRODUCER_ID,
        sessionId,
        rowId,
        "lifecycle",
        type,
        stableJson(content),
      ]),
      provider: content.provider,
      service: "opencode",
      label: content.label,
      metricType: content.metricType,
      unit: content.unit,
      quantity: content.quantity,
      billingMode: content.billingMode,
      confidence: content.confidence,
      occurredAt: content.occurredAt,
      metadata,
    },
    { sessionId, project },
  );
}

/**
 * One token count from opencode's assistant payload.
 *
 * The payload is untrusted external input, so it is parsed with a schema
 * before any of it reaches telemetry.
 *
 * The count is read with the TOKEN PARSER'S OWN RULE
 * (session-token-collectors.mjs finiteCount: a finite number above zero is the
 * count and anything else counts as zero), so a count that is not a number at
 * all is ZERO here, exactly as it is on the token row.  The context total is
 * therefore always exactly the token rows' total for the same message, even
 * when one count is malformed.  A negative count is zero here too, the same
 * as it is on the token row.
 */
const TokenCountSchema = z
  .unknown()
  .optional()
  .transform((value) => {
    if (value === undefined || value === null) return 0;
    const count = Number(value);
    return Number.isFinite(count) && count > 0 ? count : 0;
  });

/**
 * The cache counts inside the token payload.  The object is stripped of the
 * keys the collector does not read (opencode may publish more than read and
 * write), a missing or null cache counts as zero on both sides, and a cache
 * that is not an object at all counts as zero as well, the same as the token
 * row reads it.
 */
const TokenCacheSchema = z
  .object({
    read: TokenCountSchema,
    write: TokenCountSchema,
  })
  .nullable()
  .optional()
  .catch({ read: 0, write: 0 });

/**
 * The token payload of one assistant message.
 *
 * The object is stripped of the keys the collector does not read, so a new
 * opencode field cannot break the parse, and every key the collector DOES
 * read is validated.  An array carries no counts at all, and the token parser
 * reads it as an object of zero counts, so it is normalized to an empty
 * object here too and both sides report zero.
 */
const OpencodeTokensSchema = z.preprocess(
  (value) => (Array.isArray(value) ? {} : value),
  z.object({
    input: TokenCountSchema,
    output: TokenCountSchema,
    reasoning: TokenCountSchema,
    cache: TokenCacheSchema,
  }),
);

/**
 * The token payload of one assistant message, as it is read at the trust
 * boundary.
 *
 * `present` is false when the message carries no token payload at all, which
 * is normal.  `total` is null when a payload is there but is not the expected
 * shape, so the caller can report the shape change instead of sending a wrong
 * total.
 */
const OpencodeTokenPayloadSchema = z.unknown().transform((value) => {
  if (value === undefined || value === null) return { present: false, total: null };
  const parsed = OpencodeTokensSchema.safeParse(value);
  if (!parsed.success) return { present: true, total: null };
  const { input, output, reasoning, cache } = parsed.data;
  return {
    present: true,
    total:
      (input ?? 0) +
      (cache?.read ?? 0) +
      (cache?.write ?? 0) +
      (output ?? 0) +
      (reasoning ?? 0),
  };
});

/**
 * The assistant payload, validated at the trust boundary.  Only the token
 * payload is read from it, and it is read from the PARSED value, so no field
 * of the untrusted payload is read before it has been validated.
 */
const OpencodeAssistantSchema = z.object({
  tokens: OpencodeTokenPayloadSchema.optional(),
});

/**
 * The context total for one assistant message, parsed from the payload.
 *
 * The total is input + cache read + cache write + output + reasoning, which
 * is the token rows' total for the same message: the token parser folds the
 * reasoning into the output row and reports the cache write as a cache
 * creation row.
 *
 * `present` is false when the message carries no token payload at all, and
 * `total` is null when a payload is there but is not the expected shape, so
 * the caller can report it instead of sending a wrong total.
 */
export function parseOpencodeContextTokens(data) {
  const parsed = OpencodeAssistantSchema.safeParse(data);
  if (!parsed.success) return { present: false, total: null };
  const tokens = parsed.data.tokens;
  if (!tokens) return { present: false, total: null };
  return tokens;
}

/**
 * The shape key for the "token payload is not the expected shape" warning.
 * One shape is reported once per run, so a systematic payload change cannot
 * flood the run log.
 */
const TOKEN_PAYLOAD_SHAPE = "malformed-token-payload";

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
  catalog,
  projectBySession: givenProjectBySession,
  onWarning,
}) {
  // The caller passes the frozen names, so every event of a session carries
  // the same project name as the token rows of that session.
  const projectBySession = givenProjectBySession ?? projectNamesBySession(sessions, projects);
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
  // Every warning shape is reported once per run, so a systematic payload
  // change cannot log one line per malformed message on every pass.
  const warnedTokenShapes = new Set();
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

    // The token payload is untrusted external input, so the context total is
    // derived from the PARSED payload and not from the raw optional chaining.
    // A count that is not a number is zero, exactly as it is on the token
    // row, so the context total is always the token rows' total for the same
    // message.  A payload that is not the expected shape produces no context
    // row at all.
    const { present: hasTokenPayload, total: contextTokens } =
      parseOpencodeContextTokens(data);
    if (contextTokens === null) {
      // A message with no token payload at all is normal (opencode writes
      // assistant rows without tokens), so only a payload that is present and
      // malformed is worth a word in the run log.  The shape is reported once
      // per run, so a systematic payload change cannot flood the run log.
      if (hasTokenPayload && !warnedTokenShapes.has(TOKEN_PAYLOAD_SHAPE)) {
        warnedTokenShapes.add(TOKEN_PAYLOAD_SHAPE);
        onWarning?.(
          `opencode assistant message ${messageId} carries a token payload that is not the expected shape, so no context row was sent for it`,
        );
      }
    } else {
      // Only the exact provider and model of the message may set the limit.
      // The catalog publishes 546 model ids under more than one provider with
      // different context windows, so a fallback to another vendor's window
      // would report a utilization that is off by an order of magnitude.
      const contextLimit = catalog?.limitFor(providerId, modelId) ?? null;
      if (occurredAtIso) {
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
  }

  for (const row of lifecycleRows) {
    const sessionId = typeof row?.session_id === "string" && row.session_id ? row.session_id : null;
    if (!sessionId) continue;
    const project = projectBySession.get(sessionId) ?? null;
    const event = opencodeLifecycleEvent({ row, project });
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
    const project = projectBySession.get(sessionId) ?? null;
    // The session fact is stable, so it is stored once and dedupes on every
    // later pass.
    const sessionEvent = opencodeSessionEvent({ session, project });
    if (sessionEvent) events.push(sessionEvent);

    const sessionUpdated = numberOrNull(session.time_updated) ?? 0;
    const lastActivity = Math.max(sessionUpdated, lastActivityBySession.get(sessionId) ?? 0);
    if (!lastActivity) continue;
    const snapshotEvent = opencodeSessionSnapshotEvent({
      session,
      counts: countsBySession.get(sessionId) ?? [],
      provider: providerBySession.get(sessionId) ?? OPENCODE_PRODUCER_ID,
      project,
      lastActivityMs: lastActivity,
    });
    if (snapshotEvent) events.push(snapshotEvent);
  }

  return events;
}
