// The real Worker against local D1 in workerd, with a fake upstream.  What this
// pins that sync.test.mjs cannot: D1's own meta.rows_written, which the daily
// write budget trusts, and the query plans once the migration has run.  Local D1
// is not remote D1, so the live numbers still need checking after a deploy.
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "./src/index.mjs";
import schema from "./schema.sql?raw";
import migration from "./migrations/0001_drop_idx_expenses_category.sql?raw";

const db = env.EXPENSES_DB;
const LEDGER_ROWS = 256;
// One insert writes the table, its primary key index and the secondary indexes.
const INSERT_ROWS_MIN = 3;
const INSERT_ROWS_MAX = 4;

const statements = (sql) =>
  sql
    .replace(/--.*$/gm, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);

const expense = (i) => ({
  idempotencyKey: `owner-recorded-expense:v1:${String(i).padStart(4, "0")}`,
  vendor: i % 2 ? "Anthropic" : "Example Host",
  amountUsd: 10 + i / 100,
  occurredAt: new Date(Date.UTC(2026, 8, 1 + (i % 28))).toISOString(),
  kind: "usage",
  label: `Invoice ${i}`,
  confidence: "actual",
});

const state = async (key) =>
  (await db.prepare("SELECT value FROM sync_state WHERE key = ?").bind(key).first())?.value;

const counter = async () => {
  const value = await state("rows_written_today");
  return value === undefined ? 0 : Number(value.split(":")[1]);
};

const cron = async () => {
  const before = await counter();
  await worker.scheduled({ noRetry() {} }, env);
  return (await counter()) - before;
};

const sync = () =>
  worker.fetch(
    new Request("https://x.test/api/sync", {
      method: "POST",
      headers: { authorization: "Bearer local-only" },
    }),
    env
  );

const plan = async (sql) =>
  (await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all()).results
    .map((row) => row.detail)
    .join(" | ");

const upsert = (amount) =>
  db
    .prepare(
      `INSERT INTO expenses (idempotency_key, vendor, amount_usd, occurred_at, kind, category, synced_at)
       VALUES ('probe', 'v', ?, '2026-01-01', 'usage', 'other', 'x')
       ON CONFLICT(idempotency_key) DO UPDATE SET amount_usd = excluded.amount_usd
       WHERE amount_usd IS NOT excluded.amount_usd`
    )
    .bind(amount)
    .run();

describe("expenses sync on local D1", () => {
  let ledger;
  let upstreamCalls;

  beforeEach(async () => {
    for (const table of ["expenses", "sync_state", "suppressed_expenses"]) {
      await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
    }
    for (const statement of statements(schema)) await db.prepare(statement).run();
    ledger = Array.from({ length: LEDGER_ROWS }, (_, i) => expense(i));
    upstreamCalls = 0;
    vi.stubGlobal("fetch", async () => {
      upstreamCalls += 1;
      return new Response(JSON.stringify({ expenses: ledger, nextCursor: null, hasMore: false }));
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("counts a no-op upsert and a refused cooldown claim as 0 rows written", async () => {
    expect((await upsert(1)).meta.rows_written).toBeGreaterThanOrEqual(INSERT_ROWS_MIN);
    expect((await upsert(1)).meta.rows_written).toBe(0);
    expect((await upsert(2)).meta.rows_written).toBe(1);

    const claim = (value) =>
      db
        .prepare(
          `INSERT INTO sync_state (key, value) VALUES ('probe', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value
           WHERE sync_state.value <= 'a'`
        )
        .bind(value)
        .run();
    await claim("b");
    const refused = await claim("c");
    expect(refused.meta.rows_written).toBe(0);
    expect(refused.meta.changes).toBe(0);
  });

  it("writes only state when nothing changed, and only the changed row otherwise", async () => {
    const first = await cron();
    expect(first).toBeGreaterThanOrEqual(LEDGER_ROWS * INSERT_ROWS_MIN);
    expect(first).toBeLessThanOrEqual(LEDGER_ROWS * INSERT_ROWS_MAX + 10);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM expenses").first()).n).toBe(LEDGER_ROWS);

    // The two state rows are last_sync_at and the counter, 48 rows a day at most.
    expect(await cron()).toBe(2);
    expect(await cron()).toBe(2);

    // New upstream text, nothing stored differs: a full compare that writes no expense.
    ledger = ledger.map((row, i) => (i === 3 ? { ...row, dueDate: "2026-12-01" } : row));
    expect(await cron()).toBeLessThanOrEqual(5);

    ledger = ledger.map((row, i) => (i === 5 ? { ...row, amountUsd: 99.5 } : row));
    expect(await cron()).toBeLessThanOrEqual(5 + INSERT_ROWS_MAX);
    const changed = await db
      .prepare("SELECT amount_usd FROM expenses WHERE idempotency_key = ?")
      .bind(expense(5).idempotencyKey)
      .first();
    expect(changed.amount_usd).toBe(99.5);
    expect(await cron()).toBe(2);
  });

  it("answers a second manual sync with 429, no upstream call and no write", async () => {
    await cron();
    const calls = upstreamCalls;
    const first = await sync();
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, unchanged: true });
    expect(upstreamCalls).toBe(calls + 1);

    const before = await state("rows_written_today");
    const second = await sync();
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBe("60");
    expect(upstreamCalls).toBe(calls + 1);
    expect(await state("rows_written_today")).toBe(before);
  });

  it("fails an empty upstream over a full mirror, writing nothing and holding the footer", async () => {
    await cron();
    const footer = await state("last_sync_at");
    const hash = await state("upstream_hash");
    const before = await counter();
    ledger = [];
    await expect(worker.scheduled({ noRetry() {} }, env)).rejects.toThrow(/no rows/);
    expect(await state("last_sync_at")).toBe(footer);
    expect(await state("upstream_hash")).toBe(hash);
    expect(await counter()).toBe(before);
  });

  it("serves every read route, before and after the migration", async () => {
    await cron();
    const health = await worker.fetch(new Request("https://x.test/health"), env);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });

    const page = await worker.fetch(new Request("https://x.test/"), env);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("every hour");

    const byCategory = async () => {
      const response = await worker.fetch(
        new Request("https://x.test/api/expenses?category=tech-ai"),
        env
      );
      expect(response.status).toBe(200);
      return (await response.json()).expenses.map((row) => row.id);
    };
    const before = await byCategory();
    expect(before.length).toBeGreaterThan(0);

    for (const statement of statements(migration)) await db.prepare(statement).run();

    expect(await byCategory()).toEqual(before);
    expect(
      await plan(
        "SELECT * FROM expenses WHERE occurred_at >= date('now','-6 months') ORDER BY occurred_at DESC LIMIT 1000"
      )
    ).toContain("idx_expenses_occurred");
    expect(await plan("SELECT COUNT(*) AS n FROM expenses")).not.toContain("idx_expenses_category");
  });
});
