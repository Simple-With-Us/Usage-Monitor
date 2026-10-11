import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { NextRequest } from "next/server";
import { setupPrismaSqliteTestDb } from "@/lib/__tests__/setup-test-db";

let dbPath: string;
let GET: typeof import("../route").GET;
let prisma: typeof import("@/lib/prisma").prisma;
let createSessionToken: typeof import("@/lib/auth").createSessionToken;
let SESSION_COOKIE_NAME: typeof import("@/lib/auth").SESSION_COOKIE_NAME;

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-turns-get-"));
  dbPath = path.join(dir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.SESSION_SECRET = "b".repeat(64);
  process.env.USAGE_READ_TOKEN = "read-token-123";
  setupPrismaSqliteTestDb(dbPath);
  ({ GET } = await import("../route"));
  ({ prisma } = await import("@/lib/prisma"));
  ({ createSessionToken, SESSION_COOKIE_NAME } = await import("@/lib/auth"));
}, 60_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (dbPath && fs.existsSync(dbPath)) fs.rmSync(dbPath, { force: true });
});

beforeEach(async () => {
  await prisma.agentTurn.deleteMany();
});

describe("GET /api/agent-turns", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await GET(new NextRequest("https://usage.jays.services/api/agent-turns"));
    expect(res.status).toBe(401);
  });

  it("lists newest-first turns for a session cookie", async () => {
    await prisma.agentTurn.createMany({
      data: [
        {
          platform: "cursor-agent",
          model: "old",
          occurredAt: new Date("2026-10-01T00:00:00.000Z"),
        },
        {
          platform: "cursor-agent",
          model: "new",
          occurredAt: new Date("2026-10-11T00:00:00.000Z"),
        },
        {
          platform: "botfleet",
          model: "other",
          occurredAt: new Date("2026-10-10T00:00:00.000Z"),
        },
      ],
    });
    const token = createSessionToken();
    const res = await GET(
      new NextRequest("https://usage.jays.services/api/agent-turns?platform=cursor-agent&limit=10", {
        headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.turns.map((t: { model: string }) => t.model)).toEqual(["new", "old"]);
  });

  it("accepts USAGE_READ_TOKEN bearer auth", async () => {
    const res = await GET(
      new NextRequest("https://usage.jays.services/api/agent-turns", {
        headers: { authorization: "Bearer read-token-123" },
      })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, turns: [] });
  });
});
