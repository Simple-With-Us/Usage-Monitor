import { describe, expect, it, vi } from "vitest";

vi.mock("../sync.mjs", () => ({
  syncExpenses: vi.fn(),
}));

import worker from "../index.mjs";
import { syncExpenses } from "../sync.mjs";

describe("expenses worker scheduled", () => {
  it("logs sync failures without rejecting the scheduled invocation", async () => {
    const error = new Error("upstream 503 from /api/owner-expenses");
    syncExpenses.mockRejectedValueOnce(error);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const waitUntilPromises = [];
    const ctx = {
      waitUntil(promise) {
        waitUntilPromises.push(promise);
      },
    };

    await worker.scheduled({}, { UPSTREAM_URL: "https://usage.jays.services" }, ctx);
    await Promise.all(waitUntilPromises);

    expect(syncExpenses).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledWith("expenses scheduled sync failed:", error);
    consoleError.mockRestore();
  });
});
