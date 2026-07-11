import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchUsage } from "../pushover";

describe("pushover adapter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T17:00:00.000Z"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("uses the official monthly message-limit endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 1,
          limit: 10_000,
          remaining: 7_496,
          reset: Date.parse("2026-08-01T05:00:00.000Z") / 1000,
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("app-token");

    expect(result.totalRequests).toBe(2_504);
    expect(result.requestUnit).toBe("messages");
    expect(result.requestWindow).toBe("billing_cycle_to_date");
    expect(new Date(result.requestWindowStart!).toISOString()).toBe(
      "2026-07-01T05:00:00.000Z"
    );
    expect(new Date(result.requestWindowEnd!).toISOString()).toBe(
      "2026-07-11T17:00:00.000Z"
    );
    expect(result.credits).toBe(7_496);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/1/apps/limits.json");
  });
});
