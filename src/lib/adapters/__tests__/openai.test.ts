import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUsage } from "../openai";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("OpenAI usage adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps today's cost diagnostic-only when no MTD total is available", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(json({ data: [{ cost: 123, n_requests: 7 }] }))
        .mockResolvedValueOnce(json({}, 403))
        .mockResolvedValueOnce(json({}, 403))
        .mockResolvedValueOnce(json({}, 403))
    );

    const result = await fetchUsage("api-key");

    expect(result.totalCost).toBeNull();
    expect(result.totalRequests).toBe(7);
    expect(result.rawData).toMatchObject({ dailyCostUsd: 1.23 });
  });

  it("uses the range billing total instead of today's diagnostic cost", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(json({ data: [{ cost: 123, n_requests: 7 }] }))
        .mockResolvedValueOnce(json({ hard_limit_usd: 100 }))
        .mockResolvedValueOnce(json({}, 403))
        .mockResolvedValueOnce(json({ total_usage: 4567 }))
    );

    const result = await fetchUsage("api-key");

    expect(result.totalCost).toBe(45.67);
    expect(result.rawData).toMatchObject({ dailyCostUsd: 1.23 });
  });
});
