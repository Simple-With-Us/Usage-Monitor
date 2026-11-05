import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildUpsertStatements,
  changedRows,
  DAILY_ROWS_WRITTEN_BUDGET,
  dedupeUpstreamRows,
  expenseFingerprint,
  loadSuppressedKeys,
  MAX_CHANGED_ROWS_PER_RUN,
  MAX_PAGES,
  MAX_UPSTREAM_ROWS,
  mapUpstreamExpense,
  rowsWrittenToday,
  syncExpenses,
} from "../sync.mjs";
import { BudgetExceeded } from "../budget-guard.mjs";

const SCHEMA = readFileSync(new URL("../../schema.sql", import.meta.url), "utf8");
const today = () => new Date().toISOString().slice(0, 10);

/**
 * D1's API over real SQLite, so the SQL itself is exercised.  rows_written copies
 * the live measurement: 3 for each expenses row (table plus 2 indexes), else 1.
 */
function sqliteD1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(SCHEMA);
  const writes = [];
  const reads = [];
  const statement = (sql, args = []) => ({
    sql,
    args,
    bind: (...bound) => statement(sql, bound),
    all: async () => {
      reads.push(sql);
      return { results: sqlite.prepare(sql).all(...args) };
    },
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => {
      const { changes } = sqlite.prepare(sql).run(...args);
      const perRow = /(INTO|FROM) expenses/.test(sql) ? 3 : 1;
      if (changes > 0) writes.push(sql);
      return { meta: { changes: Number(changes), rows_written: Number(changes) * perRow } };
    },
  });
  return {
    prepare: (sql) => statement(sql),
    batch: async (statements) => Promise.all(statements.map((s) => s.run())),
    writes,
    reads,
    state: (key) => sqlite.prepare("SELECT value FROM sync_state WHERE key = ?").get(key)?.value,
    setState: (key, value) =>
      sqlite.prepare("INSERT OR REPLACE INTO sync_state (key, value) VALUES (?, ?)").run(key, value),
    suppress: (key) =>
      sqlite
        .prepare("INSERT INTO suppressed_expenses VALUES (?, 'test', '2026-11-04')")
        .run(key),
    rows: () => sqlite.prepare("SELECT * FROM expenses ORDER BY idempotency_key").all(),
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

const expense = (key, fields = {}) => ({
  ...upstream,
  idempotencyKey: key,
  label: `Invoice ${key}`,
  ...fields,
});

const page = (expenses, nextCursor = null, extra = {}) => ({
  ok: true,
  text: async () =>
    JSON.stringify({ expenses, nextCursor, hasMore: nextCursor !== null, ...extra }),
});

const envFor = (db) => ({
  UPSTREAM_URL: "https://usage.jays.services",
  USAGE_READ_TOKEN: "t".repeat(64),
  EXPENSES_DB: db,
});

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
  it("upserts on the idempotency key and never rewrites synced_at", () => {
    const stmts = buildUpsertStatements(
      sqliteD1(),
      [mapUpstreamExpense(upstream)],
      "2026-10-05T00:00:00Z"
    );
    expect(stmts).toHaveLength(1);
    expect(stmts[0].sql).toContain("ON CONFLICT(idempotency_key) DO UPDATE");
    expect(stmts[0].sql).not.toContain("synced_at = excluded.synced_at");
    expect(stmts[0].args[0]).toBe("owner-recorded-expense:v1:abc");
  });

  it("leaves a row untouched when no field differs", async () => {
    const db = sqliteD1();
    const row = mapUpstreamExpense(upstream);
    await db.batch(buildUpsertStatements(db, [row], "first"));
    const [result] = await db.batch(buildUpsertStatements(db, [row], "second"));
    expect(result.meta.changes).toBe(0);
    expect(db.rows()[0].synced_at).toBe("first");
    const [changed] = await db.batch(
      buildUpsertStatements(db, [{ ...row, amount_usd: 1 }], "third")
    );
    expect(changed.meta.changes).toBe(1);
    expect(db.rows()[0]).toMatchObject({ amount_usd: 1, synced_at: "first" });
  });
});

describe("changedRows", () => {
  const row = mapUpstreamExpense(upstream);
  // D1 hands every column back, with NULL for the fields upstream leaves unset.
  const stored = new Map([[row.idempotency_key, { ...row }]]);

  it("treats a null column and a mapped null as equal", () => {
    expect(row.calendar_sort).toBeNull();
    expect(changedRows([row], stored)).toEqual([]);
  });

  it("returns new rows and rows with a differing field", () => {
    const edited = { ...row, category: "other" };
    expect(changedRows([edited], stored)).toEqual([edited]);
    expect(changedRows([row], new Map())).toEqual([row]);
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
    const db = sqliteD1();
    db.suppress("k-bad");
    const keys = await loadSuppressedKeys(db);
    expect(keys.has("k-bad")).toBe(true);
    expect(keys.has("k-good")).toBe(false);
  });
});

describe("rowsWrittenToday", () => {
  it("counts only the current UTC day and fails closed on a bad value", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(rowsWrittenToday(undefined, "2026-11-04")).toBe(0);
    expect(rowsWrittenToday("2026-11-04:12", "2026-11-04")).toBe(12);
    expect(rowsWrittenToday("2026-11-03:4999", "2026-11-04")).toBe(0);
    expect(() => rowsWrittenToday("garbage", "2026-11-04")).toThrow(BudgetExceeded);
  });
});

describe("syncExpenses", () => {
  let fetchMock;
  let db;

  beforeEach(() => {
    db = sqliteD1();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const expenseWrites = () => db.writes.filter((sql) => /(INTO|FROM) expenses/.test(sql));

  it("reads every page before writing, with the bearer, cursor and a timeout", async () => {
    fetchMock.mockResolvedValueOnce(page([upstream], "cursor-1")).mockResolvedValueOnce(page([]));
    const result = await syncExpenses(envFor(db));
    expect(result).toMatchObject({ upserted: 1, pages: 2, suppressedCount: 0, dedupedCount: 0 });
    expect(String(fetchMock.mock.calls[1][0])).toContain("cursor=cursor-1");
    expect(fetchMock.mock.calls[0][1].headers.authorization).toBe("Bearer " + "t".repeat(64));
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(db.rows()).toHaveLength(1);
  });

  it("writes only state on an identical second run, without comparing rows", async () => {
    fetchMock.mockImplementation(async () => page([upstream, expense("k2")]));
    const first = await syncExpenses(envFor(db));
    expect(first).toMatchObject({ upserted: 2, unchanged: false });
    const firstSeen = db.state("last_sync_at");
    db.setState("last_sync_at", "2000-01-01T00:00:00.000Z");
    db.writes.length = 0;
    db.reads.length = 0;

    const second = await syncExpenses(envFor(db));

    expect(second).toMatchObject({ upserted: 0, unchanged: true, pages: 1 });
    expect(expenseWrites()).toEqual([]);
    expect(db.reads.some((sql) => sql.includes("FROM expenses"))).toBe(false);
    expect(db.state("last_sync_at") >= firstSeen).toBe(true);
    // last_sync_at and the counter, so 48 rows a day on the hourly cron.
    expect(db.writes).toHaveLength(2);
  });

  it("skips an unchanged ledger that spans several pages", async () => {
    const pages = () => [page([upstream], "c1"), page([expense("k2")])];
    let queue = pages();
    fetchMock.mockImplementation(async () => queue.shift());
    await syncExpenses(envFor(db));
    db.writes.length = 0;
    queue = pages();
    expect(await syncExpenses(envFor(db))).toMatchObject({ unchanged: true, pages: 2 });
    expect(expenseWrites()).toEqual([]);
  });

  it("writes no rows when the text changed but no stored field did", async () => {
    fetchMock.mockResolvedValueOnce(page([upstream]));
    await syncExpenses(envFor(db));
    const hash = db.state("upstream_hash");
    db.writes.length = 0;

    fetchMock.mockResolvedValueOnce(page([{ ...upstream, dueDate: "2026-12-01" }]));
    const result = await syncExpenses(envFor(db));

    expect(result).toMatchObject({ upserted: 0, unchanged: false });
    expect(expenseWrites()).toEqual([]);
    expect(db.state("upstream_hash")).not.toBe(hash);
  });

  it("writes only the row that changed and keeps its first synced_at", async () => {
    fetchMock.mockResolvedValueOnce(page([upstream, expense("k2")]));
    await syncExpenses(envFor(db));
    const before = db.rows();
    db.writes.length = 0;

    fetchMock.mockResolvedValueOnce(page([upstream, expense("k2", { amountUsd: 5 })]));
    const result = await syncExpenses(envFor(db));

    expect(result.upserted).toBe(1);
    expect(expenseWrites()).toHaveLength(1);
    const k2 = db.rows().find((row) => row.idempotency_key === "k2");
    expect(k2.amount_usd).toBe(5);
    expect(k2.synced_at).toBe(before.find((row) => row.idempotency_key === "k2").synced_at);
  });

  it("does a full pass when the suppression list changes, then purges the row", async () => {
    fetchMock.mockImplementation(async () => page([upstream, expense("k-bad")]));
    await syncExpenses(envFor(db));
    expect(db.rows()).toHaveLength(2);

    db.suppress("k-bad");
    const result = await syncExpenses(envFor(db));

    expect(result).toMatchObject({ unchanged: false, suppressedCount: 1, upserted: 0 });
    expect(db.rows().map((row) => row.idempotency_key)).toEqual([upstream.idempotencyKey]);
  });

  it("does not run the purge DELETE when no suppressed row is mirrored", async () => {
    db.suppress("k-bad");
    fetchMock.mockResolvedValueOnce(page([expense("k-bad"), upstream]));
    await syncExpenses(envFor(db));
    expect(db.writes.some((sql) => sql.startsWith("DELETE"))).toBe(false);
    expect(db.rows()).toHaveLength(1);
  });

  it("skips suppressed keys and collapses double-posts", async () => {
    db.suppress("k-bad");
    const bad = { ...upstream, idempotencyKey: "k-bad", label: "Bad row" };
    const oneTime = { ...upstream, idempotencyKey: "k-one", kind: "one_time" };
    const usageDupe = { ...upstream, idempotencyKey: "k-dupe", kind: "usage" };
    const solo = { ...upstream, idempotencyKey: "k-solo", kind: "one_time", label: "Solo" };
    fetchMock.mockResolvedValueOnce(page([bad, oneTime, usageDupe, solo]));

    const result = await syncExpenses(envFor(db));

    expect(result).toMatchObject({ suppressedCount: 1, dedupedCount: 1, upserted: 2 });
    expect(db.rows().map((row) => row.idempotency_key)).toEqual(["k-one", "k-solo"]);
  });

  it("collapses a double-post across a page boundary", async () => {
    const oneTime = { ...upstream, idempotencyKey: "k-one", kind: "one_time" };
    const usageDupe = { ...upstream, idempotencyKey: "k-dupe", kind: "usage" };
    fetchMock.mockResolvedValueOnce(page([usageDupe], "c1")).mockResolvedValueOnce(page([oneTime]));
    const result = await syncExpenses(envFor(db));
    expect(result).toMatchObject({ dedupedCount: 1, upserted: 1 });
  });

  describe("pagination guards write nothing", () => {
    const expectNoWrites = () => {
      expect(db.writes).toEqual([]);
      expect(db.rows()).toEqual([]);
    };

    it("stops a stream of ever-new cursors at the page cap", async () => {
      let n = 0;
      fetchMock.mockImplementation(async () => page([expense(`k${n}`)], `cursor-${n++}`));
      await expect(syncExpenses(envFor(db))).rejects.toThrow(BudgetExceeded);
      expect(fetchMock).toHaveBeenCalledTimes(MAX_PAGES);
      expectNoWrites();
    });

    it("stops a repeated cursor", async () => {
      fetchMock.mockImplementation(async () => page([upstream], "same"));
      await expect(syncExpenses(envFor(db))).rejects.toThrow("repeated a cursor");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expectNoWrites();
    });

    it("refuses hasMore with no cursor instead of recording a partial ledger", async () => {
      fetchMock.mockResolvedValueOnce(page([upstream], null, { hasMore: true }));
      await expect(syncExpenses(envFor(db))).rejects.toThrow("hasMore without a cursor");
      expectNoWrites();
    });

    it("aborts when upstream returns over the row cap", async () => {
      const rows = Array.from({ length: MAX_UPSTREAM_ROWS + 1 }, (_, i) => expense(`k${i}`));
      fetchMock.mockResolvedValueOnce(page(rows));
      await expect(syncExpenses(envFor(db))).rejects.toThrow("over 5000 rows");
      expectNoWrites();
    });
  });

  describe("an empty or broken upstream", () => {
    const seed = async () => {
      fetchMock.mockResolvedValueOnce(page([upstream]));
      await syncExpenses(envFor(db));
      db.setState("last_sync_at", "2026-11-01T00:00:00.000Z");
    };

    it("fails on zero rows over a full mirror and leaves the sync state alone", async () => {
      await seed();
      const hash = db.state("upstream_hash");
      db.writes.length = 0;
      fetchMock.mockResolvedValueOnce(page([]));

      await expect(syncExpenses(envFor(db))).rejects.toThrow("no rows");

      expect(db.writes).toEqual([]);
      expect(db.state("last_sync_at")).toBe("2026-11-01T00:00:00.000Z");
      expect(db.state("upstream_hash")).toBe(hash);
      expect(db.rows()).toHaveLength(1);
    });

    it("also fails when every upstream row is suppressed", async () => {
      await seed();
      db.suppress("k-other");
      fetchMock.mockResolvedValueOnce(page([expense("k-other")]));
      await expect(syncExpenses(envFor(db))).rejects.toThrow("no rows");
      expect(db.state("last_sync_at")).toBe("2026-11-01T00:00:00.000Z");
    });

    it("accepts zero rows over an empty mirror", async () => {
      fetchMock.mockResolvedValueOnce(page([]));
      expect(await syncExpenses(envFor(db))).toMatchObject({ upserted: 0 });
      expect(db.state("last_sync_at")).toBeTruthy();
    });

    it("fails on a 200 with no expenses list", async () => {
      fetchMock.mockResolvedValueOnce({ ok: true, text: async () => '{"error":"nope"}' });
      await expect(syncExpenses(envFor(db))).rejects.toThrow("no expenses list");
      expect(db.writes).toEqual([]);
    });

    it("throws when the upstream read fails", async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });
      await expect(syncExpenses(envFor(db))).rejects.toThrow("upstream 401");
      expect(db.writes).toEqual([]);
    });
  });

  describe("write caps", () => {
    it("writes the first slice over the per-run cap, then finishes on later runs", async () => {
      const count = MAX_CHANGED_ROWS_PER_RUN + 5;
      const rows = Array.from({ length: count }, (_, i) => expense(`k${i}`));
      fetchMock.mockImplementation(async () => page(rows));

      await expect(syncExpenses(envFor(db))).rejects.toThrow("changed rows over 300");
      expect(db.rows()).toHaveLength(MAX_CHANGED_ROWS_PER_RUN);
      expect(db.state("last_sync_at")).toBeUndefined();
      expect(db.state("upstream_hash")).toBeUndefined();

      expect(await syncExpenses(envFor(db))).toMatchObject({ upserted: 5 });
      expect(db.rows()).toHaveLength(count);
      expect(db.state("upstream_hash")).toBeTruthy();
    });

    it("records rows written from D1's meta", async () => {
      fetchMock.mockResolvedValueOnce(page([upstream, expense("k2")]));
      await syncExpenses(envFor(db));
      // Reservation 1 + 2 rows x 3 + last_sync_at + hash + counter.
      expect(db.state("rows_written_today")).toBe(`${today()}:10`);
    });

    it("refuses before fetching once the day's budget is spent", async () => {
      db.setState("rows_written_today", `${today()}:${DAILY_ROWS_WRITTEN_BUDGET}`);
      await expect(syncExpenses(envFor(db))).rejects.toThrow(BudgetExceeded);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(db.writes).toEqual([]);
    });

    it("refuses before writing when the planned rows would pass the budget", async () => {
      db.setState("rows_written_today", `${today()}:${DAILY_ROWS_WRITTEN_BUDGET - 10}`);
      fetchMock.mockResolvedValueOnce(page([upstream, expense("k2"), expense("k3")]));
      await expect(syncExpenses(envFor(db))).rejects.toThrow(BudgetExceeded);
      expect(db.writes).toEqual([]);
      expect(db.rows()).toEqual([]);
    });

    it("starts a new budget on a new UTC day", async () => {
      db.setState("rows_written_today", `2000-01-01:${DAILY_ROWS_WRITTEN_BUDGET}`);
      fetchMock.mockResolvedValueOnce(page([upstream]));
      expect(await syncExpenses(envFor(db))).toMatchObject({ upserted: 1 });
    });

    it("keeps the reservation and stores no hash when a batch fails", async () => {
      fetchMock.mockResolvedValueOnce(page([upstream]));
      const realBatch = db.batch;
      db.batch = async () => {
        throw new Error("D1 failed");
      };
      await expect(syncExpenses(envFor(db))).rejects.toThrow("D1 failed");
      db.batch = realBatch;
      expect(db.state("upstream_hash")).toBeUndefined();
      expect(db.state("last_sync_at")).toBeUndefined();
      // 1 row x 4 + the 3 state rows + the reservation itself.
      expect(db.state("rows_written_today")).toBe(`${today()}:8`);
    });
  });

  describe("manual sync cooldown", () => {
    it("answers a second call inside the window with no fetch and no write", async () => {
      fetchMock.mockResolvedValue(page([upstream]));
      expect(await syncExpenses(envFor(db), { manual: true })).toMatchObject({ upserted: 1 });
      fetchMock.mockClear();
      db.writes.length = 0;

      const second = await syncExpenses(envFor(db), { manual: true });

      expect(second).toEqual({ cooldown: true, retryAfterSeconds: 60 });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(db.writes).toEqual([]);
    });

    it("cools a caller retrying a failed sync too", async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 502 });
      await expect(syncExpenses(envFor(db), { manual: true })).rejects.toThrow("upstream 502");
      expect(await syncExpenses(envFor(db), { manual: true })).toMatchObject({ cooldown: true });
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it("lets a call through after the window, and the cron never waits on it", async () => {
      fetchMock.mockResolvedValue(page([upstream]));
      db.setState("manual_sync_at", new Date(Date.now() - 61_000).toISOString());
      expect(await syncExpenses(envFor(db), { manual: true })).toMatchObject({ upserted: 1 });
      expect(await syncExpenses(envFor(db))).toMatchObject({ unchanged: true });
    });
  });

  it("refuses to run without configuration", async () => {
    await expect(syncExpenses({ EXPENSES_DB: db })).rejects.toThrow("must be configured");
  });
});
