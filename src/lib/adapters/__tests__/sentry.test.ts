import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUsage } from "../sentry";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Sentry adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("aggregates event counts without mixing bytes or milliseconds", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json({
        start: "2026-06-11T00:00:00Z",
        end: "2026-07-11T00:00:00Z",
        groups: [
          { by: { category: "error" }, totals: { "sum(quantity)": 12 } },
          { by: { category: "transaction" }, totals: { "sum(quantity)": 8 } },
          { by: { category: "attachment" }, totals: { "sum(quantity)": 5_000_000 } },
          { by: { category: "profile_duration" }, totals: { "sum(quantity)": 90_000 } },
        ],
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("token", { orgSlug: "example" });

    expect(result.totalRequests).toBe(20);
    expect(result.requestUnit).toBe("events");
    expect(result.requestWindow).toBe("rolling_30_days");
    expect(new Date(result.requestWindowStart!).toISOString()).toBe(
      "2026-06-11T00:00:00.000Z"
    );
    expect(new Date(result.requestWindowEnd!).toISOString()).toBe(
      "2026-07-11T00:00:00.000Z"
    );
    expect(result.rawData).toMatchObject({
      categories: {
        error: { quantity: 12, unit: "events", included: true },
        attachment: { quantity: 5_000_000, unit: "bytes", included: false },
        profile_duration: { quantity: 90_000, unit: "milliseconds", included: false },
      },
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain("groupBy=category");
  });

  it("rejects a successful response without grouped category data", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({})));

    await expect(fetchUsage("token", { orgSlug: "example" })).rejects.toMatchObject({
      code: "HTTP_ERROR",
    });
  });
});
