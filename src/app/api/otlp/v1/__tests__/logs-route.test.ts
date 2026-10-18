import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { NextRequest } from "next/server";
import { setupPrismaSqliteTestDb } from "@/lib/__tests__/setup-test-db";
import {
  CLAUDE_REQUEST_ID,
  claudeLlmRequestSpanPayload,
  claudeLogsPayload,
  codexApiRequestPayload,
  codexCompletionPayload,
} from "@/lib/otlp/__tests__/ai-request-fixtures";

// Logs route: per-request events (claude_code.api_request, codex.api_request
// + codex.sse_event response.completed) persist to AiRequest (UM-1590);
// every other log record stays accept-and-drop.

let dbPath: string;
let POST: typeof import("../logs/route").POST;
let TRACES_POST: typeof import("../traces/route").POST;
let prisma: typeof import("@/lib/prisma").prisma;

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "otlp-logs-test-"));
  dbPath = path.join(dir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.USAGE_INGEST_TOKEN = "test-token-123";
  setupPrismaSqliteTestDb(dbPath);
  ({ POST } = await import("../logs/route"));
  ({ POST: TRACES_POST } = await import("../traces/route"));
  ({ prisma } = await import("@/lib/prisma"));
}, 60_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (dbPath && fs.existsSync(dbPath)) fs.rmSync(dbPath);
});

beforeEach(async () => {
  await prisma.aiRequest.deleteMany();
  await prisma.agentTurn.deleteMany();
});

let ipCounter = 0;
function jsonRequest(body: unknown, headers: Record<string, string> = {}, route = "logs"): NextRequest {
  ipCounter += 1;
  return new NextRequest(`https://usage.jays.services/api/otlp/v1/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `10.0.2.${ipCounter}`, ...headers },
    body: JSON.stringify(body),
  });
}

const AUTH = { authorization: "Bearer test-token-123" };

const samplePayload = {
  resourceLogs: [
    {
      resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] },
      scopeLogs: [
        {
          scope: { name: "com.anthropic.claude_code" },
          logRecords: [
            { timeUnixNano: "1751500060000000000", severityText: "INFO", body: { stringValue: "hi" } },
            { timeUnixNano: "1751500060000000001", severityText: "INFO", body: { stringValue: "bye" } },
          ],
        },
      ],
    },
  ],
};

describe("POST /api/otlp/v1/logs", () => {
  it("rejects requests with no auth header", async () => {
    const res = await POST(jsonRequest(samplePayload));
    expect(res.status).toBe(401);
  });

  it("accepts and drops log records that are not per-request events", async () => {
    const res = await POST(jsonRequest(samplePayload, AUTH));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.stored).toBe(false);
    expect(body.accepted).toBe(0);
    expect(body.received).toBe(2);
    expect(await prisma.aiRequest.count()).toBe(0);
  });

  it("never 500s on a well-formed but empty payload", async () => {
    const res = await POST(jsonRequest({}, AUTH));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.received).toBe(0);
  });

  it("rejects malformed JSON shape with 400, not 500", async () => {
    const res = await POST(jsonRequest({ resourceLogs: "not-an-array" }, AUTH));
    expect(res.status).toBe(400);
  });

  it("rejects oversized log payloads before decoding them", async () => {
    const res = await POST(jsonRequest({ padding: "x".repeat(1_048_576) }, AUTH));
    expect(res.status).toBe(413);
  });

  it("stores claude_code.api_request as one AiRequest row without prompt or email", async () => {
    const res = await POST(jsonRequest(claudeLogsPayload(), AUTH));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, received: 2, accepted: 1, inserted: 1, stored: true });

    const rows = await prisma.aiRequest.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      dedupeKey: `claude-code|req|${CLAUDE_REQUEST_ID}`,
      harness: "claude-code",
      seat: "CLAUDE",
      project: "Usage-Monitor",
      billingMode: "subscription",
      sessionId: "sess-1590",
      requestedModel: "claude-opus-5-5",
      durationMs: 8123,
      inputTokens: 12,
      outputTokens: 640,
      cacheReadTokens: 88000,
      cacheWriteTokens: 1500,
      costUsd: 0.0421,
      costSource: "estimated",
      speed: "normal",
      effort: "high",
      querySource: "repl_main_thread",
      sources: "logs",
      error: null,
      ttftMs: null,
    });
    expect(rows[0].occurredAt.toISOString()).toBe("2026-10-17T15:04:05.123Z");
    expect(JSON.stringify(rows[0])).not.toContain("secret prompt");
    expect(JSON.stringify(rows[0])).not.toContain("example.com");
  });

  it("is idempotent on replay", async () => {
    await POST(jsonRequest(claudeLogsPayload(), AUTH));
    const res = await POST(jsonRequest(claudeLogsPayload(), AUTH));
    const body = await res.json();
    expect(body).toMatchObject({ accepted: 0, duplicates: 1, stored: false });
    expect(await prisma.aiRequest.count()).toBe(1);
  });

  it("merges the llm_request trace span into the same row and adds TTFT", async () => {
    await POST(jsonRequest(claudeLogsPayload(), AUTH));
    const res = await TRACES_POST(jsonRequest(claudeLlmRequestSpanPayload(), AUTH, "traces"));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.aiRequests).toBe(1);

    const rows = await prisma.aiRequest.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ttftMs: 1350, durationMs: 8123, sources: "logs+traces", costUsd: 0.0421 });
    // llm_request and tool spans are model calls / tool runs, not turns.
    expect(await prisma.agentTurn.count()).toBe(0);
  });

  it("merges the other way round too (trace first, log second)", async () => {
    await TRACES_POST(jsonRequest(claudeLlmRequestSpanPayload(), AUTH, "traces"));
    await POST(jsonRequest(claudeLogsPayload(), AUTH));
    const rows = await prisma.aiRequest.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ttftMs: 1350,
      costUsd: 0.0421,
      project: "Usage-Monitor",
      sources: "logs+traces",
    });
  });

  it("stitches codex.api_request and its response.completed into one row", async () => {
    const first = await POST(jsonRequest(codexApiRequestPayload(), AUTH));
    expect(first.status).toBe(202);
    expect((await first.json()).inserted).toBe(1);

    const second = await POST(jsonRequest(codexCompletionPayload(), AUTH));
    expect((await second.json()).merged).toBe(1);

    const rows = await prisma.aiRequest.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      harness: "codex",
      billingMode: "subscription",
      sessionId: "conv-codex-1590",
      requestedModel: "gpt-6.1-sol",
      statusCode: 200,
      // 15:10:00.000 start (headers at .900 after 900 ms) to completion at 15:10:06.000
      durationMs: 6000,
      ttftMs: 1400,
      inputTokens: 5000,
      cacheReadTokens: 45000,
      outputTokens: 1200,
      reasoningTokens: 300,
      effort: "high",
      error: null,
    });
    expect(rows[0].occurredAt.toISOString()).toBe("2026-10-17T15:10:06.000Z");

    // A replayed completion does not create a second row.
    const replay = await POST(jsonRequest(codexCompletionPayload(), AUTH));
    expect((await replay.json()).duplicates).toBe(1);
    expect(await prisma.aiRequest.count()).toBe(1);
  });

  it("stores a codex completion with no preceding api_request on its own", async () => {
    await POST(jsonRequest(codexCompletionPayload(), AUTH));
    const rows = await prisma.aiRequest.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ harness: "codex", outputTokens: 1200, durationMs: null, ttftMs: 1400 });
  });

  it("rejects a scoped credential for another harness", async () => {
    process.env.USAGE_INGEST_PRODUCER_TOKENS = "codex:codex-only-token";
    try {
      const res = await POST(
        jsonRequest(claudeLogsPayload(), { authorization: "Bearer codex-only-token" })
      );
      expect(res.status).toBe(403);
      expect(await prisma.aiRequest.count()).toBe(0);
    } finally {
      delete process.env.USAGE_INGEST_PRODUCER_TOKENS;
    }
  });
  it("accepts the scoped openai-codex token for Codex rows but not for Claude rows (UM-1599)", async () => {
    process.env.USAGE_INGEST_PRODUCER_TOKENS = "openai-codex:codex-scoped-token";
    process.env.USAGE_INGEST_REQUIRE_SCOPED_TOKENS = "true";
    try {
      const headers = { authorization: "Bearer codex-scoped-token" };
      const ok = await POST(jsonRequest(codexCompletionPayload(), headers));
      expect(ok.status).toBe(202);
      const rows = await prisma.aiRequest.findMany();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ harness: "codex", seat: "CODEX", servedModel: "gpt-6.1-sol" });

      const denied = await POST(jsonRequest(claudeLogsPayload(), headers));
      expect(denied.status).toBe(403);
      // The unscoped token is refused once scoped tokens are required.
      const unscoped = await POST(jsonRequest(codexCompletionPayload(), AUTH));
      expect(unscoped.status).toBe(401);
    } finally {
      delete process.env.USAGE_INGEST_PRODUCER_TOKENS;
      delete process.env.USAGE_INGEST_REQUIRE_SCOPED_TOKENS;
    }
  });
});
