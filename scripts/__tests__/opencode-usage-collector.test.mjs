import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { UsageTelemetryV2BatchSchema } from "@jaywedgeworth22/congress-trading-shared";

import { collectOpencodeEvents } from "../opencode-usage-collector.mjs";
import { OPENCODE_PRODUCER_ID, parseOpencodeMessageRows } from "../lib/session-token-collectors.mjs";
import {
  OPENCODE_SESSION_ID_CUTOFF_MS,
  resolveOpencodeSessionIdCutoffMs,
} from "../lib/opencode-session-telemetry.mjs";

const SESSION_ID = "ses_fixture";
const MESSAGE_ID = "msg_assistant_paid";
const FREE_MESSAGE_ID = "msg_assistant_free";
const CONTEXT_LIMIT = 1_000_000;
const BASE_MS = 1_792_000_000_000;

const PAID_MESSAGE = {
  time: { created: BASE_MS, completed: BASE_MS + 1_000 },
  model: { id: "demo-model-1", providerID: "opencode", variant: "max" },
  tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 200, write: 0 } },
  cost: 0.0123,
  agent: "build",
  finish: "stop",
};

const FREE_MESSAGE = {
  time: { created: BASE_MS + 2_000, completed: BASE_MS + 3_000 },
  model: { id: "demo-model-1", providerID: "opencode", variant: "max" },
  tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
  cost: 0,
};

const COMPACTION_MESSAGE = {
  time: { created: BASE_MS + 4_000 },
  status: "completed",
  reason: "auto",
  model: { id: "demo-model-1", providerID: "opencode" },
  metadata: { keepID: "msg_kept" },
};

const MODEL_SWITCH_MESSAGE = {
  time: { created: BASE_MS + 5_000 },
  model: { id: "demo-model-2", providerID: "opencode" },
};

let harnessRoot = "";
let dbPath = "";

function catalogValue() {
  const body = {
    opencode: {
      models: {
        "demo-model-1": { limit: { context: CONTEXT_LIMIT, output: 32_000 } },
        "demo-model-2": { limit: { context: 250_000 } },
      },
    },
    other: {
      models: {
        "demo-model-1": { limit: { context: 424_242 } },
      },
    },
  };
  return JSON.stringify({
    updatedAt: "2026-10-20T00:00:00.000Z",
    digest: "fixture",
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  harnessRoot = await mkdtemp(join(tmpdir(), "opencode-collector-"));
  dbPath = join(harnessRoot, "opencode.db");
  const db = new DatabaseSync(dbPath);
  db.exec(
    "CREATE TABLE session_v2 (" +
      "id text PRIMARY KEY, project_id text, workspace_id text, parent_id text, slug text, " +
      "directory text, path text, title text, version text, metadata text, cost real, " +
      "tokens_input integer, tokens_output integer, tokens_reasoning integer, " +
      "tokens_cache_read integer, tokens_cache_write integer, summary_additions integer, " +
      "summary_deletions integer, summary_files integer, model text, agent text, " +
      "time_created integer, time_updated integer, time_compacting integer, " +
      "time_archived integer, resume_attempts integer)",
  );
  db.exec(
    "CREATE TABLE session_message (" +
      "id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL, " +
      "time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)",
  );
  db.exec(
    "CREATE INDEX session_message_session_id_type_seq_idx ON session_message (session_id, type, seq)",
  );
  db.exec(
    "CREATE INDEX session_message_session_id_time_created_id_idx ON session_message (session_id, time_created, id)",
  );
  db.exec(
    "CREATE TABLE project (" +
      "id text PRIMARY KEY, worktree text, vcs text, name text, icon_url text, " +
      "icon_url_override text, icon_color text, time_created integer, time_updated integer)",
  );
  db.exec("CREATE TABLE kv (key text PRIMARY KEY, value text)");

  db.prepare(
    "INSERT INTO session_v2 (id, project_id, directory, title, cost, tokens_input, " +
      "tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, " +
      "summary_additions, summary_deletions, summary_files, time_created, time_updated) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    SESSION_ID,
    "proj_fixture",
    "/Users/jay/Code/Demo-Project",
    "Fixture session",
    0.0123,
    110,
    55,
    10,
    200,
    0,
    3,
    1,
    2,
    BASE_MS,
    BASE_MS + 5_000,
  );
  // The project row has no name, so the directory basename names the project.
  db.prepare("INSERT INTO project (id, worktree, vcs, name) VALUES (?, ?, ?, ?)").run(
    "proj_fixture",
    "/Users/jay/Code/Demo-Project",
    "git",
    null,
  );

  const insertMessage = db.prepare(
    "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  insertMessage.run(
    MESSAGE_ID,
    SESSION_ID,
    "assistant",
    1,
    BASE_MS,
    BASE_MS + 1_000,
    JSON.stringify(PAID_MESSAGE),
  );
  insertMessage.run(
    FREE_MESSAGE_ID,
    SESSION_ID,
    "assistant",
    2,
    BASE_MS + 2_000,
    BASE_MS + 3_000,
    JSON.stringify(FREE_MESSAGE),
  );
  insertMessage.run(
    "msg_user",
    SESSION_ID,
    "user",
    3,
    BASE_MS + 2_500,
    BASE_MS + 2_500,
    JSON.stringify({ time: { created: BASE_MS + 2_500 } }),
  );
  insertMessage.run(
    "msg_system",
    SESSION_ID,
    "system",
    4,
    BASE_MS + 2_600,
    BASE_MS + 2_600,
    JSON.stringify({ time: { created: BASE_MS + 2_600 } }),
  );
  insertMessage.run(
    "msg_compaction",
    SESSION_ID,
    "compaction",
    5,
    BASE_MS + 4_000,
    BASE_MS + 4_000,
    JSON.stringify(COMPACTION_MESSAGE),
  );
  insertMessage.run(
    "msg_model_switch",
    SESSION_ID,
    "model-switched",
    6,
    BASE_MS + 5_000,
    BASE_MS + 5_000,
    JSON.stringify(MODEL_SWITCH_MESSAGE),
  );

  db.prepare("INSERT INTO kv (key, value) VALUES (?, ?)").run(
    "models-dev:catalog",
    catalogValue(),
  );
  db.close();
});

afterAll(async () => {
  if (harnessRoot) await rm(harnessRoot, { recursive: true, force: true });
});

async function collect(options = {}) {
  // sessionIdCutoffMs: 0 previews the shape the collector sends once the
  // session-id boundary has been set (the session id on every token row).
  // The collector itself previews the shape THIS run sends, so a real
  // --dry-run pass uses the resolved boundary instead.
  return collectOpencodeEvents({ dbPath, since: new Date(0), sessionIdCutoffMs: 0, ...options });
}

function byLabel(events, prefix) {
  return events.filter((event) => typeof event.label === "string" && event.label.startsWith(prefix));
}

describe("opencode collector telemetry", () => {
  it("sends the session project as the top-level project field on every event", async () => {
    const events = await collect();
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.project).toBe("Demo-Project");
      expect(event.metadata.project).toBe("Demo-Project");
    }
  });

  it("carries the session id in metadata on every event", async () => {
    const events = await collect();
    for (const event of events) {
      expect(event.metadata.sessionId).toBe(SESSION_ID);
    }
  });

  it("emits a cost event only for the message that reported a real cost", async () => {
    const events = await collect();
    const costEvents = events.filter((event) => event.metricType === "cost");
    expect(costEvents).toHaveLength(1);
    expect(costEvents[0].costUsd).toBeCloseTo(0.0123, 10);
    expect(costEvents[0].label).toBe("api-equivalent");
    expect(costEvents[0].unit).toBe("usd");
    expect(costEvents[0].metadata.sessionId).toBe(SESSION_ID);
    // The zero-cost (free tier) message produced no cost event.
    const freeCostEvents = costEvents.filter((event) => event.occurredAt === new Date(BASE_MS + 3_000).toISOString());
    expect(freeCostEvents).toHaveLength(0);
  });

  it("reports context utilization with the catalog limit, remaining credits and token quantity", async () => {
    const events = await collect();
    const contextEvents = byLabel(events, "context:");
    expect(contextEvents).toHaveLength(2);

    const paid = contextEvents.find((event) => event.occurredAt === new Date(BASE_MS + 1_000).toISOString());
    expect(paid).toBeDefined();
    expect(paid.metricType).toBe("quota");
    expect(paid.unit).toBe("token");
    // input 100 + cache.read 200 + output 50
    expect(paid.quantity).toBe(350);
    expect(paid.metadata.contextTokens).toBe(350);
    expect(paid.metadata.contextLimit).toBe(CONTEXT_LIMIT);
    // UM reads a quota row's remaining percent as credits / limit * 100, so
    // limit is the percent scale (100) and credits is the percent remaining.
    expect(paid.limit).toBe(100);
    expect(paid.credits).toBeCloseTo(99.97, 2);
    expect(paid.metadata.contextUsedPercent).toBeCloseTo(0.03, 2);
    expect(paid.metadata.contextRemainingPercent).toBeCloseTo(99.97, 2);
    expect(paid.metadata.quotaWindow).toBe("context");
    expect(paid.metadata.sessionId).toBe(SESSION_ID);
  });

  it("keeps the token rows byte-identical to the shared parser and adds no token rows", async () => {
    const events = await collect();
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db
      .prepare(
        "SELECT id, session_id, data FROM session_message WHERE type = 'assistant' AND time_updated >= ? ORDER BY time_created, id",
      )
      .all(0);
    db.close();

    const parserEvents = parseOpencodeMessageRows(rows);
    const tokenEvents = byLabel(events, "token:");
    expect(tokenEvents).toHaveLength(parserEvents.length);
    expect(tokenEvents.map((event) => event.eventId)).toEqual(parserEvents.map((event) => event.eventId));
    // The new rows carry a different label, so none of them is a token row.
    expect(tokenEvents.every((event) => event.unit === "token" && event.metricType === "usage")).toBe(true);
  });

  it("keeps a token row in its stored shape until the session-id cutoff passes", async () => {
    // Usage Monitor answers HTTP 409 when a replayed row differs from the
    // stored one in any compared field, so a token row completed before the
    // cutoff must not carry metadata.sessionId yet.
    const events = await collect({ sessionIdCutoffMs: BASE_MS + 10_000 });
    const tokenEvents = byLabel(events, "token:");
    expect(tokenEvents.length).toBeGreaterThan(0);
    expect(tokenEvents.every((event) => event.metadata.sessionId === undefined)).toBe(true);
    // The rows this feature adds always carry the session id.
    expect(events.filter((event) => event.label === "session")[0].metadata.sessionId).toBe(SESSION_ID);
  });

  it("defaults the session-id boundary to never, so a deploy cannot conflict", async () => {
    // The default has to be the safe one.  A hardcoded instant in the past
    // would re-shape the rows Usage Monitor already stored as soon as the
    // collector is installed, which is exactly the 409 the boundary exists to
    // prevent.
    const cutoff = resolveOpencodeSessionIdCutoffMs({});
    expect(cutoff).toBe(OPENCODE_SESSION_ID_CUTOFF_MS);
    const events = await collect({ sessionIdCutoffMs: cutoff });
    const tokenEvents = byLabel(events, "token:");
    expect(tokenEvents.length).toBeGreaterThan(0);
    expect(tokenEvents.every((event) => event.metadata.sessionId === undefined)).toBe(true);
    // The rows this feature adds always carry the session id.
    expect(events.filter((event) => event.label === "session")[0].metadata.sessionId).toBe(SESSION_ID);
  });

  it("takes the session-id boundary from the environment and refuses a bad one", () => {
    expect(resolveOpencodeSessionIdCutoffMs({ OPENCODE_SESSION_ID_CUTOFF_MS: "1792000000000" })).toBe(
      1_792_000_000_000,
    );
    expect(resolveOpencodeSessionIdCutoffMs({ OPENCODE_SESSION_ID_CUTOFF_MS: " 1792000000000 " })).toBe(
      1_792_000_000_000,
    );
    // A typo in the plist falls back to the safe default rather than to a
    // boundary that would re-shape rows Usage Monitor already stored.
    for (const bad of ["", "   ", "not-a-number", "-1", "NaN"]) {
      expect(resolveOpencodeSessionIdCutoffMs({ OPENCODE_SESSION_ID_CUTOFF_MS: bad })).toBe(
        OPENCODE_SESSION_ID_CUTOFF_MS,
      );
    }
  });

  it("emits one session-fact row per session and does not duplicate it on a second pass", async () => {
    const first = await collect();
    const second = await collect();
    const firstSessionRows = first.filter((event) => event.label === "session");
    const secondSessionRows = second.filter((event) => event.label === "session");
    expect(firstSessionRows).toHaveLength(1);
    expect(secondSessionRows).toHaveLength(1);
    expect(secondSessionRows[0].eventId).toBe(firstSessionRows[0].eventId);

    const sessionRow = firstSessionRows[0];
    expect(sessionRow.metricType).toBe("usage");
    expect(sessionRow.unit).toBe("row");
    expect(sessionRow.metadata.sessionTitle).toBe("Fixture session");
    expect(sessionRow.metadata.sessionCreatedAt).toBe(new Date(BASE_MS).toISOString());
    expect(sessionRow.metadata.sessionLastActivityAt).toBe(new Date(BASE_MS + 5_000).toISOString());
    expect(sessionRow.metadata.messageCountAssistant).toBe(2);
    expect(sessionRow.metadata.messageCountUser).toBe(1);
    expect(sessionRow.metadata.messageCountSystem).toBe(1);
    expect(sessionRow.metadata.messageCountCompaction).toBe(1);
    expect(sessionRow.metadata.messageCountModelSwitched).toBe(1);
    expect(sessionRow.metadata.filesChangedAdditions).toBe(3);
    expect(sessionRow.metadata.filesChangedDeletions).toBe(1);
    expect(sessionRow.metadata.filesChangedFiles).toBe(2);
    expect(sessionRow.metadata.sessionCostUsd).toBeCloseTo(0.0123, 10);
    // The session cost stays in metadata: the per-message cost event already
    // carries the cash, and a top-level costUsd would double count it.
    expect(sessionRow.costUsd).toBeUndefined();
  });

  it("emits lifecycle rows for compaction and model switches", async () => {
    const events = await collect();
    const lifecycle = byLabel(events, "lifecycle:");
    expect(lifecycle.map((event) => event.label).sort()).toEqual([
      "lifecycle:compaction",
      "lifecycle:model-switched",
    ]);
    const compaction = lifecycle.find((event) => event.label === "lifecycle:compaction");
    expect(compaction.metadata.lifecycle).toBe("compaction");
    expect(compaction.metadata.compactionReason).toBe("auto");
    expect(compaction.metadata.compactionKeepId).toBe("msg_kept");
    expect(compaction.metadata.sessionId).toBe(SESSION_ID);
    expect(compaction.metadata.project).toBe("Demo-Project");
    expect(compaction.unit).toBe("row");
  });

  it("keeps every event inside the shared v2 contract", async () => {
    const events = await collect();
    const parsed = UsageTelemetryV2BatchSchema.safeParse({
      schemaVersion: 2,
      producerId: OPENCODE_PRODUCER_ID,
      producerInstanceId: "test-host",
      events,
    });
    expect(parsed.success).toBe(true);
  });

  it("tolerates a database without the session, project or catalog tables", async () => {
    const barePath = join(harnessRoot, "bare.db");
    const db = new DatabaseSync(barePath);
    db.exec(
      "CREATE TABLE session_message (" +
        "id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL, " +
        "time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)",
    );
    db.prepare(
      "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      MESSAGE_ID,
      SESSION_ID,
      "assistant",
      1,
      BASE_MS,
      BASE_MS + 1_000,
      JSON.stringify(PAID_MESSAGE),
    );
    db.close();

    const events = await collectOpencodeEvents({ dbPath: barePath, since: new Date(0) });
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.project === undefined)).toBe(true);
    expect(byLabel(events, "context:")).toHaveLength(0);
    expect(events.filter((event) => event.label === "session")).toHaveLength(0);
  });
});
