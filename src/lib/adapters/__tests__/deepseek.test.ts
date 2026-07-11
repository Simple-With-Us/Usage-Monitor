import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUsage } from "../deepseek";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("DeepSeek adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("normalizes only explicitly USD-denominated balances", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json({
          is_available: true,
          balance_infos: [
            {
              currency: "CNY",
              total_balance: "100.00",
              granted_balance: "20.00",
            },
          ],
        })
      )
    );

    const result = await fetchUsage("key");

    expect(result.balance).toBeNull();
    expect(result.credits).toBeNull();
    expect(result.rawData).toMatchObject({
      currencies: [{ currency: "CNY", normalizedAsUsd: false }],
    });
  });
});
