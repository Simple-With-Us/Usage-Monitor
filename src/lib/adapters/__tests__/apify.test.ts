import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchUsage } from "../apify";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// The adapter only budgets a usage cycle whose start falls inside the current
// real UTC month, so cycle fixtures must be derived from the current date
// rather than pinned to a fixed month.
function utcMonthCycle(monthOffset = 0): { startAt: string; endAt: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthOffset, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthOffset + 1, 1));
  return {
    startAt: start.toISOString().slice(0, 10),
    endAt: end.toISOString().slice(0, 10),
  };
}

describe("apify adapter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T12:00:00Z"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("combines usage cycle with plan price without retaining proxy credentials", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          json({
            data: {
              monthlyUsageCycle: utcMonthCycle(),
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
    expect(result.fixedCostIncludedUsd).toBe(49);
    expect(result.balance).toBe(29);
    expect(result.externalBilling?.records[0]).toMatchObject({
      planName: "Personal",
      amountUsd: 49,
      spendLimitUsd: 300,
      paidRecurringAuthoritative: true,
    });
    expect(JSON.stringify(result.rawData)).not.toContain("must-not-persist");
  });

  it("adds only usage above included credits to the base plan price", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(
          json({
            data: {
              monthlyUsageCycle: utcMonthCycle(),
              current: { monthlyUsageUsd: 15 },
            },
          })
        )
        .mockResolvedValueOnce(
          json({
            data: {
              plan: {
                id: "Starter",
                monthlyBasePriceUsd: 20,
                monthlyUsageCreditsUsd: 10,
              },
            },
          })
        )
    );

    const result = await fetchUsage("token");

    expect(result.totalCost).toBe(25);
    expect(result.balance).toBe(0);
    expect(
      result.externalBilling?.records[0].paidRecurringAuthoritative
    ).toBe(false);
  });

  it("keeps an out-of-month billing cycle display-only", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(
          json({
            data: {
              monthlyUsageCycle: utcMonthCycle(-1),
              current: { monthlyUsageUsd: 15 },
            },
          })
        )
        .mockResolvedValueOnce(
          json({ data: { plan: { id: "Starter", monthlyBasePriceUsd: 20, monthlyUsageCreditsUsd: 10 } } })
        )
    );

    const result = await fetchUsage("token");
    expect(result.totalCost).toBeNull();
    expect(result.rawData).toMatchObject({
      billing: { estimatedCurrentBillUsd: 25, includedInCurrentMonthBudget: false },
    });
    expect(
      result.externalBilling?.records[0].paidRecurringAuthoritative
    ).toBe(false);
  });

  it.each([false, null])(
    "does not attest a paid recurring charge when isPaying is %s",
    async (isPaying) => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(
            json({
              data: {
                monthlyUsageCycle: {
                  startAt: "2026-07-01",
                  endAt: "2026-08-01",
                },
              },
            })
          )
          .mockResolvedValueOnce(
            json({
              data: {
                isPaying,
                plan: {
                  id: "Personal",
                  isEnabled: true,
                  monthlyBasePriceUsd: 49,
                },
              },
            })
          )
      );

      const result = await fetchUsage("token");

      expect(
        result.externalBilling?.records[0].paidRecurringAuthoritative
      ).toBe(false);
    }
  );
});
