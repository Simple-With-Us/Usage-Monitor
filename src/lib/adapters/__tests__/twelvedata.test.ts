import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUsage } from "../twelvedata";

describe("twelve data adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the current body schema and keeps minute/day quotas separate", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          timestamp: "2026-07-13 12:34:56",
          current_usage: 4_003,
          plan_limit: 20_000,
          daily_usage: 12_500,
          plan_daily_limit: 100_000,
          plan_category: "enterprise",
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            // Conflicting legacy values prove the body is authoritative.
            "api-credits-used": "11",
            "api-credits-left": "599",
          },
        }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("key");

    expect(result.totalCost).toBeNull();
    expect(result.costScope).toBe("unknown");
    expect(result.totalRequests).toBe(12_500);
    expect(result.credits).toBe(87_500);
    expect(result.externalBilling?.records).toEqual([
      expect.objectContaining({
        externalId: "api-plan-minute-quota",
        planName: "enterprise",
        requestLimit: 20_000,
        requestLimitWindow: "minute",
        usageQuantity: 4_003,
        remainingQuantity: 15_997,
        usageUnit: "requests",
        rollupRole: "metadata",
      }),
      expect.objectContaining({
        externalId: "api-plan-daily-quota",
        planName: "enterprise",
        requestLimit: 100_000,
        requestLimitWindow: "day",
        usageQuantity: 12_500,
        remainingQuantity: 87_500,
        usageUnit: "requests",
        rollupRole: "metadata",
      }),
    ]);
    expect(result.rawData).toMatchObject({
      minuteQuota: { source: "response-body" },
      endpointCreditCost: 1,
      capabilities: { billingCost: false, pollConsumesCredits: true },
    });
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://api.twelvedata.com/api_usage"
    );
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("apikey key");
  });

  it("omits the daily quota when the plan has no daily limit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            current_usage: 7,
            plan_limit: 55,
            plan_category: "grow",
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
    );

    const result = await fetchUsage("key");

    expect(result.totalRequests).toBe(7);
    expect(result.credits).toBe(48);
    expect(result.externalBilling?.records).toHaveLength(1);
    expect(result.externalBilling?.records[0]?.externalId).toBe(
      "api-plan-minute-quota"
    );
  });

  it("falls back to the legacy credit headers only when body quotas are absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ status: "ok", plan: { name: "Pro" } }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "api-credits-used": "11",
            "api-credits-left": "599",
          },
        })
      )
    );

    const result = await fetchUsage("key");

    expect(result.totalRequests).toBe(11);
    expect(result.credits).toBe(599);
    expect(result.externalBilling?.records[0]).toMatchObject({
      planName: "Pro",
      requestLimit: 610,
      requestLimitWindow: "minute",
      usageQuantity: 11,
      remainingQuantity: 599,
      usageUnit: "credits",
    });
    expect(result.rawData).toMatchObject({
      minuteQuota: { source: "legacy-response-headers" },
    });
  });
});
