import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUsage } from "../apify";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("apify adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("combines usage cycle with plan price without retaining proxy credentials", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          json({
            data: {
              monthlyUsageCycle: { startAt: "2026-07-01", endAt: "2026-08-01" },
              limits: { maxMonthlyUsageUsd: 300 },
              current: { monthlyUsageUsd: 20 },
            },
          })
        )
        .mockResolvedValueOnce(
          json({
            data: {
              isPaying: true,
              proxy: { password: "must-not-persist" },
              plan: {
                id: "Personal",
                isEnabled: true,
                monthlyBasePriceUsd: 49,
                monthlyUsageCreditsUsd: 49,
              },
            },
          })
        )
    );

    const result = await fetchUsage("token");

    expect(result.totalCost).toBe(49);
    expect(result.balance).toBe(29);
    expect(result.externalBilling?.records[0]).toMatchObject({
      planName: "Personal",
      amountUsd: 49,
      spendLimitUsd: 300,
    });
    expect(JSON.stringify(result.rawData)).not.toContain("must-not-persist");
  });
});
