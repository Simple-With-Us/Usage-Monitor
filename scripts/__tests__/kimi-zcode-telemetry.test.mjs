import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { UsageTelemetryV2BatchSchema } from "@jaywedgeworth22/congress-trading-shared";

import { collectKimiEvents, kimiWireIdentity } from "../kimi-usage-collector.mjs";
import {
  KIMI_PRODUCER_ID,
  parseKimiSessionIndexJsonl,
  parseKimiUsageJsonl,
  parseZcodeModelUsageRows,
  ZCODE_PRODUCER_ID,
  zcodeProviderName,
  zcodeTokenBreakdown,
} from "../lib/kimi-zcode-telemetry.mjs";
import { collectZcodeEvents, readZcodeModelUsageRows } from "../zcode-usage-collector.mjs";

let tempRoot;

afterEach(async () => {
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

function kimiTurn(overrides = {}) {
  return {
    type: "usage.record",
    model: "kimi-k2",
    usage: {
      inputOther: 10,
      output: 5,
      inputCacheRead: 20,
      inputCacheCreation: 3,
    },
    usageScope: "turn",
    time: 1_779_256_800_302,
    ...overrides,
  };
}

describe("Kimi exact usage telemetry", () => {
  it("maps one durable turn record to exact token components", () => {
    const events = parseKimiUsageJsonl(JSON.stringify(kimiTurn()), {
      sessionKey: "workspace/session/agents/main/wire.jsonl",
      sessionId: "session",
      agentId: "main",
      project: "Usage-Monitor",
    });
    expect(events.map((event) => [event.label, event.quantity])).toEqual([
      ["token:input", 10],
      ["token:output", 5],
      ["token:cacheRead", 20],
      ["token:cacheCreation", 3],
    ]);
    expect(events.every((event) => event.provider === "moonshot")).toBe(true);
    expect(events.every((event) => event.service === "kimi-code")).toBe(true);
    expect(events.every((event) => event.confidence === "actual")).toBe(true);
    expect(events.every((event) => event.project === "Usage-Monitor")).toBe(true);
    expect(events[0].metadata).toMatchObject({
      harness: "kimi-code",
      usageScope: "turn",
      tokenBreakdownComplete: true,
      "session.id": "session",
      "agent.id": "main",
    });
  });

  it("ignores cumulative session usage, malformed rows, and zero-token turns", () => {
    const text = [
      JSON.stringify(kimiTurn({ usageScope: "session" })),
      "{not json",
      JSON.stringify(kimiTurn({ usage: {} })),
      JSON.stringify({ type: "other", time: 1_779_256_800_302 }),
    ].join("\n");
    expect(parseKimiUsageJsonl(text)).toEqual([]);
  });

  it("keeps known buckets when cache-read usage is absent and marks the split incomplete", () => {
    const row = kimiTurn({
      usage: { inputOther: 10, output: 5, inputCacheCreation: 3 },
    });
    const events = parseKimiUsageJsonl(JSON.stringify(row), { sessionKey: "s" });
    expect(events.map((event) => event.label)).toEqual([
      "token:input",
      "token:output",
      "token:cacheCreation",
    ]);
    expect(events.every((event) => event.metadata.tokenBreakdownComplete === false)).toBe(true);
  });

  it("keeps event ids stable when unrelated lines are inserted before a record", () => {
    const record = JSON.stringify(kimiTurn());
    const before = parseKimiUsageJsonl(record, { sessionKey: "s" });
    const after = parseKimiUsageJsonl(`${JSON.stringify({ type: "other" })}\n${record}`, {
      sessionKey: "s",
    });
    expect(after.map((event) => event.eventId)).toEqual(before.map((event) => event.eventId));
  });

  it("reads the session index without exposing full work directories in events", () => {
    const index = parseKimiSessionIndexJsonl(
      [
        JSON.stringify({ sessionId: "s1", sessionDir: "/opaque/s1", workDir: "/Code/App-One" }),
        "{partial",
        JSON.stringify({ sessionId: "s2", workDir: "/Code/App-Two" }),
      ].join("\n"),
    );
    expect(index).toEqual(new Map([["s1", "/Code/App-One"], ["s2", "/Code/App-Two"]]));
  });

  it("collects nested wire files and tags a known BotFleet workspace", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "kimi-collector-"));
    const home = join(tempRoot, ".kimi-code");
    const wire = join(home, "sessions", "workspace", "session-a", "agents", "main", "wire.jsonl");
    await mkdir(join(wire, ".."), { recursive: true });
    await writeFile(wire, `${JSON.stringify(kimiTurn())}\n`);
    await writeFile(
      join(home, "session_index.jsonl"),
      `${JSON.stringify({ sessionId: "session-a", workDir: "/Users/jay/.botfleet/workspaces/demo" })}\n`,
    );
    const events = await collectKimiEvents({ home, since: new Date(0) });
    expect(events).toHaveLength(4);
    expect(events.every((event) => event.metadata["agent.launcher"] === "botfleet")).toBe(true);
    expect(events.every((event) => event.project === "demo")).toBe(true);
    expect(kimiWireIdentity(join(home, "sessions"), wire)).toMatchObject({
      sessionId: "session-a",
      agentId: "main",
    });
  });
});

describe("ZCode exact usage telemetry", () => {
  it("subtracts both cache components from inclusive input", () => {
    expect(
      zcodeTokenBreakdown({
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 60,
        cache_creation_input_tokens: 10,
      }),
    ).toEqual({
      breakdown: { input: 30, output: 20, cacheRead: 60, cacheCreation: 10 },
      cacheBreakdownValid: true,
    });
  });

  it("retains the provider total when an invalid cache split exceeds input", () => {
    expect(
      zcodeTokenBreakdown({
        input_tokens: 10,
        output_tokens: 2,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 5,
      }),
    ).toEqual({
      breakdown: { input: 10, output: 2, cacheRead: 0, cacheCreation: 0 },
      cacheBreakdownValid: false,
    });
  });

  it("retains cache-only historical rows when the normalized input total is absent", () => {
    expect(
      zcodeTokenBreakdown({
        input_tokens: 0,
        output_tokens: 2,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 5,
      }),
    ).toEqual({
      breakdown: { input: 0, output: 2, cacheRead: 20, cacheCreation: 5 },
      cacheBreakdownValid: true,
    });
  });

  it("normalizes Z.ai-family provider ids without flattening other providers", () => {
    expect(zcodeProviderName("z.ai")).toBe("zcode");
    expect(zcodeProviderName("bigmodel-coding-plan")).toBe("zcode");
    expect(zcodeProviderName("glm-5")).toBe("zcode");
    expect(zcodeProviderName("anthropic")).toBe("anthropic");
    expect(zcodeProviderName("google")).toBe("google-ai");
  });

  it("emits terminal request rows and keeps reasoning inside output", () => {
    const base = {
      id: "request-1",
      session_id: "session-1",
      query_source: "main_turn",
      provider_id: "z.ai",
      model_id: "glm-5",
      status: "completed",
      started_at: 1_779_256_800_000,
      completed_at: 1_779_256_801_000,
      input_tokens: 100,
      output_tokens: 25,
      reasoning_tokens: 7,
      cache_read_input_tokens: 60,
      cache_creation_input_tokens: 10,
      directory: "/Code/Usage-Monitor",
    };
    const events = parseZcodeModelUsageRows([base, { ...base, id: "running", status: "running" }]);
    expect(events.map((event) => [event.label, event.quantity])).toEqual([
      ["token:input", 30],
      ["token:output", 25],
      ["token:cacheRead", 60],
      ["token:cacheCreation", 10],
    ]);
    expect(events.every((event) => event.provider === "zcode")).toBe(true);
    expect(events.every((event) => event.service === "zcode-cli")).toBe(true);
    expect(events.every((event) => event.confidence === "actual")).toBe(true);
    expect(events.find((event) => event.label === "token:output")?.metadata.reasoningTokens).toBe(7);
    expect(events.find((event) => event.label === "token:output")?.quantity).toBe(25);
  });

  it("reads the documented model_usage schema through a read-only join", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "zcode-collector-"));
    const dbPath = join(tempRoot, "db.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(
      "CREATE TABLE session (id text PRIMARY KEY, project_id text, directory text);" +
        "CREATE TABLE model_usage (" +
        "id text PRIMARY KEY, session_id text, query_source text, provider_id text, model_id text, " +
        "agent text, mode text, task_type text, status text, started_at integer, completed_at integer, " +
        "duration_ms integer, time_to_first_token_ms integer, input_tokens integer, output_tokens integer, " +
        "reasoning_tokens integer, cache_creation_input_tokens integer, cache_read_input_tokens integer);",
    );
    db.prepare("INSERT INTO session (id, project_id, directory) VALUES (?, ?, ?)").run(
      "s1",
      "source-project-1",
      "/Code/ZCode-Demo",
    );
    db.prepare(
      "INSERT INTO model_usage VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "r1", "s1", "main_turn", "zai", "glm-5", null, null, "interactive", "completed",
      1_779_256_800_000, 1_779_256_801_000, 1000, 50, 100, 25, 7, 10, 60,
    );
    db.close();
    const rows = await readZcodeModelUsageRows(dbPath, new Date(0));
    expect(rows).toHaveLength(1);
    expect(rows[0].directory).toBe("/Code/ZCode-Demo");
    const events = await collectZcodeEvents({ dbPath, since: new Date(0) });
    expect(events).toHaveLength(4);
    expect(events.every((event) => event.project === "ZCode-Demo")).toBe(true);
    expect(events.every((event) => event.metadata.sourceProjectId === "source-project-1")).toBe(true);
  });
});

describe("telemetry v2 contract", () => {
  it("accepts both collectors' exact token events", () => {
    const kimiEvents = parseKimiUsageJsonl(JSON.stringify(kimiTurn()), {
      sessionKey: "s",
      sessionId: "s",
    });
    const zcodeEvents = parseZcodeModelUsageRows([{
      id: "r",
      session_id: "s",
      provider_id: "zai",
      model_id: "glm-5",
      status: "completed",
      started_at: 1_779_256_800_000,
      input_tokens: 1,
      output_tokens: 1,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    }]);
    expect(
      UsageTelemetryV2BatchSchema.parse({
        schemaVersion: 2,
        producerId: KIMI_PRODUCER_ID,
        producerInstanceId: "test",
        events: kimiEvents,
      }).events,
    ).toHaveLength(4);
    expect(
      UsageTelemetryV2BatchSchema.parse({
        schemaVersion: 2,
        producerId: ZCODE_PRODUCER_ID,
        producerInstanceId: "test",
        events: zcodeEvents,
      }).events,
    ).toHaveLength(2);
  });
});
