import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../sync.mjs", () => ({
  syncExpenses: vi.fn(),
}));

import worker, { READ_CACHE_TTL_MS, resetReadCache } from "../index.mjs";
import { syncExpenses } from "../sync.mjs";

const TOKEN = "t".repeat(64);
const syncRequest = () =>
  new Request("https://expenses.jays.services/api/sync", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}` },
  });

beforeEach(() => {
  syncExpenses.mockReset();
  resetReadCache();
});

describe("expenses worker scheduled", () => {
  it("logs a sync failure and rethrows it without allowing a retry", async () => {
    const error = Object.assign(new Error("upstream 503 from /api/owner-expenses"), {
      name: "SyncFailure",
    });
    syncExpenses.mockRejectedValueOnce(error);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const controller = { noRetry: vi.fn() };

    await expect(
      worker.scheduled(controller, { UPSTREAM_URL: "https://usage.jays.services" })
    ).rejects.toBe(error);

    expect(syncExpenses).toHaveBeenCalledOnce();
    expect(controller.noRetry).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledWith(
      JSON.stringify({
        event: "expenses.scheduled_sync_failed",
        reason: "upstream 503 from /api/owner-expenses",
      })
    );
    consoleError.mockRestore();
  });

  it("logs only the name of an error whose text it did not write", async () => {
    const error = new TypeError("row private-vendor-detail");
    syncExpenses.mockRejectedValueOnce(error);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(worker.scheduled({}, {})).rejects.toBe(error);

    expect(consoleError).toHaveBeenCalledWith(
      JSON.stringify({ event: "expenses.scheduled_sync_failed", reason: "TypeError" })
    );
    consoleError.mockRestore();
  });

  it("does nothing when the usage guard is off", async () => {
    await worker.scheduled({}, { GUARD_MODE: "off" });
    expect(syncExpenses).not.toHaveBeenCalled();
  });
});

describe("expenses worker fetch", () => {
  it("answers 503 on every route when the usage guard is off", async () => {
    const env = { GUARD_MODE: "off", USAGE_READ_TOKEN: TOKEN };
    for (const request of [syncRequest(), new Request("https://expenses.jays.services/")]) {
      const response = await worker.fetch(request, env);
      expect(response.status).toBe(503);
    }
    expect(syncExpenses).not.toHaveBeenCalled();
  });

  it("serves /health from a trivial query, with no financial data", async () => {
    const prepare = vi.fn(() => ({ first: async () => ({ 1: 1 }) }));
    const response = await worker.fetch(
      new Request("https://expenses.jays.services/health"),
      { EXPENSES_DB: { prepare } }
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(prepare).toHaveBeenCalledWith("SELECT 1");
  });

  it("fails /health when D1 does not answer", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const prepare = () => ({
      first: async () => {
        throw new Error("D1 down");
      },
    });
    const response = await worker.fetch(
      new Request("https://expenses.jays.services/health"),
      { EXPENSES_DB: { prepare } }
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false });
    expect(consoleError).toHaveBeenCalledWith(
      JSON.stringify({ event: "expenses.health_check_failed", reason: "Error" })
    );
    consoleError.mockRestore();
  });

  it("answers a failed manual sync with no detail, and logs none of it", async () => {
    syncExpenses.mockRejectedValueOnce(new Error("D1_ERROR: private-detail"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await worker.fetch(syncRequest(), { USAGE_READ_TOKEN: TOKEN });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ ok: false, error: "Sync failed" });
    expect(consoleError).toHaveBeenCalledWith(
      JSON.stringify({ event: "expenses.manual_sync_failed", reason: "Error" })
    );
    consoleError.mockRestore();
  });

  it("answers a manual sync inside the cooldown with 429", async () => {
    syncExpenses.mockResolvedValueOnce({ cooldown: true, retryAfterSeconds: 60 });
    const env = { USAGE_READ_TOKEN: TOKEN };
    const response = await worker.fetch(syncRequest(), env);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(syncExpenses).toHaveBeenCalledWith(env, { manual: true });
  });

  it("does not reach the sync without the bearer", async () => {
    const response = await worker.fetch(
      new Request("https://expenses.jays.services/api/sync", { method: "POST" }),
      { USAGE_READ_TOKEN: TOKEN }
    );
    expect(response.status).toBe(401);
    expect(syncExpenses).not.toHaveBeenCalled();
  });
});

describe("expenses dashboard read cache", () => {
  const ROWS = [
    { idempotency_key: "k1", vendor: "V", amount_usd: 5, occurred_at: "2026-11-01T00:00:00Z", kind: "usage", label: "L", category: "software" },
  ];
  // A D1 stand-in that counts statements and lets a test hold a read open.
  function fakeDb({ gate } = {}) {
    const statements = [];
    const prepare = vi.fn((sql) => {
      statements.push(sql);
      const answer = async () => {
        if (gate) await gate;
        if (sql.includes("COUNT(*)")) return { n: 7 };
        if (sql.includes("sync_state")) return { value: "2026-11-27T00:00:00Z" };
        return null;
      };
      return {
        first: answer,
        bind: () => ({ all: async () => ({ results: ROWS }) }),
        all: async () => ({ results: ROWS }),
      };
    });
    return { db: { prepare }, prepare, statements };
  }
  const get = (path, env) => worker.fetch(new Request("https://expenses.jays.services" + path), env);

  it("serves repeated reads inside the window from one D1 read", async () => {
    const { db, prepare } = fakeDb();
    const first = await (await get("/api/expenses", { EXPENSES_DB: db })).json();
    const callsAfterFirst = prepare.mock.calls.length;
    for (let i = 0; i < 20; i++) await get("/api/expenses", { EXPENSES_DB: db });
    expect(prepare.mock.calls.length).toBe(callsAfterFirst);
    expect(first.totalCount).toBe(7);
    expect(first.expenses).toHaveLength(1);
  });

  it("coalesces concurrent requests into one read each", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const { db, prepare } = fakeDb({ gate });
    const pending = Array.from({ length: 10 }, () => get("/api/expenses", { EXPENSES_DB: db }));
    release();
    const responses = await Promise.all(pending);
    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(prepare).toHaveBeenCalledTimes(3);
  });

  it("keeps filters apart, so one filter never answers for another", async () => {
    const { db, statements } = fakeDb();
    await get("/api/expenses?category=personal", { EXPENSES_DB: db });
    await get("/api/expenses?category=software", { EXPENSES_DB: db });
    const selects = statements.filter((sql) => sql.includes("FROM expenses") && !sql.includes("COUNT"));
    expect(selects).toHaveLength(2);
  });

  it("refuses an unknown filter with 400 and never reads D1, so query strings cannot bypass the cache", async () => {
    const { db, prepare } = fakeDb();
    for (const bad of ["nope", "Personal", "__proto__", "toString", "x".repeat(500), "software%20"]) {
      const response = await get("/api/expenses?category=" + bad, { EXPENSES_DB: db });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("Unknown category");
    }
    expect(prepare).not.toHaveBeenCalled();
  });

  it("still answers every real filter, and an empty one means all", async () => {
    const { db } = fakeDb();
    for (const ok of ["", "all", "personal", "tech", "tech-ai", "cloud-hosting", "domains", "software", "services", "other"]) {
      const response = await get("/api/expenses?category=" + ok, { EXPENSES_DB: db });
      expect(response.status).toBe(200);
    }
  });

  it("does not keep a failed read", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    let fail = true;
    const prepare = vi.fn(() => ({
      first: async () => { if (fail) throw new Error("D1 down"); return { n: 1, value: "x" }; },
      all: async () => ({ results: [] }),
    }));
    await expect(get("/api/expenses", { EXPENSES_DB: { prepare } })).rejects.toThrow("D1 down");
    fail = false;
    const response = await get("/api/expenses", { EXPENSES_DB: { prepare } });
    expect(response.status).toBe(200);
    consoleError.mockRestore();
  });

  it("re-reads after the window", async () => {
    vi.useFakeTimers();
    try {
      const { db, prepare } = fakeDb();
      await get("/api/expenses", { EXPENSES_DB: db });
      const n = prepare.mock.calls.length;
      vi.advanceTimersByTime(READ_CACHE_TTL_MS + 1);
      await get("/api/expenses", { EXPENSES_DB: db });
      expect(prepare.mock.calls.length).toBe(n * 2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops the cache after a completed sync, so the footer and rows are not stale", async () => {
    const { db, prepare } = fakeDb();
    await get("/api/expenses", { EXPENSES_DB: db });
    const n = prepare.mock.calls.length;
    syncExpenses.mockResolvedValueOnce({ upserted: 1 });
    const sync = await worker.fetch(syncRequest(), { USAGE_READ_TOKEN: TOKEN, EXPENSES_DB: db });
    expect(sync.status).toBe(200);
    await get("/api/expenses", { EXPENSES_DB: db });
    expect(prepare.mock.calls.length).toBe(n * 2);
  });

  it("keeps the guard-off 503 ahead of any cached read", async () => {
    const { db } = fakeDb();
    await get("/api/expenses", { EXPENSES_DB: db });
    const response = await get("/api/expenses", { EXPENSES_DB: db, GUARD_MODE: "off" });
    expect(response.status).toBe(503);
  });

  it("/health always asks D1, never the cache", async () => {
    const { db, prepare } = fakeDb();
    await get("/health", { EXPENSES_DB: db });
    await get("/health", { EXPENSES_DB: db });
    expect(prepare.mock.calls.filter(([sql]) => sql === "SELECT 1")).toHaveLength(2);
  });
});
