import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  create: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    externalUsageEvent: {
      findMany: mocks.findMany,
      create: mocks.create,
    },
  },
}));

let GET: typeof import("../route").GET;
let POST: typeof import("../route").POST;

const READ_TOKEN = "r".repeat(64);

beforeAll(async () => {
  process.env.SESSION_SECRET = "s".repeat(64);
  ({ GET, POST } = await import("../route"));
});

beforeEach(() => {
  delete process.env.USAGE_READ_TOKEN;
  delete process.env.USAGE_INGEST_TOKEN;
  delete process.env.USAGE_READ_TOKEN_ALLOW_INGEST_FALLBACK;
  delete process.env.OWNER_EXPENSE_TOKEN;
  mocks.findMany.mockReset();
  mocks.findMany.mockResolvedValue([]);
});

function getRequest(
  query = "",
  headers: Record<string, string> = {}
): NextRequest {
  return new NextRequest(
    `https://usage.jays.services/api/owner-expenses${query}`,
    { method: "GET", headers }
  );
}

function authedGet(query = ""): NextRequest {
  process.env.USAGE_READ_TOKEN = READ_TOKEN;
  return getRequest(query, { authorization: `Bearer ${READ_TOKEN}` });
}

const sampleRow = {
  idempotencyKey: "owner-recorded-expense:v1:abc123",
  provider: "Anthropic",
  service: "usage",
  label: "API usage",
  costUsd: 213.2,
  confidence: "actual",
  occurredAt: new Date("2026-09-30T12:00:00.000Z"),
  metadata: { ownerRecorded: true, kind: "usage", notes: "receipt" },
};

describe("GET /api/owner-expenses", () => {
  it("401s with no session and no read token", async () => {
    const response = await GET(getRequest());
    expect(response.status).toBe(401);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("401s with a wrong bearer token", async () => {
    process.env.USAGE_READ_TOKEN = READ_TOKEN;
    const response = await GET(
      getRequest("", { authorization: "Bearer wrong" })
    );
    expect(response.status).toBe(401);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("returns mapped expenses for the read token", async () => {
    mocks.findMany.mockResolvedValue([sampleRow]);
    const response = await GET(authedGet());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.hasMore).toBe(false);
    expect(body.nextCursor).toBeNull();
    expect(body.expenses).toHaveLength(1);
    expect(body.expenses[0]).toMatchObject({
      idempotencyKey: "owner-recorded-expense:v1:abc123",
      vendor: "Anthropic",
      amountUsd: 213.2,
      occurredAt: "2026-09-30T12:00:00.000Z",
      kind: "usage",
      label: "API usage",
      notes: "receipt",
      confidence: "actual",
    });
  });

  it("paginates with nextCursor when the page is full", async () => {
    const rows = [sampleRow, { ...sampleRow, idempotencyKey: "k2" }];
    mocks.findMany.mockResolvedValue(rows);
    const response = await GET(authedGet("?limit=1"));
    const body = await response.json();
    expect(body.hasMore).toBe(true);
    expect(body.nextCursor).toBe("owner-recorded-expense:v1:abc123");
    expect(body.expenses).toHaveLength(1);
  });

  it("400s on an invalid from date", async () => {
    const response = await GET(authedGet("?from=not-a-date"));
    expect(response.status).toBe(400);
  });

  it("scopes the query to owner-recorded expenses", async () => {
    await GET(authedGet("?from=2026-05-01&to=2026-10-05"));
    expect(mocks.findMany).toHaveBeenCalledTimes(1);
    const where = mocks.findMany.mock.calls[0][0].where;
    expect(where.sourceApp).toBe("owner-recorded-expense");
    expect(where.occurredAt.gte).toEqual(new Date("2026-05-01"));
    expect(where.occurredAt.lte).toEqual(new Date("2026-10-05T23:59:59.999Z"));
  });

  it("400s on an invalid to date", async () => {
    const response = await GET(authedGet("?to=not-a-date"));
    expect(response.status).toBe(400);
  });

  it("POST still 401s without a session or owner token (production-shaped)", async () => {
    const originalVitest = process.env.VITEST;
    const originalSessionSecret = process.env.SESSION_SECRET;
    process.env.VITEST = "false";
    process.env.SESSION_SECRET = "s".repeat(64);
    try {
      const request = new NextRequest(
        "https://usage.jays.services/api/owner-expenses",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            provider: "Anthropic",
            amountUsd: 10,
            occurredAt: "2026-10-05T00:00:00.000Z",
            kind: "usage",
            label: "x",
          }),
        }
      );
      const response = await POST(request);
      expect(response.status).toBe(401);
    } finally {
      if (originalVitest == null) delete process.env.VITEST;
      else process.env.VITEST = originalVitest;
      if (originalSessionSecret == null) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = originalSessionSecret;
    }
  });
});
