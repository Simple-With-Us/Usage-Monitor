import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../sync.mjs", () => ({
  syncExpenses: vi.fn(),
}));

import worker from "../index.mjs";
import { syncExpenses } from "../sync.mjs";

const TOKEN = "t".repeat(64);
const syncRequest = () =>
  new Request("https://expenses.jays.services/api/sync", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}` },
  });

beforeEach(() => {
  syncExpenses.mockReset();
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
