import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  create: vi.fn(),
  deleteMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    externalUsageEvent: {
      findMany: mocks.findMany,
      create: mocks.create,
      deleteMany: mocks.deleteMany,
    },
  },
}));

let GET: typeof import("../route").GET;
let POST: typeof import("../route").POST;
let DELETE: typeof import("../route").DELETE;
let createSessionToken: typeof import("@/lib/auth").createSessionToken;

const READ_TOKEN = "r".repeat(64);

beforeAll(async () => {
  process.env.SESSION_SECRET = "s".repeat(64);
  ({ GET, POST, DELETE } = await import("../route"));
  ({ createSessionToken } = await import("@/lib/auth"));
});

beforeEach(() => {
  delete process.env.USAGE_READ_TOKEN;
  delete process.env.USAGE_INGEST_TOKEN;
  delete process.env.USAGE_READ_TOKEN_ALLOW_INGEST_FALLBACK;
  delete process.env.OWNER_EXPENSE_TOKEN;
  mocks.findMany.mockReset();
  mocks.findMany.mockResolvedValue([]);
  mocks.deleteMany.mockReset();
  mocks.deleteMany.mockResolvedValue({ count: 0 });
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

describe("DELETE /api/owner-expenses", () => {
  const KEY_A = `owner-recorded-expense:v1:${"a".repeat(64)}`;
  const KEY_B = `owner-recorded-expense:v1:${"b".repeat(64)}`;

  function deleteRequest(
    keys: unknown,
    headers: Record<string, string> = {}
  ): NextRequest {
    const token = createSessionToken();
    return new NextRequest("https://usage.jays.services/api/owner-expenses", {
      method: "DELETE",
      headers: {
        "content-type": "application/json",
        cookie: `dashboard_session=${token}`,
        ...headers,
      },
      body: JSON.stringify({ idempotencyKeys: keys }),
    });
  }

  it("401s without a session cookie", async () => {
    const request = new NextRequest(
      "https://usage.jays.services/api/owner-expenses",
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idempotencyKeys: [KEY_A] }),
      }
    );
    const response = await DELETE(request);
    expect(response.status).toBe(401);
    expect(mocks.deleteMany).not.toHaveBeenCalled();
  });

  it("401s with an owner expense token but no session (no token fallback)", async () => {
    process.env.OWNER_EXPENSE_TOKEN = "t".repeat(64);
    const request = new NextRequest(
      "https://usage.jays.services/api/owner-expenses",
      {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
          "x-owner-expense-token": "t".repeat(64),
        },
        body: JSON.stringify({ idempotencyKeys: [KEY_A] }),
      }
    );
    const response = await DELETE(request);
    expect(response.status).toBe(401);
    expect(mocks.deleteMany).not.toHaveBeenCalled();
  });

  it("403s a cross-site cookie request (CSRF guard)", async () => {
    const response = await DELETE(
      deleteRequest([KEY_A], { "sec-fetch-site": "cross-site" })
    );
    expect(response.status).toBe(403);
    expect(mocks.deleteMany).not.toHaveBeenCalled();
  });

  it("400s on a malformed idempotency key", async () => {
    const response = await DELETE(deleteRequest(["not-a-key"]));
    expect(response.status).toBe(400);
    expect(mocks.deleteMany).not.toHaveBeenCalled();
  });

  it("400s on an empty key list", async () => {
    const response = await DELETE(deleteRequest([]));
    expect(response.status).toBe(400);
    expect(mocks.deleteMany).not.toHaveBeenCalled();
  });

  it("400s on a non-expense key shape", async () => {
    const response = await DELETE(deleteRequest(["usage-telemetry:v1:abc"]));
    expect(response.status).toBe(400);
    expect(mocks.deleteMany).not.toHaveBeenCalled();
  });

  it("deletes scoped to owner-recorded expenses and reports notFound", async () => {
    mocks.findMany.mockResolvedValue([{ idempotencyKey: KEY_A }]);
    mocks.deleteMany.mockResolvedValue({ count: 1 });
    const response = await DELETE(deleteRequest([KEY_A, KEY_B]));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      requested: 2,
      deleted: 1,
      notFound: [KEY_B],
    });
    expect(mocks.deleteMany).toHaveBeenCalledTimes(1);
    const where = mocks.deleteMany.mock.calls[0][0].where;
    expect(where.sourceApp).toBe("owner-recorded-expense");
    expect(where.idempotencyKey).toEqual({ in: [KEY_A, KEY_B] });
  });

  it("dedupes repeated keys", async () => {
    mocks.findMany.mockResolvedValue([{ idempotencyKey: KEY_A }]);
    mocks.deleteMany.mockResolvedValue({ count: 1 });
    const response = await DELETE(deleteRequest([KEY_A, KEY_A]));
    const body = await response.json();
    expect(body.requested).toBe(1);
  });
});
