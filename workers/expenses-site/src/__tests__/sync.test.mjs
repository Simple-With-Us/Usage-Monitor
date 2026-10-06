import { describe, expect, it, vi } from "vitest";
import { buildUpsertStatements, mapUpstreamExpense, syncExpenses } from "../sync.mjs";

function fakeDb() {
  return {
    prepare: vi.fn((sql) => ({
      sql,
      bind: vi.fn((...args) => ({ sql, args, run: async () => ({}) })),
    })),
    batch: vi.fn(async (stmts) => stmts),
  };
}

const upstream = {
  idempotencyKey: "owner-recorded-expense:v1:abc",
  vendor: "Anthropic",
  amountUsd: 213.2,
  occurredAt: "2026-09-30T12:00:00.000Z",
  kind: "usage",
  label: "API usage",
  notes: "receipt",
  confidence: "actual",
  calendarSort: undefined,
};

describe("mapUpstreamExpense", () => {
  it("maps fields and derives the category", () => {
    expect(mapUpstreamExpense(upstream)).toMatchObject({
      idempotency_key: "owner-recorded-expense:v1:abc",
      vendor: "Anthropic",
      amount_usd: 213.2,
      occurred_at: "2026-09-30T12:00:00.000Z",
      kind: "usage",
      label: "API usage",
      category: "tech-ai",
    });
  });

  it("defaults kind and confidence", () => {
    const row = mapUpstreamExpense({ ...upstream, kind: undefined, confidence: undefined });
    expect(row.kind).toBe("one_time");
    expect(row.confidence).toBe("actual");
  });
});

describe("buildUpsertStatements", () => {
  it("upserts on the idempotency key", () => {
    const db = fakeDb();
    const stmts = buildUpsertStatements(db, [mapUpstreamExpense(upstream)], "2026-10-05T00:00:00Z");
    expect(stmts).toHaveLength(1);
    expect(stmts[0].sql).toContain("ON CONFLICT(idempotency_key) DO UPDATE");
    expect(stmts[0].args[0]).toBe("owner-recorded-expense:v1:abc");
  });
});

describe("syncExpenses", () => {
  it("pages the upstream ledger and batches into D1", async () => {
    const db = fakeDb();
    const page1 = {
      expenses: [upstream],
      hasMore: true,
      nextCursor: "cursor-1",
    };
    const page2 = { expenses: [], hasMore: false, nextCursor: null };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => page1 })
      .mockResolvedValueOnce({ ok: true, json: async () => page2 });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const result = await syncExpenses({
        UPSTREAM_URL: "https://usage.jays.services",
        USAGE_READ_TOKEN: "t".repeat(64),
        EXPENSES_DB: db,
      });
      expect(result.upserted).toBe(1);
      expect(result.pages).toBe(2);
      expect(db.batch).toHaveBeenCalledTimes(1);
      // Second page requested with the cursor.
      expect(String(fetchMock.mock.calls[1][0])).toContain("cursor=cursor-1");
      // Bearer <redacted> sent upstream.
      expect(fetchMock.mock.calls[0][1].headers.authorization).toBe(
        "Bearer " + "t".repeat(64)
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("throws when the upstream read fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 401 })
    );
    try {
      await expect(
        syncExpenses({
          UPSTREAM_URL: "https://usage.jays.services",
          USAGE_READ_TOKEN: "x",
          EXPENSES_DB: fakeDb(),
        })
      ).rejects.toThrow("upstream 401");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refuses to run without configuration", async () => {
    await expect(syncExpenses({ EXPENSES_DB: fakeDb() })).rejects.toThrow(
      "must be configured"
    );
  });
});
