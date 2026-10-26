import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  collectMinimaxRuntimeEvents,
  MINIMAX_RUNTIME_PRODUCER_ID,
  normalizeRuntimeModel,
  runtimeRowToEvents,
} from "../minimax-runtime-usage-collector.mjs";

const BASE_MS = 1_792_900_000_000;
let dir;
let dbPath;

function insert(db, row) {
  db.prepare(
    `INSERT INTO local_runtime_token_usage
       (session_id, agent_name, framework_type, turn_id, model, ts,
        input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.session_id,
    row.agent_name,
    row.framework_type,
    row.turn_id,
    row.model,
    row.ts,
    row.input_tokens,
    row.output_tokens,
    row.reasoning_tokens,
    row.cache_read_tokens,
    row.cache_write_tokens,
    0
  );
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "minimax-runtime-test-"));
  dbPath = join(dir, "runtime-state.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(
    `CREATE TABLE local_runtime_token_usage (
       id INTEGER PRIMARY KEY,
       session_id TEXT NOT NULL,
       agent_name TEXT NOT NULL,
       framework_type TEXT NOT NULL,
       turn_id TEXT,
       model TEXT,
       ts INTEGER NOT NULL,
       input_tokens INTEGER NOT NULL,
       output_tokens INTEGER NOT NULL,
       reasoning_tokens INTEGER NOT NULL,
       cache_read_tokens INTEGER NOT NULL,
       cache_write_tokens INTEGER NOT NULL,
       cost_usd REAL,
       raw TEXT
     )`
  );
  insert(db, {
    session_id: "sess-1",
    agent_name: "mavis",
    framework_type: "pi-agent",
    turn_id: "turn-1",
    model: "minimax/MiniMax-M3.1-Flash",
    ts: BASE_MS,
    input_tokens: 438,
    output_tokens: 145,
    reasoning_tokens: 12,
    cache_read_tokens: 196096,
    cache_write_tokens: 0,
  });
  insert(db, {
    // The Mac build: model empty on every row.
    session_id: "sess-2",
    agent_name: "worker",
    framework_type: "pi-agent",
    turn_id: "turn-2",
    model: "",
    ts: BASE_MS + 60_000,
    input_tokens: 10,
    output_tokens: 20,
    reasoning_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 30,
  });
  insert(db, {
    // An all-zero housekeeping row carries no usage.
    session_id: "sess-2",
    agent_name: "worker",
    framework_type: "pi-agent",
    turn_id: "turn-3",
    model: null,
    ts: BASE_MS + 120_000,
    input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
  });
  db.close();
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("minimax-runtime-usage-collector", () => {
  it("normalizes the runtime's provider-prefixed model names", () => {
    expect(normalizeRuntimeModel("minimax/MiniMax-M3.1-Flash")).toBe("MiniMax-M3.1-Flash");
    expect(normalizeRuntimeModel("MiniMax-M2")).toBe("MiniMax-M2");
    expect(normalizeRuntimeModel("")).toBeUndefined();
    expect(normalizeRuntimeModel(null)).toBeUndefined();
  });

  it("maps a row to one event per non-zero token type", () => {
    const events = runtimeRowToEvents({
      id: 7,
      session_id: "sess-9",
      agent_name: "explore",
      framework_type: "pi-agent",
      model: "minimax/MiniMax-M3.1-Flash",
      ts: BASE_MS,
      input_tokens: 5,
      output_tokens: 6,
      reasoning_tokens: 2,
      cache_read_tokens: 7,
      cache_write_tokens: 0,
    });
    expect(events.map((e) => e.metadata.tokenType)).toEqual(["input", "output", "cacheRead"]);
    expect(events[0]).toMatchObject({
      provider: "minimax",
      service: "minimax-code",
      producerKeyRef: "MiniMax-M3.1-Flash",
      metricType: "usage",
      unit: "token",
    });
    expect(events[0].metadata).toMatchObject({
      collector: "runtime-db",
      agent: "explore",
      reasoningTokens: 2,
    });
    // Event ids are stable per runtime row, so a replay dedupes.
    const replay = runtimeRowToEvents({
      id: 7,
      session_id: "sess-9",
      agent_name: "explore",
      framework_type: "pi-agent",
      model: "minimax/MiniMax-M3.1-Flash",
      ts: BASE_MS,
      input_tokens: 5,
      output_tokens: 6,
      reasoning_tokens: 2,
      cache_read_tokens: 7,
      cache_write_tokens: 0,
    });
    expect(replay.map((e) => e.eventId)).toEqual(events.map((e) => e.eventId));
  });

  it("collects from the sqlite ledger, honoring the since bound", async () => {
    const all = await collectMinimaxRuntimeEvents({
      dbPath,
      since: new Date(BASE_MS - 1000),
    });
    // Row 1 -> 3 token types (no cache write), row 2 -> 3, row 3 -> none.
    expect(all).toHaveLength(6);
    expect(all.every((e) => e.provider === "minimax")).toBe(true);
    expect(MINIMAX_RUNTIME_PRODUCER_ID).toBe("minimax-code");

    const later = await collectMinimaxRuntimeEvents({
      dbPath,
      since: new Date(BASE_MS + 30_000),
    });
    expect(later).toHaveLength(3);
    expect(later[0].producerKeyRef).toBeUndefined();
  });

  it("returns nothing when the database does not exist", async () => {
    await expect(
      collectMinimaxRuntimeEvents({ dbPath: join(dir, "missing.sqlite"), since: new Date(0) })
    ).resolves.toEqual([]);
  });
});
