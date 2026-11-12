import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUsage } from "../deepseek";

describe("deepseek balance adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("never labels a CNY-only balance as canonical USD", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            is_available: true,
            balance_infos: [
              {
                currency: "CNY",
                total_balance: "18.50",
                granted_balance: "2.00",
                topped_up_balance: "16.50",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
    );

    const result = await fetchUsage("key");

    expect(result.balance).toBeNull();
    expect(result.credits).toBeNull();
    expect(result.externalBilling?.records[0]).toMatchObject({
      planName: "CNY balance",
      remainingQuantity: 18.5,
      usageUnit: "CNY",
      rollupRole: "metadata",
    });
    expect(result.externalBilling?.records[0]).not.toHaveProperty("usageQuantity");
  });

  it("uses only the explicit USD entry for canonical balance", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            is_available: true,
            balance_infos: [
              { currency: "CNY", total_balance: "18.50", granted_balance: "2.00" },
              { currency: "USD", total_balance: "7.25", granted_balance: "1.25" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
    );

    const result = await fetchUsage("key");
    expect(result.balance).toBe(7.25);
    expect(result.credits).toBe(1.25);
    expect(result.externalBilling?.records).toHaveLength(2);
  });
});
