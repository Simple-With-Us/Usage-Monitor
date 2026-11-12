import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  findFirst: vi.fn(),
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  deleteMany: vi.fn(),
  tombstoneFindUnique: vi.fn(),
  tombstoneUpsert: vi.fn(),
  auditCreate: vi.fn(),
  bustBudgetStatusCache: vi.fn(),
}));

vi.mock("@/lib/prisma", () => {
  const db = {
    externalUsageEvent: {
      findMany: mocks.findMany,
      findFirst: mocks.findFirst,
      findUnique: mocks.findUnique,
      create: mocks.create,
      update: mocks.update,
      deleteMany: mocks.deleteMany,
    },
    externalUsageEventTombstone: {
      findUnique: mocks.tombstoneFindUnique,
      upsert: mocks.tombstoneUpsert,
    },
    ownerExpenseAudit: {
      create: mocks.auditCreate,
    },
    // reserveExternalUsageWriter(tx) runs this on the transaction client.
    $executeRaw: vi.fn(async () => 0),
  };
  return {
    prisma: {
      ...db,
      $transaction: async (fn: (tx: typeof db) => unknown) => fn(db),
    },
  };
});

vi.mock("@/lib/budget-status", () => ({
  bustBudgetStatusCache: mocks.bustBudgetStatusCache,
}));

let GET: typeof import("../route").GET;
let POST: typeof import("../route").POST;
let DELETE: typeof import("../route").DELETE;
let PATCH: typeof import("../route").PATCH;
let createSessionToken: typeof import("@/lib/auth").createSessionToken;

const READ_TOKEN = "r".repeat(64);

beforeAll(async () => {
  process.env.SESSION_SECRET = "s".repeat(64);
  ({ GET, POST, DELETE, PATCH } = await import("../route"));
  ({ createSessionToken } = await import("@/lib/auth"));
});

beforeEach(() => {
  delete process.env.USAGE_READ_TOKEN;
  delete process.env.USAGE_INGEST_TOKEN;
  delete process.env.USAGE_READ_TOKEN_ALLOW_INGEST_FALLBACK;
  delete process.env.OWNER_EXPENSE_TOKEN;
  mocks.findMany.mockReset();
  mocks.findMany.mockResolvedValue([]);
  mocks.findFirst.mockReset();
  mocks.findFirst.mockResolvedValue(null);
  mocks.findUnique.mockReset();
  mocks.findUnique.mockResolvedValue(null);
  mocks.update.mockReset();
  mocks.update.mockResolvedValue({});
  mocks.deleteMany.mockReset();
  mocks.deleteMany.mockResolvedValue({ count: 0 });
  mocks.tombstoneFindUnique.mockReset();
  mocks.tombstoneFindUnique.mockResolvedValue(null);
  mocks.tombstoneUpsert.mockReset();
  mocks.tombstoneUpsert.mockResolvedValue({});
  mocks.auditCreate.mockReset();
  mocks.auditCreate.mockResolvedValue({});
  mocks.bustBudgetStatusCache.mockReset();
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

  const fullRow = (idempotencyKey: string) => ({
    idempotencyKey,
    provider: "Anthropic",
    service: "usage",
    label: "API usage",
    costUsd: 12.5,
    confidence: "actual",
    occurredAt: new Date("2026-09-30T12:00:00.000Z"),
    metadata: { ownerRecorded: true, kind: "usage" },
  });

  it("deletes scoped to owner-recorded expenses and reports notFound", async () => {
    mocks.findMany.mockResolvedValue([fullRow(KEY_A)]);
    mocks.deleteMany.mockResolvedValue({ count: 1 });
    const response = await DELETE(deleteRequest([KEY_A, KEY_B]));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      requested: 2,
      deleted: 1,
      tombstoned: 1,
      notFound: [KEY_B],
    });
    expect(mocks.deleteMany).toHaveBeenCalledTimes(1);
    const where = mocks.deleteMany.mock.calls[0][0].where;
    expect(where.sourceApp).toBe("owner-recorded-expense");
    // Only rows that actually exist are deleted (and tombstoned).
    expect(where.idempotencyKey).toEqual({ in: [KEY_A] });
    expect(mocks.bustBudgetStatusCache).toHaveBeenCalledTimes(1);
  });

  it("tombstones and audits every deleted row (UM-1659)", async () => {
    mocks.findMany.mockResolvedValue([fullRow(KEY_A)]);
    mocks.deleteMany.mockResolvedValue({ count: 1 });
    const response = await DELETE(deleteRequest([KEY_A]));
    expect(response.status).toBe(200);
    expect(mocks.tombstoneUpsert).toHaveBeenCalledTimes(1);
    expect(mocks.tombstoneUpsert.mock.calls[0][0].where).toEqual({
      idempotencyKey: KEY_A,
    });
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
    const audit = mocks.auditCreate.mock.calls[0][0].data;
    expect(audit.action).toBe("delete");
    expect(audit.idempotencyKey).toBe(KEY_A);
    expect(audit.before).toMatchObject({ vendor: "Anthropic", amountUsd: 12.5 });
  });

  it("does not bust the budget cache when nothing was deleted", async () => {
    mocks.findMany.mockResolvedValue([]);
    const response = await DELETE(deleteRequest([KEY_A]));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      requested: 1,
      deleted: 0,
      tombstoned: 0,
      notFound: [KEY_A],
    });
    // No rows found: no delete, no tombstone, no audit, no cache bust.
    expect(mocks.deleteMany).not.toHaveBeenCalled();
    expect(mocks.tombstoneUpsert).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
    expect(mocks.bustBudgetStatusCache).not.toHaveBeenCalled();
  });

  it("dedupes repeated keys", async () => {
    mocks.findMany.mockResolvedValue([fullRow(KEY_A)]);
    mocks.deleteMany.mockResolvedValue({ count: 1 });
    const response = await DELETE(deleteRequest([KEY_A, KEY_A]));
    const body = await response.json();
    expect(body.requested).toBe(1);
  });
});

describe("PATCH /api/owner-expenses", () => {
  // The row's key must be the key the recorder derived from its values, as
  // in production — rekey detection compares against exactly that.
  let KEY_A: string;
  let postedRow: Record<string, unknown>;

  beforeAll(async () => {
    const { parseOwnerExpenseInput, ownerExpenseIdempotencyKey } =
      await import("@/lib/owner-expense");
    const input = parseOwnerExpenseInput({
      provider: "Anthropic",
      amountUsd: 12.5,
      occurredAt: "2026-09-30T12:00:00.000Z",
      kind: "usage",
      label: "API usage",
      notes: "Category: Tech",
    });
    KEY_A = ownerExpenseIdempotencyKey(input);
    postedRow = {
      idempotencyKey: KEY_A,
      provider: "Anthropic",
      service: "usage",
      label: "API usage",
      costUsd: 12.5,
      confidence: "actual",
      occurredAt: new Date("2026-09-30T12:00:00.000Z"),
      metadata: { ownerRecorded: true, kind: "usage", notes: "Category: Tech" },
    };
  });

  function patchRequest(
    body: unknown,
    headers: Record<string, string> = {}
  ): NextRequest {
    const token = createSessionToken();
    return new NextRequest("https://usage.jays.services/api/owner-expenses", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        cookie: `dashboard_session=${token}`,
        ...headers,
      },
      body: JSON.stringify(body),
    });
  }

  it("401s without a session cookie", async () => {
    const request = new NextRequest(
      "https://usage.jays.services/api/owner-expenses",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idempotencyKey: KEY_A, amountUsd: 42 }),
      }
    );
    const response = await PATCH(request);
    expect(response.status).toBe(401);
    expect(mocks.findFirst).not.toHaveBeenCalled();
  });

  it("403s a cross-site cookie request (CSRF guard)", async () => {
    const response = await PATCH(
      patchRequest(
        { idempotencyKey: KEY_A, amountUsd: 42 },
        { "sec-fetch-site": "cross-site" }
      )
    );
    expect(response.status).toBe(403);
    expect(mocks.findFirst).not.toHaveBeenCalled();
  });

  it("400s on a malformed idempotency key", async () => {
    const response = await PATCH(
      patchRequest({ idempotencyKey: "not-a-key", amountUsd: 42 })
    );
    expect(response.status).toBe(400);
    expect(mocks.findFirst).not.toHaveBeenCalled();
  });

  it("400s when a non-clearable field is null", async () => {
    const response = await PATCH(
      patchRequest({ idempotencyKey: KEY_A, provider: null })
    );
    expect(response.status).toBe(400);
    expect(mocks.findFirst).not.toHaveBeenCalled();
  });

  it("404s when the expense does not exist", async () => {
    mocks.findFirst.mockResolvedValue(null);
    const response = await PATCH(
      patchRequest({ idempotencyKey: KEY_A, amountUsd: 42 })
    );
    expect(response.status).toBe(404);
  });

  it("edits a field and rekeys when a key field changes", async () => {
    mocks.findFirst.mockResolvedValue(postedRow);
    const response = await PATCH(
      patchRequest({ idempotencyKey: KEY_A, amountUsd: 42 })
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.rekeyed).toBe(true);
    expect(body.expense.amountUsd).toBe(42);
    expect(body.expense.idempotencyKey).not.toBe(KEY_A);
    // Old key tombstoned so the pre-edit receipt cannot resurrect it.
    expect(mocks.tombstoneUpsert).toHaveBeenCalledTimes(1);
    expect(mocks.tombstoneUpsert.mock.calls[0][0].where).toEqual({
      idempotencyKey: KEY_A,
    });
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
    expect(mocks.auditCreate.mock.calls[0][0].data.action).toBe("edit");
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });

  it("edits notes without rekeying", async () => {
    mocks.findFirst.mockResolvedValue(postedRow);
    const response = await PATCH(
      patchRequest({
        idempotencyKey: KEY_A,
        notes: "Category: Tech. Paid by Cash App card.",
      })
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.rekeyed).toBe(false);
    expect(body.expense.idempotencyKey).toBe(KEY_A);
    expect(body.expense.notes).toContain("Cash App card");
    expect(mocks.tombstoneUpsert).not.toHaveBeenCalled();
  });
});
