import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { NextRequest } from "next/server";
import { setupPrismaSqliteTestDb } from "@/lib/__tests__/setup-test-db";
import { getNamedRateLimiter } from "@/lib/rate-limit";

let dbPath: string;
let POST: typeof import("../traces/route").POST;
let prisma: typeof import("@/lib/prisma").prisma;

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "otlp-traces-test-"));
  dbPath = path.join(dir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.USAGE_INGEST_TOKEN = "test-token-123";
  setupPrismaSqliteTestDb(dbPath);
  ({ POST } = await import("../traces/route"));
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

  it("rejects a payload that is neither resourceSpans nor turns", async () => {
    const res = await POST(
      jsonRequest({ resourceLogs: [] }, { authorization: "Bearer test-token-123" })
    );
    expect(res.status).toBe(400);
  });
});
