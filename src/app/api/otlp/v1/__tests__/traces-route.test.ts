import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { NextRequest } from "next/server";
import { setupPrismaSqliteTestDb } from "@/lib/__tests__/setup-test-db";
import { getNamedRateLimiter } from "@/lib/rate-limit";

let dbPath: string;
let POST: typeof import("../traces/route").POST;
let USAGE_POST: typeof import("../../../ingest/usage/route").POST;
let METRICS_POST: typeof import("../metrics/route").POST;
let prisma: typeof import("@/lib/prisma").prisma;

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "otlp-traces-test-"));
  dbPath = path.join(dir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.USAGE_INGEST_TOKEN = "test-token-123";
  setupPrismaSqliteTestDb(dbPath);
  ({ POST } = await import("../traces/route"));
  ({ POST: USAGE_POST } = await import("../../../ingest/usage/route"));
  ({ POST: METRICS_POST } = await import("../metrics/route"));
  ({ prisma } = await import("@/lib/prisma"));
}, 60_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (dbPath && fs.existsSync(dbPath)) fs.rmSync(dbPath);
});

beforeEach(async () => {
  getNamedRateLimiter("otlp-traces-identity", 1_000, 10).reset();
  getNamedRateLimiter("otlp-traces-unauthenticated", 1_000, 10).reset();
  await prisma.agentTurn.deleteMany();
});

let ipCounter = 0;
function jsonRequest(body: unknown, headers: Record<string, string> = {}): NextRequest {
  ipCounter += 1;
  return new NextRequest("https://usage.jays.services/api/otlp/v1/traces", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": `10.0.1.${ipCounter}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/otlp/v1/traces", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await POST(jsonRequest({ turns: [] }));
    expect(res.status).toBe(401);
  });

  it("rejects protobuf with 415", async () => {
    const res = await POST(
      new NextRequest("https://usage.jays.services/api/otlp/v1/traces", {
        method: "POST",
        headers: {
          "content-type": "application/x-protobuf",
          authorization: "Bearer test-token-123",
        },
        body: new Uint8Array([1, 2, 3]),
      })
    );
    expect(res.status).toBe(415);
  });

  it("persists a direct turn payload without writing ExternalUsageEvent", async () => {
    const res = await POST(
      jsonRequest(
        {
          turns: [
            {
              platform: "cursor-agent",
              seat: "cloud",
              model: "gpt-5",
              inputTokens: 11,
              outputTokens: 7,
              costUsd: 0.05,
              conversationId: "conv-9",
              promptText: "hello",
              occurredAt: "2026-10-11T12:00:00.000Z",
            },
          ],
        },
        { authorization: "Bearer test-token-123" }
      )
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ ok: true, accepted: 1 });
    const turns = await prisma.agentTurn.findMany();
    expect(turns).toHaveLength(1);
    expect(turns[0].platform).toBe("cursor-agent");
    expect(turns[0].promptText).toBe("hello");
    expect(await prisma.externalUsageEvent.count()).toBe(0);
  });

  it("writes a retried turn once per platform and generation id", async () => {
    const turn = (generationId: string | undefined) => ({
      platform: "cursor-agent",
      model: "gpt-5",
      inputTokens: 11,
      outputTokens: 7,
      conversationId: "conv-retry",
      ...(generationId ? { generationId } : {}),
      occurredAt: "2026-10-11T12:00:00.000Z",
    });
    const body = { turns: [turn("gen-1"), turn("gen-1"), turn("gen-2"), turn(undefined)] };
    const first = await POST(jsonRequest(body, { authorization: "Bearer test-token-123" }));
    expect(await first.json()).toMatchObject({ ok: true, accepted: 3 });
    // The exporter did not see the response and sends the same request again.
    const retry = await POST(jsonRequest(body, { authorization: "Bearer test-token-123" }));
    expect(retry.status).toBe(202);
    // Only the turn with no generation id is indistinguishable from a new one.
    expect(await retry.json()).toMatchObject({ ok: true, accepted: 1 });
    const turns = await prisma.agentTurn.findMany({ orderBy: { generationId: "asc" } });
    expect(turns.map((t) => t.generationId)).toEqual([null, null, "gen-1", "gen-2"]);
  });

  it("rejects a payload that is neither resourceSpans nor turns", async () => {
    const res = await POST(
      jsonRequest({ resourceLogs: [] }, { authorization: "Bearer test-token-123" })
    );
    expect(res.status).toBe(400);
  });

  it("lets a claude-code scoped credential write its own Claude Code trace batch", async () => {
    // Regression (UM-1636): Claude Code's spans carry gen_ai.system =
    // "anthropic", so the turn dimension resolved to the model vendor and a
    // producer-scoped credential ("claude-code") was refused for the whole
    // batch with 403 — the trace feed died while metrics and logs of the
    // same sessions still landed.
    process.env.USAGE_INGEST_PRODUCER_TOKENS = "claude-code:claude-scoped-token";
    try {
      const res = await POST(
        jsonRequest(
          {
            resourceSpans: [
              {
                resource: {
                  attributes: [
                    { key: "service.name", value: { stringValue: "claude-code" } },
                    { key: "seat", value: { stringValue: "CLAUDE" } },
                  ],
                },
                scopeSpans: [
                  {
                    spans: [
                      {
                        name: "claude_code.interaction",
                        startTimeUnixNano: "1751500000000000000",
                        endTimeUnixNano: "1751500002000000000",
                        attributes: [
                          { key: "gen_ai.system", value: { stringValue: "anthropic" } },
                          { key: "session.id", value: { stringValue: "sess-77" } },
                          { key: "model", value: { stringValue: "claude-opus-5-5" } },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
          { authorization: "Bearer claude-scoped-token" }
        )
      );
      expect(res.status).toBe(202);
      const turns = await prisma.agentTurn.findMany();
      expect(turns).toHaveLength(1);
      expect(turns[0].platform).toBe("claude-code");
      expect(turns[0].seat).toBe("CLAUDE");
    } finally {
      delete process.env.USAGE_INGEST_PRODUCER_TOKENS;
    }
  });

  it("lets an openrouter scoped credential write OpenRouter Broadcast traces", async () => {
    process.env.OTLP_TRACES_PRODUCER_TOKENS = "openrouter:openrouter-trace-token";
    try {
      const res = await POST(
        jsonRequest(
          {
            resourceSpans: [
              {
                scopeSpans: [
                  {
                    spans: [
                      {
                        name: "chat openai/gpt-5",
                        attributes: [
                          { key: "openrouter.trace.id", value: { stringValue: "or-trace-1" } },
                          { key: "gen_ai.system", value: { stringValue: "openai" } },
                          { key: "gen_ai.request.model", value: { stringValue: "openai/gpt-5" } },
                          { key: "gen_ai.usage.input_tokens", value: { intValue: "10" } },
                          { key: "gen_ai.usage.output_tokens", value: { intValue: "4" } },
                        ],
                      },
                      {
                        name: "chat anthropic/claude-sonnet",
                        attributes: [
                          { key: "gen_ai.system", value: { stringValue: "anthropic" } },
                          {
                            key: "gen_ai.request.model",
                            value: { stringValue: "anthropic/claude-sonnet" },
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
          { authorization: "Bearer openrouter-trace-token" }
        )
      );

      expect(res.status).toBe(202);
      const turns = await prisma.agentTurn.findMany();
      expect(turns).toHaveLength(2);
      expect(turns[0]).toMatchObject({
        platform: "openrouter",
        model: "openai/gpt-5",
        inputTokens: 10,
        outputTokens: 4,
      });
      expect(await prisma.externalUsageEvent.count()).toBe(0);

      const authHeaders = {
        "content-type": "application/json",
        authorization: "Bearer openrouter-trace-token",
      };
      const usageResponse = await USAGE_POST(
        new NextRequest("https://usage.jays.services/api/ingest/usage", {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({ events: [] }),
        })
      );
      const metricsResponse = await METRICS_POST(
        new NextRequest("https://usage.jays.services/api/otlp/v1/metrics", {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({ resourceMetrics: [] }),
        })
      );
      expect(usageResponse.status).toBe(401);
      expect(metricsResponse.status).toBe(401);
    } finally {
      delete process.env.OTLP_TRACES_PRODUCER_TOKENS;
    }
  });

  it("still refuses a scoped credential for a turn dimension it does not own", async () => {
    process.env.USAGE_INGEST_PRODUCER_TOKENS = "codex:codex-scoped-token";
    try {
      const res = await POST(
        jsonRequest(
          {
            resourceSpans: [
              {
                resource: {
                  attributes: [{ key: "agent.platform", value: { stringValue: "cursor-agent" } }],
                },
                scopeSpans: [
                  {
                    spans: [
                      {
                        name: "chat",
                        startTimeUnixNano: "1751500000000000000",
                        endTimeUnixNano: "1751500001000000000",
                        attributes: [
                          { key: "session.id", value: { stringValue: "sess-78" } },
                          { key: "model", value: { stringValue: "gpt-5" } },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
          { authorization: "Bearer codex-scoped-token" }
        )
      );
      expect(res.status).toBe(403);
      expect(await prisma.agentTurn.count()).toBe(0);
    } finally {
      delete process.env.USAGE_INGEST_PRODUCER_TOKENS;
    }
  });
});
