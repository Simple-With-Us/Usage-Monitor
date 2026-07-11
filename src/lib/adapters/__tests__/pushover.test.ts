import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUsage } from "../pushover";

describe("pushover adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the official monthly message-limit endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ status: 1, limit: 10_000, remaining: 7_496, reset: 1_393_653_600 }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("app-token");

    expect(result.totalRequests).toBe(2_504);
    expect(result.credits).toBe(7_496);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/1/apps/limits.json");
  });
});
