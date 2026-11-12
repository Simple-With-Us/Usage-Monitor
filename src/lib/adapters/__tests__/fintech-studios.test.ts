import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUsage } from "../fintech_studios";

describe("FinTech Studios adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads the zero-credit account endpoint without retaining identity fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            id: "user-secret-id",
            email: "private@example.com",
            first_name: "Private",
            last_name: "Person",
            tier: "pro",
            credits: {
              balance: 1_750,
              monthly_allowance: 2_500,
              daily_burn_cap: 400,
              daily_burn_used: 125,
              reset_date: "2026-07-14T00:00:00Z",
            },
          },
          meta: {
            credits_used: 0,
            rate_limit: { limit: 1_000, remaining: 998, reset: 1_789_000_000 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("fts_live_key");

    expect(result.totalCost).toBeNull();
    expect(result.costScope).toBe("unknown");
    expect(result.totalRequests).toBeNull();
    expect(result.credits).toBe(1_750);
    expect(result.externalBilling).toMatchObject({
      source: "fintech-studios-account",
      authoritative: true,
    });
    expect(result.externalBilling?.records).toEqual([
      expect.objectContaining({
        externalId: "account-credit-balance",
        planName: "pro",
        remainingQuantity: 1_750,
        usageUnit: "credits",
      }),
      expect.objectContaining({
        externalId: "monthly-credit-allowance",
        requestLimit: 2_500,
        requestLimitWindow: "month",
        usageUnit: "credits",
      }),
      expect.objectContaining({
        externalId: "daily-credit-cap",
        requestLimit: 400,
        requestLimitWindow: "day",
        usageQuantity: 125,
        remainingQuantity: 275,
        currentPeriodEnd: "2026-07-14T00:00:00.000Z",
        dateKind: "quota_reset",
      }),
    ]);
    expect(result.rawData).toMatchObject({
      tier: "pro",
      creditBalance: 1_750,
      monthlyCreditAllowance: 2_500,
      dailyCreditCap: 400,
      dailyCreditsUsed: 125,
      dailyCreditsRemaining: 275,
      capabilities: { zeroCreditAccountRead: true, billingCost: false },
    });
    expect(JSON.stringify(result.rawData)).not.toContain("private@example.com");
    expect(JSON.stringify(result.rawData)).not.toContain("user-secret-id");
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://studio.fintechstudios.com/api/v1/me"
    );
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(
      "Bearer fts_live_key"
    );
  });

  it("does not call the undocumented-shape usage endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { tier: "free" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("fts_test_key");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/v1/me");
    expect(String(fetchMock.mock.calls[0][0])).not.toContain("/api/v1/usage");
    expect(result.externalBilling?.records).toEqual([
      expect.objectContaining({
        externalId: "account-plan",
        planName: "free",
      }),
    ]);
  });

  it("fails closed when the account envelope is absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ meta: { credits_used: 0 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      )
    );

    await expect(fetchUsage("key")).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it.each([
    { data: {} },
    { data: [] },
    { data: { tier: "pro", credits: [] } },
    { data: { tier: "pro", credits: { balance: "not-a-number" } } },
  ])(
    "fails closed instead of authoritatively pruning state for an unrecognized account payload",
    async (body) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        )
      );

      await expect(fetchUsage("key")).rejects.toMatchObject({
        code: "INVALID_RESPONSE",
      });
    }
  );
});
