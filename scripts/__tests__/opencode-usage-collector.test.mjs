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
const NO_LIMIT_MESSAGE_ID = "msg_assistant_no_limit";
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

// The catalog publishes demo-model-1 under two providers, but NOT under the
// provider this message used, so the collector has no limit for it.  The row
// still reports the used tokens and leaves the limit null.
const NO_LIMIT_MESSAGE = {
  time: { created: BASE_MS + 6_000, completed: BASE_MS + 6_500 },
  model: { id: "demo-model-1", providerID: "meta" },
  tokens: { input: 20, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
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
  insertMessage.run(
    NO_LIMIT_MESSAGE_ID,
    SESSION_ID,
    "assistant",
    7,
    BASE_MS + 6_000,
    BASE_MS + 6_500,
    JSON.stringify(NO_LIMIT_MESSAGE),
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

  it("reports context utilization with the catalog limit, remaining percent and token quantity", async () => {
    const events = await collect();
    const contextEvents = byLabel(events, "context:");
    expect(contextEvents).toHaveLength(3);

    const paid = contextEvents.find((event) => event.occurredAt === new Date(BASE_MS + 1_000).toISOString());
    expect(paid).toBeDefined();
    // metricType "limit" keeps the row out of the subscription quota panels
    // (UM's quota loader filters metricType = 'quota') and out of every
    // token total (UM sums metricType "usage" with unit "token").
    expect(paid.metricType).toBe("limit");
    expect(paid.metricType).not.toBe("quota");
    expect(paid.unit).toBe("token");
    // input 100 + cache.read 200 + output 50 + reasoning 10, which is the
    // same total the token rows report for this message.
    expect(paid.quantity).toBe(360);
    expect(paid.metadata.contextTokens).toBe(360);
    expect(paid.metadata.contextLimit).toBe(CONTEXT_LIMIT);
    expect(paid.limit).toBe(CONTEXT_LIMIT);
    expect(paid.metadata.contextUsedPercent).toBeCloseTo(0.04, 3);
    expect(paid.metadata.contextRemainingPercent).toBeCloseTo(99.96, 3);
    // No quota shape leaks into the row.
    expect(paid.credits).toBeUndefined();
    expect(paid.metadata.quotaWindow).toBeUndefined();
    expect(paid.metadata.sessionId).toBe(SESSION_ID);
  });

  it("keeps the context row out of the token totals and the quota windows", async () => {
    const events = await collect();
    for (const event of events) {
      // UM sums tokens ONLY from metricType "usage" with unit "token".
      if (event.label.startsWith("token:")) {
        expect(event.metricType).toBe("usage");
        expect(event.unit).toBe("token");
      }
      // UM builds the quota windows ONLY from metricType "quota".
      if (event.label.startsWith("context:")) {
        expect(event.metricType).not.toBe("quota");
        expect(event.metricType).not.toBe("usage");
      }
    }
    const contextEvents = byLabel(events, "context:");
    expect(contextEvents.every((event) => event.metricType === "limit")).toBe(true);
  });

  it("reports the used tokens with a null limit when the catalog has no window for the provider", async () => {
    const events = await collect();
    const noLimit = byLabel(events, "context:").find(
      (event) => event.occurredAt === new Date(BASE_MS + 6_500).toISOString(),
    );
    expect(noLimit).toBeDefined();
    // The model is published under another provider in the catalog (424242),
    // so that window must not be borrowed for this provider.
    expect(noLimit.metadata.contextLimit).toBeNull();
    expect(noLimit.limit).toBeUndefined();
    expect(noLimit.metadata.contextUsedPercent).toBeNull();
    expect(noLimit.quantity).toBe(20);
  });

  it("keeps the session fact for a session created before the window", async () => {
    // The window covers only the last message, so the session is discovered
    // through it even though the session itself was created before the window.
    // Its fact row is dated at the creation instant, so the window filter must
    // not drop it: the one row per session would otherwise never be sent for
    // any session that outlives a collection window.
    const events = await collect({ since: new Date(BASE_MS + 6_000) });
    const sessionRows = events.filter((event) => event.label === "session");
    expect(sessionRows).toHaveLength(1);
    expect(sessionRows[0].occurredAt).toBe(new Date(BASE_MS).toISOString());
    expect(sessionRows[0].metadata.sessionCreatedAt).toBe(new Date(BASE_MS).toISOString());
    // The rows that belong to the window are still filtered by it.
    const outsideWindow = events.filter(
      (event) => event.label !== "session" && Date.parse(event.occurredAt) < BASE_MS + 6_000,
    );
    expect(outsideWindow).toHaveLength(0);
  });

  it("counts cache-write tokens in the context total, like the token rows do", async () => {
    // The token rows report cache-write tokens as a cacheCreation row, and
    // those tokens occupy the prompt cache and therefore the window.
    const cacheWriteId = "msg_assistant_cache_write";
    const db = new DatabaseSync(dbPath);
    db.prepare(
      "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      cacheWriteId,
      SESSION_ID,
      "assistant",
      8,
      BASE_MS + 7_000,
      BASE_MS + 7_500,
      JSON.stringify({
        time: { created: BASE_MS + 7_000, completed: BASE_MS + 7_500 },
        model: { id: "demo-model-1", providerID: "opencode" },
        tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 20, write: 40 } },
        cost: 0,
      }),
    );
    db.close();

    try {
      const events = await collect();
      const context = events.find(
        (event) => event.label.startsWith("context:") && event.occurredAt === new Date(BASE_MS + 7_500).toISOString(),
      );
      expect(context).toBeDefined();
      // input 10 + cache.read 20 + cache.write 40 + output 5.
      expect(context.quantity).toBe(75);
      expect(context.metadata.contextTokens).toBe(75);
      // The token rows the context total claims to match: assert them, or this
      // test passes even when the cache-write contribution is missing from one
      // side of the equality.
      const tokenRows = events
        .filter(
          (event) =>
            event.label.startsWith("token:") &&
            event.occurredAt === new Date(BASE_MS + 7_500).toISOString(),
        )
        .map((event) => [event.label, event.quantity])
        .sort(([left], [right]) => left.localeCompare(right));
      expect(tokenRows).toEqual([
        ["token:cacheCreation", 40],
        ["token:cacheRead", 20],
        ["token:input", 10],
        ["token:output", 5],
      ]);
      expect(
        tokenRows.reduce((total, [, quantity]) => total + quantity, 0),
      ).toBe(context.metadata.contextTokens);
    } finally {
      const cleanup = new DatabaseSync(dbPath);
      cleanup.prepare("DELETE FROM session_message WHERE id = ?").run(cacheWriteId);
      cleanup.close();
    }
  });

  it("validates the token payload before it reaches the context row", async () => {
    const warnings = [];
    const malformedId = "msg_assistant_malformed_tokens";
    const negativeId = "msg_assistant_negative_tokens";
    const shapeId = "msg_assistant_token_shape";
    const db = new DatabaseSync(dbPath);
    const insert = db.prepare(
      "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    // The cache write is an object, so it is not a token count at all.  The
    // token row counts it as zero, so the context row counts it as zero too:
    // the context metric is not lost and the totals still match.
    insert.run(
      malformedId,
      SESSION_ID,
      "assistant",
      8,
      BASE_MS + 7_000,
      BASE_MS + 7_500,
      JSON.stringify({
        time: { created: BASE_MS + 7_000, completed: BASE_MS + 7_500 },
        model: { id: "demo-model-1", providerID: "opencode" },
        tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 20, write: { nested: true } } },
        cost: 0,
      }),
    );
    // A negative count is not a count either: it is zero, the same as it is
    // on the token row, so the context total still matches the token rows.
    insert.run(
      negativeId,
      SESSION_ID,
      "assistant",
      9,
      BASE_MS + 8_000,
      BASE_MS + 8_500,
      JSON.stringify({
        time: { created: BASE_MS + 8_000, completed: BASE_MS + 8_500 },
        model: { id: "demo-model-1", providerID: "opencode" },
        tokens: { input: -5, output: 5, reasoning: 0, cache: { read: 20, write: 0 } },
        cost: 0,
      }),
    );
    // A token payload that is not an object at all is not a payload the token
    // parser can read either: the message gets no token rows, so it gets no
    // context row, and the shape change is reported in the run log.
    insert.run(
      shapeId,
      SESSION_ID,
      "assistant",
      10,
      BASE_MS + 9_000,
      BASE_MS + 9_500,
      JSON.stringify({
        time: { created: BASE_MS + 9_000, completed: BASE_MS + 9_500 },
        model: { id: "demo-model-1", providerID: "opencode" },
        tokens: "not-an-object",
        cost: 0,
      }),
    );
    // A second message with the same shape: the shape is reported once per
    // run, so a systematic payload change cannot flood the run log.
    insert.run(
      `${shapeId}_again`,
      SESSION_ID,
      "assistant",
      11,
      BASE_MS + 10_000,
      BASE_MS + 10_500,
      JSON.stringify({
        time: { created: BASE_MS + 10_000, completed: BASE_MS + 10_500 },
        model: { id: "demo-model-1", providerID: "opencode" },
        tokens: "not-an-object",
        cost: 0,
      }),
    );
    db.close();

    try {
      const events = await collect({ onWarning: (message) => warnings.push(message) });
      const malformedIso = new Date(BASE_MS + 7_500).toISOString();
      const negativeIso = new Date(BASE_MS + 8_500).toISOString();
      const shapeIso = new Date(BASE_MS + 9_500).toISOString();
      // The malformed count is zero on both sides, so the context row is
      // still sent and its total still matches the token rows' total.
      const malformedContext = events.find(
        (event) => event.label.startsWith("context:") && event.occurredAt === malformedIso,
      );
      expect(malformedContext.metadata.contextTokens).toBe(35);
      const malformedTokens = events
        .filter((event) => event.label.startsWith("token:") && event.occurredAt === malformedIso)
        .reduce((total, event) => total + event.quantity, 0);
      expect(malformedTokens).toBe(malformedContext.metadata.contextTokens);
      // A payload that is not the expected shape produces NO context row: a
      // guessed total would break the promise that the context row equals the
      // token rows' total for the same message.
      expect(
        events.find(
          (event) => event.label.startsWith("context:") && event.occurredAt === shapeIso,
        ),
      ).toBeUndefined();
      // ...and it is reported, so the gap is visible in the run log.
      expect(warnings.some((message) => message.includes(shapeId))).toBe(true);
      // The shape is reported once per run, not once per message.
      const shapeWarnings = warnings.filter((message) =>
        message.includes("not the expected shape"),
      );
      expect(shapeWarnings.length).toBe(1);
      // The negative count is zero on both sides, so the totals still match.
      const negativeContext = events.find(
        (event) => event.label.startsWith("context:") && event.occurredAt === negativeIso,
      );
      expect(negativeContext.metadata.contextTokens).toBe(25);
      const negativeTokens = events
        .filter((event) => event.label.startsWith("token:") && event.occurredAt === negativeIso)
        .reduce((total, event) => total + event.quantity, 0);
      expect(negativeTokens).toBe(negativeContext.metadata.contextTokens);
    } finally {
      const cleanup = new DatabaseSync(dbPath);
      cleanup
        .prepare("DELETE FROM session_message WHERE id IN (?, ?, ?, ?)")
        .run(malformedId, negativeId, shapeId, `${shapeId}_again`);
      cleanup.close();
    }
  });

  it("gives a rewritten raw provider id its own context event id", async () => {
    const { opencodeContextEvent } = await import("../lib/opencode-session-telemetry.mjs");
    const base = {
      sessionId: SESSION_ID,
      messageId: MESSAGE_ID,
      modelId: "demo-model-1",
      contextTokens: 360,
      contextLimit: CONTEXT_LIMIT,
      occurredAtIso: new Date(BASE_MS + 1_000).toISOString(),
    };
    // "meta" and "muse-1" both normalize to the vendor "muse-code", but Usage
    // Monitor compares metadata.providerId, so the two rows must not share an
    // id: a shared id would 409 the whole batch on the rewritten provider.
    const meta = opencodeContextEvent({ ...base, providerId: "meta", provider: "muse-code" });
    const muse = opencodeContextEvent({ ...base, providerId: "muse-1", provider: "muse-code" });
    expect(meta.metadata.providerId).toBe("meta");
    expect(muse.metadata.providerId).toBe("muse-1");
    expect(meta.eventId).not.toBe(muse.eventId);
    // The same raw id still replays byte-identically.
    const again = opencodeContextEvent({ ...base, providerId: "meta", provider: "muse-code" });
    expect(again.eventId).toBe(meta.eventId);
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

  it("emits one stable session-fact row per session and one snapshot row", async () => {
    const first = await collect();
    const second = await collect();
    const firstSessionRows = first.filter((event) => event.label === "session");
    const secondSessionRows = second.filter((event) => event.label === "session");
    expect(firstSessionRows).toHaveLength(1);
    expect(secondSessionRows).toHaveLength(1);
    // The id is the session's, so a replay dedupes instead of storing the
    // same fact again.
    expect(secondSessionRows[0].eventId).toBe(firstSessionRows[0].eventId);

    const sessionRow = firstSessionRows[0];
    expect(sessionRow.metricType).toBe("usage");
    expect(sessionRow.unit).toBe("row");
    // The row counts the session; it never re-reports the session's totals,
    // so a pass can never inflate a usage rollup.
    expect(sessionRow.quantity).toBe(1);
    expect(sessionRow.metadata.sessionId).toBe(SESSION_ID);
    expect(sessionRow.metadata.sessionCreatedAt).toBe(new Date(BASE_MS).toISOString());
    expect(sessionRow.occurredAt).toBe(new Date(BASE_MS).toISOString());

    const snapshots = first.filter((event) => event.label === "session-snapshot");
    expect(snapshots).toHaveLength(1);
    const snapshot = snapshots[0];
    expect(snapshot.unit).toBe("row");
    expect(snapshot.quantity).toBe(1);
    expect(snapshot.metadata.sessionId).toBe(SESSION_ID);
    expect(snapshot.metadata.sessionTitle).toBe("Fixture session");
    expect(snapshot.metadata.sessionLastActivityAt).toBe(new Date(BASE_MS + 6_000).toISOString());
    expect(snapshot.metadata.messageCountAssistant).toBe(3);
    expect(snapshot.metadata.messageCountUser).toBe(1);
    expect(snapshot.metadata.messageCountSystem).toBe(1);
    expect(snapshot.metadata.messageCountCompaction).toBe(1);
    expect(snapshot.metadata.messageCountModelSwitched).toBe(1);
    expect(snapshot.metadata.filesChangedAdditions).toBe(3);
    expect(snapshot.metadata.filesChangedDeletions).toBe(1);
    expect(snapshot.metadata.filesChangedFiles).toBe(2);
    expect(snapshot.metadata.sessionCostUsd).toBeCloseTo(0.0123, 10);
    // The session cost stays in metadata: the per-message cost event already
    // carries the cash, and a top-level costUsd would double count it.
    expect(snapshot.costUsd).toBeUndefined();
  });

  it("keeps the session-fact id stable when the session moves on", async () => {
    const first = await collect();
    const firstSession = first.find((event) => event.label === "session");
    const firstSnapshot = first.find((event) => event.label === "session-snapshot");

    // The session keeps working: its last activity and its counters move.
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE session_v2 SET time_updated = ? WHERE id = ?").run(BASE_MS + 9_000, SESSION_ID);
    db.close();

    const second = await collect();
    const secondSession = second.find((event) => event.label === "session");
    const secondSnapshot = second.find((event) => event.label === "session-snapshot");

    // The session fact did not change, so its id did not change either: the
    // replay dedupes against the stored row.
    expect(secondSession.eventId).toBe(firstSession.eventId);
    expect(secondSession.metadata).toEqual(firstSession.metadata);
    // The moving state is reported by the snapshot row, whose id is the hash
    // of the snapshot, so a changed snapshot is a new row and never a
    // conflict against the stored one.
    expect(secondSnapshot.eventId).not.toBe(firstSnapshot.eventId);
  });

  it("keeps the session-fact id stable when the project is named", async () => {
    const first = await collect();
    const firstSession = first.find((event) => event.label === "session");
    // The fixture's project row has no name, so the project is the directory
    // basename.  opencode fills the name in later, which is exactly the moment
    // a project-derived id would fork.
    expect(firstSession.metadata.project).toBe("Demo-Project");

    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE project SET name = ? WHERE id = ?").run("Named-Project", "proj_fixture");
    db.close();

    try {
      const second = await collect();
      const secondSession = second.find((event) => event.label === "session");
      // The emitted row still carries the current name...
      expect(secondSession.metadata.project).toBe("Named-Project");
      // ...but the id did not move, because Usage Monitor strips
      // metadata.project before it compares a replay: a new id would store a
      // SECOND fact row for the same session rather than dedupe against it.
      expect(secondSession.eventId).toBe(firstSession.eventId);
    } finally {
      const cleanup = new DatabaseSync(dbPath);
      cleanup.prepare("UPDATE project SET name = ? WHERE id = ?").run(null, "proj_fixture");
      cleanup.close();
    }
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

  it("resolves the lifecycle provider from the row itself, not from the window", async () => {
    const events = await collect();
    const lifecycle = byLabel(events, "lifecycle:");
    // The rows name their own model, so the provider does not move when the
    // assistant rows of the current window age out.
    const compaction = lifecycle.find((event) => event.label === "lifecycle:compaction");
    expect(compaction.provider).toBe("opencode");
    expect(compaction.metadata.providerId).toBe("opencode");
    // The event id covers the content, so a replay of the same row dedupes.
    const again = await collect();
    const againCompaction = byLabel(again, "lifecycle:").find(
      (event) => event.label === "lifecycle:compaction",
    );
    expect(againCompaction.eventId).toBe(compaction.eventId);
  });

  it("keeps the models.dev catalog usable when one field, vendor or model drifts", async () => {
    const { parseModelsDevCatalog } = await import("../lib/opencode-session-telemetry.mjs");
    // A cached value with no usable body at all is reported, not guessed at.
    const broken = parseModelsDevCatalog("not json");
    expect(broken.problem).toBeTruthy();
    expect(broken.limitFor("opencode", "demo-model-1")).toBeNull();
    expect(parseModelsDevCatalog(JSON.stringify({ updatedAt: 1, digest: "d", body: 5 })).problem).toBeTruthy();
    // A catalog that was never cached is the normal state on a fresh
    // install, so it gets its own message and is not called corrupt.
    expect(parseModelsDevCatalog(null).problem).toContain("missing");
    expect(parseModelsDevCatalog("   ").problem).toContain("missing");

    // A body that is already an object is usable, and the known-shape
    // envelope is accepted without a word.
    const tolerant = parseModelsDevCatalog(
      JSON.stringify({
        updatedAt: 1,
        digest: "fixture",
        body: { opencode: { models: { "demo-model-1": { limit: { context: 1000 } } } } },
      }),
    );
    expect(tolerant.problem).toBeNull();
    expect(tolerant.warning).toBeNull();
    expect(tolerant.limitFor("opencode", "demo-model-1")).toBe(1000);

    // An unknown top-level key is a shape violation, so it is REPORTED
    // instead of being swallowed, and the known limits still work: one odd
    // field can never erase every vendor's limits.
    const unknownKey = parseModelsDevCatalog(
      JSON.stringify({
        updatedAt: 1,
        digest: "fixture",
        somethingNew: { nested: true },
        body: { opencode: { models: { "demo-model-1": { limit: { context: 1000 } } } } },
      }),
    );
    expect(unknownKey.problem).toBeNull();
    expect(unknownKey.warning).toContain("somethingNew");
    expect(unknownKey.limitFor("opencode", "demo-model-1")).toBe(1000);

    // A malformed vendor is skipped, the other vendors keep their limits.
    const catalog = parseModelsDevCatalog(
      JSON.stringify({
        updatedAt: "2026-10-20T00:00:00.000Z",
        digest: "fixture",
        body: JSON.stringify({
          good: { models: { "m1": { limit: { context: 1000 } } } },
          bad: { models: { "m2": { limit: { context: "huge" } } } },
          // One malformed model costs only itself, not its siblings.
          mixed: { models: { "m3": { limit: { context: "huge" } }, "m4": { limit: { context: 2000 } } } },
        }),
      }),
    );
    expect(catalog.problem).toBeNull();
    expect(catalog.warning).toBeNull();
    expect(catalog.limitFor("good", "m1")).toBe(1000);
    expect(catalog.limitFor("bad", "m2")).toBeNull();
    expect(catalog.limitFor("mixed", "m3")).toBeNull();
    expect(catalog.limitFor("mixed", "m4")).toBe(2000);
  });

  it("says out loud when the cached catalog cannot be used", async () => {
    const warnings = [];
    const db = new DatabaseSync(dbPath);
    const original = db.prepare("SELECT value FROM kv WHERE key = ?").get("models-dev:catalog").value;
    db.prepare("UPDATE kv SET value = ? WHERE key = ?").run("not json", "models-dev:catalog");
    db.close();
    try {
      const events = await collectOpencodeEvents({
        dbPath,
        since: new Date(0),
        onWarning: (message) => warnings.push(message),
      });
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("models.dev catalog unusable");
      // The rows still report the used tokens, and the limit is null.
      const contextEvents = byLabel(events, "context:");
      expect(contextEvents.length).toBeGreaterThan(0);
      expect(contextEvents.every((event) => event.metadata.contextLimit === null)).toBe(true);
    } finally {
      // Put the catalog back in a finally block, so a failing expectation
      // cannot leave the shared fixture broken for every later test.
      const restore = new DatabaseSync(dbPath);
      restore.prepare("UPDATE kv SET value = ? WHERE key = ?").run(original, "models-dev:catalog");
      restore.close();
    }
  });

  it("says out loud when the cached catalog carries an unknown envelope key", async () => {
    const warnings = [];
    const db = new DatabaseSync(dbPath);
    const original = db.prepare("SELECT value FROM kv WHERE key = ?").get("models-dev:catalog").value;
    const body = JSON.stringify({
      opencode: { models: { "demo-model-1": { limit: { context: CONTEXT_LIMIT } } } },
    });
    db.prepare("UPDATE kv SET value = ? WHERE key = ?").run(
      JSON.stringify({ updatedAt: 1, digest: "fixture", somethingNew: { nested: true }, body }),
      "models-dev:catalog",
    );
    db.close();
    try {
      const events = await collectOpencodeEvents({
        dbPath,
        since: new Date(0),
        onWarning: (message) => warnings.push(message),
      });
      // The unknown key is reported, not swallowed.
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("models.dev catalog warning");
      expect(warnings[0]).toContain("somethingNew");
      // The valid limit still works: one odd field cannot erase every
      // vendor's limits.
      const contextEvents = byLabel(events, "context:");
      expect(contextEvents.length).toBeGreaterThan(0);
      expect(contextEvents.some((event) => event.metadata.contextLimit === CONTEXT_LIMIT)).toBe(true);
    } finally {
      const restore = new DatabaseSync(dbPath);
      restore.prepare("UPDATE kv SET value = ? WHERE key = ?").run(original, "models-dev:catalog");
      restore.close();
    }
  });

  it("gives a rewritten raw provider id its own cost event id", async () => {
    const { opencodeCostEvent } = await import("../lib/opencode-session-telemetry.mjs");
    const base = {
      sessionId: "ses_fixture",
      messageId: "msg_assistant_paid",
      modelId: "demo-model-1",
      provider: "muse-code",
      costUsd: 0.0123,
      occurredAtIso: new Date(BASE_MS + 1_000).toISOString(),
    };
    const first = opencodeCostEvent({ ...base, providerId: "muse" });
    const second = opencodeCostEvent({ ...base, providerId: "meta" });
    expect(first.eventId).not.toBe(second.eventId);
    expect(first.metadata.providerId).toBe("muse");
    expect(second.metadata.providerId).toBe("meta");
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
    // Without a catalog there is no context window, but the row still
    // reports the tokens the turn used and leaves the limit null.
    const contextEvents = byLabel(events, "context:");
    expect(contextEvents).toHaveLength(1);
    expect(contextEvents[0].metadata.contextLimit).toBeNull();
    expect(contextEvents[0].limit).toBeUndefined();
    expect(events.filter((event) => event.label === "session")).toHaveLength(0);
  });
});
