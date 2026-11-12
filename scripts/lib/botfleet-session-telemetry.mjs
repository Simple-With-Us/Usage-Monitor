import { createHash } from "node:crypto";
import { telemetryIdentifier } from "../telemetry-hub/metadata-projection.mjs";

const counter = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : undefined;
const identity = (value) => typeof value === "string" && value.length > 0 && value.length <= 256 ? value : undefined;

/** Select native turn metadata only; raw events, content and arbitrary errors never survive. */
export function projectBotFleetRuntimeEvent(raw) {
  if (!raw || typeof raw !== "object" || !["turn.started", "turn.completed"].includes(raw.type)) return null;
  const eventId = identity(raw.eventId);
  const threadId = identity(raw.threadId);
  const timestamp = typeof raw.createdAt === "string" ? Date.parse(raw.createdAt) : NaN;
  if (!eventId || !threadId || !Number.isFinite(timestamp)) return null;
  const row = { eventId, threadId, type: raw.type, ts: new Date(timestamp).toISOString() };
  for (const key of ["turnId", "provider", "providerInstanceId"]) {
    const value = identity(raw[key]);
    if (value) row[key] = value;
  }
  if (raw.type === "turn.completed") {
    if (typeof raw.ok === "boolean") row.ok = raw.ok;
    if (telemetryIdentifier(raw.servedModel)) row.model = raw.servedModel;
    row.tokens = {};
    for (const [native, target] of [["input", "input"], ["output", "output"], ["cachedInput", "cacheRead"], ["reasoning", "reasoning"]]) {
      const value = counter(raw.usage?.[native]);
      if (value !== undefined) row.tokens[target] = value;
    }
    const cacheWrites = [raw.usage?.cacheWrite5m, raw.usage?.cacheWrite1h].map(counter).filter((value) => value !== undefined);
    if (cacheWrites.length) {
      const value = counter(cacheWrites.reduce((sum, tokens) => sum + tokens, 0));
      if (value !== undefined) row.tokens.cacheCreation = value;
    }
  }
  return row;
}

const turnKey = (row) => row.turnId ? JSON.stringify([row.threadId, row.turnId, row.provider, row.providerInstanceId]) : null;

/** BotFleet turns are aggregates, never API calls; unknown timing stays an observation. */
export function botFleetRuntimeTelemetry(records, { producerInstanceId, since, until } = {}) {
  if (!identity(producerInstanceId)) throw new Error("Native BotFleet telemetry requires a stable host identity");
  const unique = new Map();
  for (const row of records) if (row && !unique.has(row.eventId)) unique.set(row.eventId, row);
  const starts = new Map();
  for (const row of unique.values()) {
    const key = turnKey(row);
    if (row.type !== "turn.started" || !key) continue;
    starts.set(key, starts.has(key) ? null : row.ts);
  }
  const events = [];
  for (const row of unique.values()) {
    if (row.type !== "turn.completed" || (since && Date.parse(row.ts) < since.getTime()) || (until && Date.parse(row.ts) > until.getTime())) continue;
    const start = starts.get(turnKey(row));
    const duration = start ? Date.parse(row.ts) - Date.parse(start) : undefined;
    const timed = Number.isFinite(duration) && duration >= 0;
    const span = timed && typeof row.ok === "boolean";
    events.push({
      eventId: createHash("sha256").update(JSON.stringify(["botfleet", producerInstanceId, row.eventId])).digest("hex"),
      platform: "botfleet", operation: "botfleet.turn", kind: span ? "span" : "log",
      ts: span ? start : row.ts, ...(timed ? { durationMs: duration } : {}),
      ...(row.model ? { model: row.model } : {}), tokens: row.tokens,
      ...(typeof row.ok === "boolean" ? { status: row.ok ? "ok" : "error" } : {}),
    });
  }
  return events;
}
