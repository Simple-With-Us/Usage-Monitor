import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUsage } from "../cloudflare";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("cloudflare adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads billing subscriptions and uses global-key auth correctly", async () => {
    const now = new Date();
    const currentPeriodStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
    ).toISOString();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ result: { totals: { requests: 10 } } }))
      .mockResolvedValueOnce(json({ result: { totals: { requests: 5 } } }))
      .mockResolvedValueOnce(
        json({
          result: [
            {
              id: "sub_1",
              currency: "USD",
              current_period_start: currentPeriodStart,
              current_period_end: new Date(now.getTime() + 86_400_000).toISOString(),
              frequency: "monthly",
              price: 5,
              rate_plan: { id: "pro", public_name: "Workers Paid" },
              state: "Paid",
            },
          ],
        })
      )
      .mockResolvedValueOnce(
        json({
          success: true,
          result: [
            {
              BillingCurrency: "USD",
              BillingPeriodStart: currentPeriodStart,
              ChargePeriodEnd: new Date(now.getTime() + 86_400_000).toISOString(),
              ContractedCost: 2,
              ConsumedQuantity: 100,
              ServiceName: "Workers Standard",
              ZoneName: "must-not-persist.example",
            },
          ],
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("global-key", {
      accountId: "account-id",
      accountEmail: "owner@example.com",
    });

    expect(result.totalCost).toBe(7);
    expect(result.totalRequests).toBe(15);
    const subscriptionSync = result.externalBillingSyncs?.find(
      (sync) => sync.source === "cloudflare-subscriptions"
    );
    expect(subscriptionSync?.records[0]).toMatchObject({
      externalId: "sub_1",
      kind: "subscription",
      planName: "Workers Paid",
      status: "paid",
      amountUsd: 5,
    });
    expect(JSON.stringify(result.rawData)).not.toContain("must-not-persist.example");
    const requestHeaders = fetchMock.mock.calls[2][1].headers;
    expect(requestHeaders["X-Auth-Key"]).toBe("global-key");
    expect(requestHeaders["X-Auth-Email"]).toBe("owner@example.com");
    expect(requestHeaders.Authorization).toBeUndefined();
  });
});
