import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildUpsertStatements,
  changedExpenses,
  DAILY_ROWS_WRITTEN_BUDGET,
  dedupeUpstreamRows,
  expenseFingerprint,
  loadSuppressedKeys,
  MAX_CHANGED_ROWS_PER_RUN,
  MAX_PAGES,
  MAX_ROWS_PER_STATEMENT,
  MAX_UPSTREAM_ROWS,
  mapUpstreamExpense,
  parseUpstreamPage,
  rowsWrittenToday,
  STATE_WRITE_ROWS,
  syncExpenses,
} from "../sync.mjs";
import { BudgetExceeded } from "../budget-guard.mjs";

const SCHEMA = readFileSync(new URL("../../schema.sql", import.meta.url), "utf8");
const today = () => new Date().toISOString().slice(0, 10);

/**
 * D1's API over real SQLite, so the SQL itself is exercised.  rows_written copies
 * what sync.workers.test.mjs pins on local D1 for this schema: 3 for an inserted
 * expense, 2 for a changed one, else 1 per row.
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
      const count = () => sqlite.prepare("SELECT COUNT(*) AS n FROM expenses").get().n;
      const before = count();
      const changes = Number(sqlite.prepare(sql).run(...args).changes);
      const inserted = /INTO expenses/.test(sql) ? count() - before : 0;
      const rowsWritten = /INTO expenses/.test(sql)
        ? inserted * 3 + (changes - inserted) * 2
        : changes;
      if (changes > 0) writes.push(sql);
      return { meta: { changes, rows_written: rowsWritten } };
    },
  });
  return {
    prepare: (sql) => statement(sql),
    batch: async (statements) => Promise.all(statements.map((s) => s.run())),
    writes,
    reads,
    exec: (sql) => sqlite.exec(sql),
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

describe("changedExpenses", () => {
  const row = mapUpstreamExpense(upstream);
  // D1 hands every column back, with NULL for the fields upstream leaves unset.
  const stored = new Map([[row.idempotency_key, { ...row }]]);

  it("treats a null column and a mapped null as equal", () => {
    expect(row.calendar_sort).toBeNull();
    expect(changedExpenses([upstream], stored)).toEqual([]);
  });

  it("returns new rows and rows with a differing field", () => {
    const edited = { ...upstream, amountUsd: 1 };
    expect(changedExpenses([edited], stored, { recategorize: false })).toEqual([edited]);
    expect(changedExpenses([upstream], new Map(), { recategorize: false })).toEqual([upstream]);
  });

  it("looks at a stored category only when the rules changed", () => {
    const stale = new Map([[row.idempotency_key, { ...row, category: "other" }]]);
    expect(changedExpenses([upstream], stale, { recategorize: false })).toEqual([]);
    expect(changedExpenses([upstream], stale, { recategorize: true })).toEqual([upstream]);
  });
});

describe("parseUpstreamPage", () => {
  const good = { expenses: [upstream], nextCursor: null, hasMore: false };
  const parse = (body) => () => parseUpstreamPage(JSON.stringify(body));
  const withRow = (fields) => parse({ ...good, expenses: [{ ...upstream, ...fields }] });

  it("accepts the page the upstream route sends, and drops unknown page keys", () => {
    expect(parseUpstreamPage(JSON.stringify({ ...good, extra: 1 }))).toEqual({
      expenses: [JSON.parse(JSON.stringify(upstream))],
      nextCursor: null,
      hasMore: false,
    });
    // label is nullable upstream, and notes and calendarSort are left out when unset.
    expect(withRow({ label: null, notes: undefined })).not.toThrow();
  });

  it("passes unknown row keys through, and the mapping keeps them out of D1", () => {
    const body = { ...good, expenses: [{ ...upstream, dueDate: "2026-12-01" }] };
    const [row] = parseUpstreamPage(JSON.stringify(body)).expenses;
    expect(row.dueDate).toBe("2026-12-01");
    expect(mapUpstreamExpense(row)).not.toHaveProperty("dueDate");
  });

  it("refuses text that is not JSON, without quoting it", () => {
    expect(() => parseUpstreamPage("<html>private</html>")).toThrow(
      /^upstream answered with invalid JSON$/
    );
  });

  it("refuses a page with a bad shape", () => {
    expect(() => parseUpstreamPage("null")).toThrow("no expenses list");
    expect(parse({ ...good, expenses: "nope" })).toThrow("no expenses list");
    expect(parse({ expenses: [], nextCursor: null })).toThrow("no hasMore flag");
    expect(parse({ expenses: [], hasMore: true, nextCursor: 5 })).toThrow("bad nextCursor");
    expect(parse({ expenses: [], hasMore: false })).toThrow("bad nextCursor");
    expect(parse({ ...good, expenses: [null] })).toThrow("expense 0 has a bad row");
  });

  it.each([
    ["idempotencyKey", ""],
    ["idempotencyKey", 7],
    ["vendor", null],
    ["amountUsd", "12.50"],
    ["amountUsd", null],
    ["occurredAt", "not a date"],
    ["occurredAt", 20260930],
    ["kind", 1],
    ["label", {}],
    ["notes", []],
    ["confidence", 1],
    ["calendarSort", 1],
  ])("refuses a row whose %s is %j, naming the field and not the value", (field, value) => {
    expect(withRow({ [field]: value })).toThrow(`upstream expense 0 has a bad ${field}`);
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

    it("finishes an emptied ledger once the mirror is cleared by hand", async () => {
      await seed();
      fetchMock.mockImplementation(async () => page([]));
      await expect(syncExpenses(envFor(db))).rejects.toThrow("no rows");

      db.exec("DELETE FROM expenses");
      db.exec("DELETE FROM sync_state WHERE key = 'upstream_hash'");
      expect(await syncExpenses(envFor(db))).toMatchObject({ upserted: 0, unchanged: false });
      expect(db.state("last_sync_at")).not.toBe("2026-11-01T00:00:00.000Z");
      expect(await syncExpenses(envFor(db))).toMatchObject({ unchanged: true });
    });

    it("refills a cleared mirror when upstream comes back with the old text", async () => {
      await seed();
      db.exec("DELETE FROM expenses");
      db.exec("DELETE FROM sync_state WHERE key = 'upstream_hash'");
      fetchMock.mockResolvedValueOnce(page([upstream]));
      expect(await syncExpenses(envFor(db))).toMatchObject({ upserted: 1, unchanged: false });
      expect(db.rows()).toHaveLength(1);
    });

    it("writes nothing when one upstream row is malformed", async () => {
      await seed();
      db.writes.length = 0;
      fetchMock.mockResolvedValueOnce(page([expense("k2"), expense("k3", { amountUsd: "12" })]));
      await expect(syncExpenses(envFor(db))).rejects.toThrow("expense 1 has a bad amountUsd");
      expect(db.writes).toEqual([]);
      expect(db.rows()).toHaveLength(1);
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

    it("does not skip a half-written mirror when upstream goes back to the old text", async () => {
      const original = [upstream];
      fetchMock.mockResolvedValueOnce(page(original));
      await syncExpenses(envFor(db));
      expect(db.state("upstream_hash")).toBeTruthy();

      // A burst past the cap writes the first slice and fails the run.
      const burst = Array.from({ length: MAX_CHANGED_ROWS_PER_RUN + 1 }, (_, i) => ({
        ...upstream,
        idempotencyKey: i === 0 ? upstream.idempotencyKey : `k${i}`,
        amountUsd: i === 0 ? 1 : upstream.amountUsd,
        label: i === 0 ? upstream.label : `Invoice ${i}`,
      }));
      fetchMock.mockResolvedValueOnce(page(burst));
      await expect(syncExpenses(envFor(db))).rejects.toThrow("changed rows over 300");
      expect(db.rows().find((row) => row.idempotency_key === upstream.idempotencyKey).amount_usd).toBe(1);
      expect(db.state("upstream_hash")).toBeUndefined();

      fetchMock.mockResolvedValueOnce(page(original));
      const result = await syncExpenses(envFor(db));

      expect(result).toMatchObject({ unchanged: false, upserted: 1 });
      expect(db.rows().find((row) => row.idempotency_key === upstream.idempotencyKey).amount_usd).toBe(
        upstream.amountUsd
      );
    });

    it("counts the hash clear in the reservation when a write fails", async () => {
      fetchMock.mockResolvedValueOnce(page([upstream]));
      await syncExpenses(envFor(db));
      const before = Number(db.state("rows_written_today").split(":")[1]);
      fetchMock.mockResolvedValueOnce(page([{ ...upstream, amountUsd: 7 }]));
      const realBatch = db.batch;
      db.batch = async () => {
        throw new Error("D1 failed");
      };
      await expect(syncExpenses(envFor(db))).rejects.toThrow("D1 failed");
      db.batch = realBatch;
      expect(db.state("upstream_hash")).toBeUndefined();
      // A failed run keeps what it reserved: one upsert at the worst case, the final
      // state write, the hash clear and the reservation itself.
      expect(db.state("rows_written_today")).toBe(
        `${today()}:${before + MAX_ROWS_PER_STATEMENT + STATE_WRITE_ROWS + 2}`
      );
    });

    it("records rows written from D1's meta", async () => {
      fetchMock.mockResolvedValueOnce(page([upstream, expense("k2")]));
      await syncExpenses(envFor(db));
      // Settled to what was written: reservation 1, 2 inserts x 3, then last_sync_at,
      // hash, basis and counter.
      expect(db.state("rows_written_today")).toBe(`${today()}:11`);
    });

    it("adds up the writes of overlapping runs instead of overwriting them", async () => {
      fetchMock.mockImplementation(async () => page([upstream]));
      await syncExpenses(envFor(db));
      const before = Number(db.state("rows_written_today").split(":")[1]);

      const runs = await Promise.all([syncExpenses(envFor(db)), syncExpenses(envFor(db))]);

      expect(runs).toMatchObject([{ unchanged: true }, { unchanged: true }]);
      // Each run read the same counter, and each costs last_sync_at and the counter.
      expect(db.state("rows_written_today")).toBe(`${today()}:${before + 4}`);
    });

    it("does not move a counter another run already rolled to a later day", async () => {
      fetchMock.mockResolvedValueOnce(page([upstream]));
      const realBatch = db.batch;
      db.batch = async (statements) => {
        db.setState("rows_written_today", "2999-01-01:7");
        return realBatch(statements);
      };
      await syncExpenses(envFor(db));
      db.batch = realBatch;
      expect(db.state("rows_written_today")).toBe("2999-01-01:7");
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
      // One upsert at the worst case, the final state write and the reservation itself.
      expect(db.state("rows_written_today")).toBe(
        `${today()}:${MAX_ROWS_PER_STATEMENT + STATE_WRITE_ROWS + 1}`
      );
    });
  });

  describe("categories", () => {
    const stored = () => db.rows()[0].category;
    const seed = async () => {
      fetchMock.mockResolvedValueOnce(page([upstream]));
      await syncExpenses(envFor(db));
      expect(stored()).toBe("tech-ai");
      db.exec("UPDATE expenses SET category = 'other'");
    };

    it("does not recategorize rows on a text change while the rules are the same", async () => {
      await seed();
      fetchMock.mockResolvedValueOnce(page([{ ...upstream, dueDate: "2026-12-01" }]));
      expect(await syncExpenses(envFor(db))).toMatchObject({ upserted: 0, unchanged: false });
      expect(stored()).toBe("other");
    });

    it("recategorizes every row when the rules changed, and records the new basis", async () => {
      await seed();
      const basis = db.state("category_basis");
      expect(basis).toBeTruthy();
      db.setState("category_basis", "old");
      db.exec("DELETE FROM sync_state WHERE key = 'upstream_hash'");
      fetchMock.mockResolvedValueOnce(page([upstream]));
      expect(await syncExpenses(envFor(db))).toMatchObject({ upserted: 1 });
      expect(stored()).toBe("tech-ai");
      expect(db.state("category_basis")).toBe(basis);
    });

    it("keeps comparing categories until a capped pass has finished", async () => {
      await seed();
      db.setState("category_basis", "old");
      const rows = Array.from({ length: MAX_CHANGED_ROWS_PER_RUN + 1 }, (_, i) => expense(`k${i}`));
      fetchMock.mockImplementation(async () => page([upstream, ...rows]));
      await expect(syncExpenses(envFor(db))).rejects.toThrow("changed rows over 300");
      expect(db.state("category_basis")).toBe("old");
      await syncExpenses(envFor(db));
      expect(db.state("category_basis")).not.toBe("old");
      expect(db.rows().find((row) => row.idempotency_key === upstream.idempotencyKey).category).toBe(
        "tech-ai"
      );
    });

    it("categorizes a changed row whose label moved it", async () => {
      fetchMock.mockResolvedValueOnce(page([{ ...upstream, vendor: "Nobody", label: "Nothing" }]));
      await syncExpenses(envFor(db));
      expect(stored()).toBe("other");
      fetchMock.mockResolvedValueOnce(page([upstream]));
      await syncExpenses(envFor(db));
      expect(stored()).toBe("tech-ai");
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

    it("writes nothing for a refused claim in the same millisecond as the stored one", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-11-05T22:06:24.123Z"));
      try {
        fetchMock.mockResolvedValue(page([upstream]));
        await syncExpenses(envFor(db), { manual: true });
        const counter = db.state("rows_written_today");
        fetchMock.mockClear();
        db.writes.length = 0;

        const second = await syncExpenses(envFor(db), { manual: true });

        expect(second).toEqual({ cooldown: true, retryAfterSeconds: 60 });
        expect(fetchMock).not.toHaveBeenCalled();
        expect(db.writes).toEqual([]);
        expect(db.state("rows_written_today")).toBe(counter);
      } finally {
        vi.useRealTimers();
      }
    });

    it("cools a caller retrying a failed sync too", async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 502 });
      await expect(syncExpenses(envFor(db), { manual: true })).rejects.toThrow("upstream 502");
      expect(await syncExpenses(envFor(db), { manual: true })).toMatchObject({ cooldown: true });
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it("counts the claim of a manual sync that then fails", async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 502 });
      await expect(syncExpenses(envFor(db), { manual: true })).rejects.toThrow("upstream 502");
      expect(db.state("rows_written_today")).toBe(`${today()}:2`);

      db.setState("manual_sync_at", new Date(Date.now() - 61_000).toISOString());
      await expect(syncExpenses(envFor(db), { manual: true })).rejects.toThrow("upstream 502");
      expect(db.state("rows_written_today")).toBe(`${today()}:4`);
    });

    it("counts nothing for a refused claim", async () => {
      db.setState("rows_written_today", `${today()}:5`);
      db.setState("manual_sync_at", new Date(Date.now() - 1000).toISOString());
      expect(await syncExpenses(envFor(db), { manual: true })).toMatchObject({ cooldown: true });
      expect(db.state("rows_written_today")).toBe(`${today()}:5`);
      expect(db.writes).toEqual([]);
    });

    it("settles a successful manual run to its real writes, claim included", async () => {
      fetchMock.mockResolvedValue(page([upstream]));
      await syncExpenses(envFor(db), { manual: true });
      // Claim and counter 2, reservation 1, insert 3, then last_sync_at, hash, basis, counter.
      expect(db.state("rows_written_today")).toBe(`${today()}:10`);
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
