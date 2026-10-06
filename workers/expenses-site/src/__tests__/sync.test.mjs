import { describe, expect, it, vi } from "vitest";
import {
  buildUpsertStatements,
  dedupeUpstreamRows,
  expenseFingerprint,
  loadSuppressedKeys,
  mapUpstreamExpense,
  syncExpenses,
} from "../sync.mjs";

function fakeDb(suppressed = []) {
  return {
    prepare: vi.fn((sql) => ({
      sql,
      bind: vi.fn((...args) => ({ sql, args, run: async () => ({}) })),
      all: async () => ({
        results: sql.includes("suppressed_expenses")
          ? suppressed.map((idempotency_key) => ({ idempotency_key }))
          : [],
      }),
      run: async () => ({}),
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

describe("dedupeUpstreamRows", () => {
  const oneTime = { ...upstream, idempotencyKey: "k-one", kind: "one_time" };
  const usageDup = { ...upstream, idempotencyKey: "k-use", kind: "usage" };

  it("collapses same-receipt double-posts to one row", () => {
    const rows = dedupeUpstreamRows([oneTime, usageDup]);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("one_time");
  });

  it("keeps genuinely different charges apart", () => {
    const other = { ...upstream, idempotencyKey: "k-other", label: "Other invoice" };
    expect(dedupeUpstreamRows([oneTime, other])).toHaveLength(2);
    const otherAmount = { ...upstream, idempotencyKey: "k-amt", amountUsd: 99.99 };
    expect(dedupeUpstreamRows([oneTime, otherAmount])).toHaveLength(2);
  });

  it("builds a vendor/amount/day/label fingerprint", () => {
    expect(expenseFingerprint(oneTime)).toBe(expenseFingerprint(usageDup));
  });
});

describe("loadSuppressedKeys", () => {
  it("reads the suppression table", async () => {
    const keys = await loadSuppressedKeys(fakeDb(["k-bad"]));
    expect(keys.has("k-bad")).toBe(true);
    expect(keys.has("k-good")).toBe(false);
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
      expect(result.suppressedCount).toBe(0);
      expect(result.dedupedCount).toBe(0);
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

  it("purges suppressed rows already in D1, then skips them upstream", async () => {
    const db = fakeDb(["k-bad"]);
    const bad = { ...upstream, idempotencyKey: "k-bad", label: "Bad row" };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ expenses: [bad], hasMore: false, nextCursor: null }),
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await syncExpenses({
        UPSTREAM_URL: "https://usage.jays.services",
        USAGE_READ_TOKEN: "x",
        EXPENSES_DB: db,
      });
      expect(result.suppressedCount).toBe(1);
      expect(result.upserted).toBe(0);
      // The suppression purge runs as a DELETE against suppressed_expenses.
      const sqls = db.prepare.mock.calls.map((c) => c[0]);
      expect(
        sqls.some(
          (s) => s.includes("DELETE FROM expenses") && s.includes("suppressed_expenses")
        )
      ).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("skips suppressed keys and collapses double-posts", async () => {
    const db = fakeDb(["k-bad"]);
    const bad = { ...upstream, idempotencyKey: "k-bad", label: "Bad row" };
    const oneTime = { ...upstream, idempotencyKey: "k-one", kind: "one_time" };
    const usageDupe = { ...upstream, idempotencyKey: "k-dupe", kind: "usage" };
    const solo = { ...upstream, idempotencyKey: "k-solo", kind: "one_time", label: "Solo" };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        expenses: [bad, oneTime, usageDupe, solo],
        hasMore: false,
        nextCursor: null,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await syncExpenses({
        UPSTREAM_URL: "https://usage.jays.services",
        USAGE_READ_TOKEN: "x",
        EXPENSES_DB: db,
      });
      expect(result.suppressedCount).toBe(1);
      expect(result.dedupedCount).toBe(1);
      // k-bad suppressed, k-dupe collapsed into k-one: k-one + k-solo upsert.
      expect(result.upserted).toBe(2);
      const bound = db.batch.mock.calls[0][0];
      expect(bound).toHaveLength(2);
      expect(bound.map((s) => s.args[0]).sort()).toEqual(["k-one", "k-solo"]);
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
