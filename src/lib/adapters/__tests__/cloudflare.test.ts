import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUsage } from "../cloudflare";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("cloudflare adapter", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reads billing subscriptions and uses global-key auth correctly", async () => {
    const now = new Date();
    const currentPeriodStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
    ).toISOString();
    const priorBillingPeriodStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15)
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
          result_info: { count: 1, page: 1, per_page: 50, total_count: 1 },
        })
      )
      .mockResolvedValueOnce(
        json({
          success: true,
          result: [
            {
              BillingCurrency: "USD",
              BillingPeriodStart: priorBillingPeriodStart,
              ChargePeriodStart: currentPeriodStart,
              ChargePeriodEnd: new Date(now.getTime() + 86_400_000).toISOString(),
              ContractedCost: 2,
              ConsumedQuantity: 100,
              ServiceName: "Workers Standard",
              ZoneName: "must-not-persist.example",
            },
            {
              BillingCurrency: "USD",
              BillingPeriodStart: currentPeriodStart,
              ChargePeriodStart: priorBillingPeriodStart,
              ChargePeriodEnd: currentPeriodStart,
              ContractedCost: 100,
              ConsumedQuantity: 1,
              ServiceName: "Prior-month charge",
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
    expect(result.fixedCostIncludedUsd).toBe(5);
    // Account analytics is the broader total; Workers analytics is a fallback,
    // not an additive second count of overlapping requests.
    expect(result.totalRequests).toBe(10);
    const subscriptionSync = result.externalBillingSyncs?.find(
      (sync) => sync.source === "cloudflare-subscriptions"
    );
    expect(subscriptionSync?.records[0]).toMatchObject({
      externalId: "sub_1",
      kind: "subscription",
      planName: "Workers Paid",
      status: "paid",
      amountUsd: 5,
      paidRecurringAuthoritative: true,
    });
    expect(JSON.stringify(result.rawData)).not.toContain("must-not-persist.example");
    const requestHeaders = fetchMock.mock.calls[2][1].headers;
    expect(requestHeaders["X-Auth-Key"]).toBe("global-key");
    expect(requestHeaders["X-Auth-Email"]).toBe("owner@example.com");
    expect(requestHeaders.Authorization).toBeUndefined();
    const paygoUrl = new URL(String(fetchMock.mock.calls[3][0]));
    expect(paygoUrl.searchParams.get("from")).toBe(
      currentPeriodStart.slice(0, 10)
    );
    expect(paygoUrl.searchParams.get("to")).toBe(now.toISOString().slice(0, 10));
    const paygoSync = result.externalBillingSyncs?.find(
      (sync) => sync.source === "cloudflare-paygo-usage"
    );
    expect(paygoSync?.records[0]).toMatchObject({
      amountUsd: 2,
      currentPeriodStart,
    });
  });

  it("uses a current paid billing term when Cloudflare reports an inconsistent Expired state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T12:00:00.000Z"));
    const currentPeriodStart = "2026-07-16T19:02:36.000Z";
    const currentPeriodEnd = "2026-08-16T00:00:00.000Z";
    const priorPeriodStart = "2026-06-16T19:02:36.000Z";
    const priorPeriodEnd = "2026-07-16T00:00:00.000Z";
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(json({ result: { totals: { requests: 10 } } }))
        .mockResolvedValueOnce(json({}, 403))
        .mockResolvedValueOnce(
          json({
            result: [
              {
                id: "paid-current",
                currency: "USD",
                current_period_start: currentPeriodStart,
                current_period_end: currentPeriodEnd,
                frequency: "monthly",
                price: 5,
                rate_plan: {
                  id: "workers-secondary",
                  public_name: "Workers Paid Secondary",
                },
                state: "Paid",
              },
              {
                id: "expired-current",
                currency: "USD",
                current_period_start: currentPeriodStart,
                current_period_end: currentPeriodEnd,
                frequency: "monthly",
                price: 5,
                rate_plan: { id: "workers", public_name: "Workers Paid" },
                state: "Expired",
              },
              {
                id: "expired-prior",
                currency: "USD",
                current_period_start: priorPeriodStart,
                current_period_end: priorPeriodEnd,
                frequency: "monthly",
                price: 5,
                rate_plan: { public_name: "Workers Paid" },
                state: "Expired",
              },
              {
                id: "cancelled-current",
                currency: "USD",
                current_period_start: currentPeriodStart,
                current_period_end: currentPeriodEnd,
                frequency: "monthly",
                price: 5,
                rate_plan: { public_name: "Workers Paid" },
                state: "Cancelled",
              },
            ],
            result_info: { count: 4, page: 1, per_page: 50, total_count: 4 },
          })
        )
        .mockResolvedValueOnce(json({}, 403))
    );

    const result = await fetchUsage("token", {
      accountId: "account-id",
      authMode: "api_token",
    });
    const records = result.externalBillingSyncs?.find(
      (sync) => sync.source === "cloudflare-subscriptions"
    )?.records;

    expect(result.totalCost).toBe(10);
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ externalId: "paid-current", status: "paid", rollupRole: "canonical" }),
        expect.objectContaining({ externalId: "expired-current", status: "paid", rollupRole: "canonical" }),
        expect.objectContaining({ externalId: "expired-prior", status: "expired", rollupRole: "metadata" }),
        expect.objectContaining({ externalId: "cancelled-current", status: "cancelled", rollupRole: "metadata" }),
      ])
    );
  });

  it("preserves equivalent Paid and Expired identities while charging their exact term once", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T12:00:00.000Z"));
    const currentPeriodStart = "2026-07-16T19:02:36.000Z";
    const currentPeriodEnd = "2026-08-16T00:00:00.000Z";
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(json({ result: { totals: { requests: 10 } } }))
        .mockResolvedValueOnce(json({}, 403))
        .mockResolvedValueOnce(
          json({
            result: [
              {
                id: "real-paid-term",
                currency: "USD",
                current_period_start: currentPeriodStart,
                current_period_end: currentPeriodEnd,
                frequency: "monthly",
                price: 5,
                rate_plan: { id: "workers", public_name: "Workers Paid" },
                state: "Paid",
              },
              {
                id: "duplicate-expired-term",
                currency: "USD",
                current_period_start: currentPeriodStart,
                current_period_end: currentPeriodEnd,
                frequency: "monthly",
                price: 5,
                rate_plan: { id: "workers", public_name: "Workers Paid" },
                state: "Expired",
              },
            ],
            result_info: { count: 2, page: 1, per_page: 50, total_count: 2 },
          })
        )
        .mockResolvedValueOnce(json({}, 403))
    );

    const result = await fetchUsage("token", {
      accountId: "account-id",
      authMode: "api_token",
    });
    const records = result.externalBillingSyncs?.find(
      (sync) => sync.source === "cloudflare-subscriptions"
    )?.records;

    expect(result.totalCost).toBe(5);
    expect(result.fixedCostIncludedUsd).toBe(5);
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          externalId: "real-paid-term",
          status: "paid",
          paidRecurringAuthoritative: true,
          rollupRole: "canonical",
        }),
        expect.objectContaining({
          externalId: "duplicate-expired-term",
          status: "paid",
          paidRecurringAuthoritative: true,
          rollupRole: "canonical",
          nextRenewalAt: currentPeriodEnd,
        }),
      ])
    );
  });

  it("keeps distinct raw Paid identities additive even when their term shapes match", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T12:00:00.000Z"));
    const currentPeriodStart = "2026-07-16T19:02:36.000Z";
    const currentPeriodEnd = "2026-08-16T00:00:00.000Z";
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(json({ result: { totals: { requests: 10 } } }))
        .mockResolvedValueOnce(json({}, 403))
        .mockResolvedValueOnce(
          json({
            result: ["paid-a", "paid-b"].map((id) => ({
              id,
              currency: "USD",
              current_period_start: currentPeriodStart,
              current_period_end: currentPeriodEnd,
              frequency: "monthly",
              price: 5,
              rate_plan: { id: "workers", public_name: "Workers Paid" },
              state: "Paid",
            })),
            result_info: { count: 2, page: 1, per_page: 50, total_count: 2 },
          })
        )
        .mockResolvedValueOnce(json({}, 403))
    );

    const result = await fetchUsage("token", {
      accountId: "account-id",
      authMode: "api_token",
    });

    expect(result.totalCost).toBe(10);
    expect(result.fixedCostIncludedUsd).toBe(10);
    expect(
      result.externalBillingSyncs?.find(
        (sync) => sync.source === "cloudflare-subscriptions"
      )?.records
    ).toEqual([
      expect.objectContaining({
        externalId: "paid-a",
        paidRecurringAuthoritative: true,
        rollupRole: "canonical",
      }),
      expect.objectContaining({
        externalId: "paid-b",
        paidRecurringAuthoritative: true,
        rollupRole: "canonical",
      }),
    ]);
  });

  it("keeps an Expired term terminal when subscription fetching crosses current_period_end", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T11:59:59.999Z"));
    const currentPeriodStart = "2026-06-17T12:00:00.000Z";
    const currentPeriodEnd = "2026-07-17T12:00:00.000Z";
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(json({ result: { totals: { requests: 10 } } }))
        .mockResolvedValueOnce(json({}, 403))
        .mockImplementationOnce(async () => {
          vi.setSystemTime(new Date(currentPeriodEnd));
          return json({
            result: [
              {
                id: "expired-at-boundary",
                currency: "USD",
                current_period_start: currentPeriodStart,
                current_period_end: currentPeriodEnd,
                frequency: "monthly",
                price: 5,
                rate_plan: { public_name: "Workers Paid" },
                state: "Expired",
              },
            ],
            result_info: { count: 1, page: 1, per_page: 50, total_count: 1 },
          });
        })
        .mockResolvedValueOnce(json({}, 403))
    );

    const result = await fetchUsage("token", {
      accountId: "account-id",
      authMode: "api_token",
    });
    const record = result.externalBillingSyncs?.find(
      (sync) => sync.source === "cloudflare-subscriptions"
    )?.records[0];

    expect(result.totalCost).toBeNull();
    expect(result.fixedCostIncludedUsd).toBeNull();
    expect(record).toMatchObject({
      externalId: "expired-at-boundary",
      status: "expired",
      paidRecurringAuthoritative: false,
      rollupRole: "metadata",
      nextRenewalAt: null,
    });
  });

  it("uses one new-month accounting window when subscription fetching crosses UTC month end", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T23:59:59.999Z"));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ result: { totals: { requests: 10 } } }))
      .mockResolvedValueOnce(json({}, 403))
      .mockImplementationOnce(async () => {
        vi.setSystemTime(new Date("2026-08-01T00:00:00.000Z"));
        return json({
          result: [
            {
              id: "august-workers-paid",
              currency: "USD",
              current_period_start: "2026-08-01T00:00:00.000Z",
              current_period_end: "2026-09-01T00:00:00.000Z",
              frequency: "monthly",
              price: 5,
              rate_plan: { public_name: "Workers Paid" },
              state: "Expired",
            },
          ],
          result_info: { count: 1, page: 1, per_page: 50, total_count: 1 },
        });
      })
      .mockResolvedValueOnce(
        json({
          success: true,
          result: [
            {
              BillingCurrency: "USD",
              ChargePeriodStart: "2026-07-31T23:00:00.000Z",
              ChargePeriodEnd: "2026-08-01T00:00:00.000Z",
              ContractedCost: 100,
              ConsumedQuantity: 100,
              ServiceName: "Prior-month usage",
            },
            {
              BillingCurrency: "USD",
              ChargePeriodStart: "2026-08-01T00:00:00.000Z",
              ChargePeriodEnd: "2026-08-01T01:00:00.000Z",
              ContractedCost: 2,
              ConsumedQuantity: 2,
              ServiceName: "Current-month usage",
            },
          ],
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("token", {
      accountId: "account-id",
      authMode: "api_token",
    });

    const paygoUrl = new URL(String(fetchMock.mock.calls[3][0]));
    expect(paygoUrl.searchParams.get("from")).toBe("2026-08-01");
    expect(paygoUrl.searchParams.get("to")).toBe("2026-08-01");
    expect(result.totalCost).toBe(7);
    expect(result.fixedCostIncludedUsd).toBe(5);
    expect(new Date(result.costWindowStart!).toISOString()).toBe(
      "2026-08-01T00:00:00.000Z"
    );
    expect(new Date(result.costWindowEnd!).toISOString()).toBe(
      "2026-08-01T00:00:00.000Z"
    );
    expect(result.rawData).toMatchObject({
      billing: { fixedSubscriptionBilledThisMonthUsd: 5 },
      paygoBilling: {
        currentPeriodCostUsd: 2,
        recordCount: 1,
        excludedOutOfPeriodRecords: 1,
      },
    });
    expect(JSON.stringify(result.externalBillingSyncs)).not.toContain(
      "Prior-month usage"
    );
    expect(
      result.externalBillingSyncs
        ?.find((sync) => sync.source === "cloudflare-subscriptions")
        ?.records[0]
    ).toMatchObject({
      externalId: "august-workers-paid",
      status: "paid",
      paidRecurringAuthoritative: true,
      rollupRole: "canonical",
    });
  });

  it("uses explicit API-token auth even when a legacy account email remains", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ result: { totals: { requests: 10 } } }))
      .mockResolvedValueOnce(json({}, 403))
      .mockResolvedValueOnce(
        json({
          result: [],
          result_info: { count: 0, page: 1, per_page: 50, total_count: 0 },
        })
      )
      .mockResolvedValueOnce(json({}, 403));
    vi.stubGlobal("fetch", fetchMock);

    await fetchUsage("scoped-token", {
      accountId: "account-id",
      accountEmail: "legacy@example.com",
      authMode: "api_token",
    });

    for (const [, request] of fetchMock.mock.calls) {
      expect(request.headers.Authorization).toBe("Bearer scoped-token");
      expect(request.headers["X-Auth-Key"]).toBeUndefined();
      expect(request.headers["X-Auth-Email"]).toBeUndefined();
    }
  });

  it("requires an account email only for explicit Global API key auth", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchUsage("global-key", {
        accountId: "account-id",
        authMode: "global_key",
      })
    ).rejects.toMatchObject({ code: "CONFIGURATION_ERROR" });
    await expect(
      fetchUsage("token", {
        accountId: "account-id",
        authMode: "unsupported",
      })
    ).rejects.toMatchObject({ code: "CONFIGURATION_ERROR" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to Workers requests when account analytics is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(json({}, 403))
        .mockResolvedValueOnce(json({ result: { totals: { requests: 7 } } }))
        .mockResolvedValueOnce(json({}, 403))
        .mockResolvedValueOnce(json({}, 403))
    );

    const result = await fetchUsage("token", { accountId: "account-id" });

    expect(result.totalRequests).toBe(7);
  });

  it("preserves PayGo currency and keeps different service units separate", async () => {
    const now = new Date();
    const periodStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
    ).toISOString();
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(json({}, 403))
        .mockResolvedValueOnce(json({}, 403))
        .mockResolvedValueOnce(
          json({
            result: [],
            result_info: { count: 0, page: 1, per_page: 50, total_count: 0 },
          })
        )
        .mockResolvedValueOnce(
          json({
            result: [
              {
                BillingCurrency: "EUR",
                BillingPeriodStart: periodStart,
                ChargePeriodStart: periodStart,
                ChargePeriodEnd: now.toISOString(),
                ContractedCost: 2,
                ConsumedQuantity: 10,
                ConsumedUnit: "requests",
                ServiceName: "Workers",
              },
              {
                BillingCurrency: "EUR",
                BillingPeriodStart: periodStart,
                ChargePeriodStart: periodStart,
                ChargePeriodEnd: now.toISOString(),
                ContractedCost: 3,
                ConsumedQuantity: 20,
                ConsumedUnit: "GB",
                ServiceName: "Workers",
              },
            ],
          })
        )
    );

    const result = await fetchUsage("token", { accountId: "account-id" });
    const sync = result.externalBillingSyncs?.find(
      (candidate) => candidate.source === "cloudflare-paygo-usage"
    );

    expect(result.totalCost).toBeNull();
    expect(sync?.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          serviceName: "Cloudflare PayGo",
          amountUsd: 5,
          currency: "EUR",
          rollupRole: "canonical",
        }),
        expect.objectContaining({
          serviceName: "Workers",
          usageQuantity: 10,
          usageUnit: "requests",
          currency: "EUR",
          rollupRole: "component",
        }),
        expect.objectContaining({
          serviceName: "Workers",
          usageQuantity: 20,
          usageUnit: "GB",
          currency: "EUR",
          rollupRole: "component",
        }),
      ])
    );
  });

  it("does not assume a missing subscription currency is USD", async () => {
    const now = new Date();
    const periodStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
    ).toISOString();
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(json({}, 403))
        .mockResolvedValueOnce(json({}, 403))
        .mockResolvedValueOnce(
          json({
            result: [{
              id: "sub-no-currency",
              price: 5,
              state: "Paid",
              current_period_start: periodStart,
              rate_plan: { public_name: "Workers Paid" },
            }],
            result_info: { count: 1, page: 1, per_page: 50, total_count: 1 },
          })
        )
        .mockResolvedValueOnce(json({ result: [] }))
    );

    const result = await fetchUsage("token", { accountId: "account-id" });
    const subscription = result.externalBillingSyncs
      ?.find((candidate) => candidate.source === "cloudflare-subscriptions")
      ?.records[0];

    expect(result.totalCost).toBeNull();
    expect(subscription).toMatchObject({
      planName: "Workers Paid",
      amountUsd: null,
      currency: null,
    });
  });

  it("keeps free plans as sanitized entitlement metadata, not paid services", async () => {
    const now = new Date();
    const periodStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
    ).toISOString();
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(json({ result: { totals: { requests: 10 } } }))
        .mockResolvedValueOnce(json({}, 403))
        .mockResolvedValueOnce(
          json({
            result: [
              {
                id: "free-zone-plan",
                currency: "USD",
                price: 0,
                state: "Paid",
                frequency: "monthly",
                current_period_start: periodStart,
                current_period_end: now.toISOString(),
                zone_name: "private-zone.example",
                rate_plan: {
                  id: "free",
                  public_name: "Free Website",
                  scope: "zone",
                  sets: ["sensitive-entitlement-set"],
                },
                components: [{ name: "private-component" }],
              },
              {
                id: "paid-workers-plan",
                currency: "USD",
                price: 5,
                state: "Paid",
                frequency: "monthly",
                current_period_start: periodStart,
                current_period_end: now.toISOString(),
                rate_plan: { id: "workers", public_name: "Workers Paid" },
              },
              {
                id: "unpriced-contract",
                currency: "USD",
                state: "Provisioned",
                frequency: "yearly",
                current_period_start: periodStart,
                current_period_end: now.toISOString(),
                rate_plan: { id: "enterprise", public_name: "Enterprise Contract" },
              },
              {
                id: "trial-zone-plan",
                currency: "USD",
                price: 20,
                state: "Trial",
                frequency: "monthly",
                current_period_start: periodStart,
                current_period_end: now.toISOString(),
                rate_plan: { id: "pro", public_name: "Pro Trial" },
              },
              {
                id: "awaiting-payment-plan",
                currency: "USD",
                price: 20,
                state: "AwaitingPayment",
                frequency: "monthly",
                current_period_start: periodStart,
                current_period_end: now.toISOString(),
                rate_plan: { id: "business", public_name: "Business Pending" },
              },
            ],
            result_info: { count: 5, page: 1, per_page: 50, total_count: 5 },
          })
        )
        .mockResolvedValueOnce(json({}, 403))
    );

    const result = await fetchUsage("token", {
      accountId: "account-id",
      authMode: "api_token",
    });
    const sync = result.externalBillingSyncs?.find(
      (candidate) => candidate.source === "cloudflare-subscriptions"
    );

    expect(result.totalCost).toBe(5);
    expect(sync?.records.map((record) => record.externalId)).toEqual([
      "paid-workers-plan",
      "unpriced-contract",
      "trial-zone-plan",
      "awaiting-payment-plan",
    ]);
    expect(sync?.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          externalId: "paid-workers-plan",
          serviceName: "Workers Paid",
          planName: "Workers Paid",
          amountUsd: 5,
          rollupRole: "canonical",
        }),
        expect.objectContaining({
          externalId: "unpriced-contract",
          serviceName: "Enterprise Contract",
          planName: "Enterprise Contract",
          amountUsd: null,
          rollupRole: "metadata",
          nextRenewalAt: null,
        }),
        expect.objectContaining({
          externalId: "trial-zone-plan",
          amountUsd: 20,
          status: "trial",
          rollupRole: "metadata",
          nextRenewalAt: null,
        }),
        expect.objectContaining({
          externalId: "awaiting-payment-plan",
          amountUsd: 20,
          status: "awaitingpayment",
          rollupRole: "metadata",
          nextRenewalAt: null,
        }),
      ])
    );
    expect(result.rawData).toMatchObject({
      subscriptions: [
        {
          id: "free-zone-plan",
          planId: "free",
          planName: "Free Website",
          price: 0,
        },
        {
          id: "paid-workers-plan",
          planId: "workers",
          planName: "Workers Paid",
          price: 5,
        },
        {
          id: "unpriced-contract",
          planId: "enterprise",
          planName: "Enterprise Contract",
          price: null,
        },
        {
          id: "trial-zone-plan",
          planId: "pro",
          planName: "Pro Trial",
          price: 20,
        },
        {
          id: "awaiting-payment-plan",
          planId: "business",
          planName: "Business Pending",
          price: 20,
        },
      ],
      billing: {
        subscriptionCount: 5,
        paidOrUnpricedSubscriptionCount: 4,
        freeOrBaseEntitlementCount: 1,
      },
    });
    expect(JSON.stringify(result.rawData)).not.toContain("private-zone.example");
    expect(JSON.stringify(result.rawData)).not.toContain("sensitive-entitlement-set");
    expect(JSON.stringify(result.rawData)).not.toContain("private-component");
  });

  it("exposes a recurring plan without claiming its prior-period price as current-month spend", async () => {
    const now = new Date();
    const priorPeriodStart = new Date(
      Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), 1)
    ).toISOString();
    const nextRenewal = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)
    ).toISOString();
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(json({ result: { totals: { requests: 10 } } }))
        .mockResolvedValueOnce(json({}, 403))
        .mockResolvedValueOnce(
          json({
            result: [
              {
                id: "annual-plan",
                currency: "USD",
                price: 120,
                state: "Paid",
                frequency: "yearly",
                current_period_start: priorPeriodStart,
                current_period_end: nextRenewal,
                rate_plan: { public_name: "Annual Enterprise" },
              },
            ],
            result_info: { count: 1, page: 1, per_page: 50, total_count: 1 },
          })
        )
        .mockResolvedValueOnce(json({}, 403))
    );

    const result = await fetchUsage("token", { accountId: "account-id" });
    const subscription = result.externalBillingSyncs
      ?.find((candidate) => candidate.source === "cloudflare-subscriptions")
      ?.records[0];

    expect(result.totalCost).toBeNull();
    expect(result.fixedCostIncludedUsd).toBeNull();
    expect(result.costScope).toBe("unknown");
    expect(subscription).toMatchObject({
      amountUsd: 120,
      billingInterval: "yearly",
      currentPeriodStart: priorPeriodStart,
      nextRenewalAt: nextRenewal,
    });
  });

  it("soft-fails PayGo error 10000 after another Cloudflare capability succeeds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(json({ result: { totals: { requests: 10 } } }))
        .mockResolvedValueOnce(json({}, 403))
        .mockResolvedValueOnce(
          json({
            result: [],
            result_info: { count: 0, page: 1, per_page: 50, total_count: 0 },
          })
        )
        .mockResolvedValueOnce(
          json(
            {
              success: false,
              errors: [{ code: 10000, message: "Authentication error" }],
            },
            403
          )
        )
    );

    const result = await fetchUsage("token", { accountId: "account-id" });

    expect(result.totalRequests).toBe(10);
    expect(result.rawData).toMatchObject({
      paygoBillingCapability: {
        available: false,
        status: 403,
        code: 10000,
      },
    });
    expect(JSON.stringify(result.rawData)).not.toContain("Authentication error");
    expect(
      result.externalBillingSyncs?.some(
        (candidate) => candidate.source === "cloudflare-paygo-usage"
      )
    ).toBe(false);
  });

  it("fetches every subscription page before authoritative reconciliation", async () => {
    const now = new Date();
    const currentPeriodStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
    ).toISOString();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({}, 403))
      .mockResolvedValueOnce(json({}, 403))
      .mockResolvedValueOnce(
        json({
          result: [{ id: "sub_1", currency: "USD", price: 2, state: "Paid", current_period_start: currentPeriodStart }],
          result_info: { count: 1, page: 1, per_page: 1, total_count: 2 },
        })
      )
      .mockResolvedValueOnce(
        json({
          result: [{ id: "sub_2", currency: "USD", price: 3, state: "Paid", current_period_start: currentPeriodStart }],
          result_info: { count: 1, page: 2, per_page: 1, total_count: 2 },
        })
      )
      .mockResolvedValueOnce(json({}, 403));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("token", { accountId: "account-id" });
    const sync = result.externalBillingSyncs?.find(
      (candidate) => candidate.source === "cloudflare-subscriptions"
    );

    expect(result.totalCost).toBe(5);
    expect(sync?.records.map((record) => record.externalId)).toEqual([
      "sub_1",
      "sub_2",
    ]);
    expect(String(fetchMock.mock.calls[3][0])).toContain("page=2");
  });

  it("rejects incomplete pagination metadata before booking or reconciliation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(json({ result: { totals: { requests: 10 } } }))
        .mockResolvedValueOnce(json({ result: { totals: { requests: 5 } } }))
        .mockResolvedValueOnce(
          json({
            result: [{ id: "sub_1" }],
            result_info: { count: 1, page: 1, per_page: 1, total_count: 2 },
          })
        )
        .mockResolvedValueOnce(json({ result: [{ id: "sub_2" }] }))
    );

    await expect(
      fetchUsage("token", { accountId: "account-id" })
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("flags a cost coverage caveat when PayGo is unavailable but a subscription cost is known", async () => {
    const now = new Date();
    const periodStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
    ).toISOString();
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(json({ result: { totals: { requests: 10 } } }))
        .mockResolvedValueOnce(json({}, 403))
        .mockResolvedValueOnce(
          json({
            result: [
              {
                id: "sub_1",
                currency: "USD",
                current_period_start: periodStart,
                current_period_end: new Date(now.getTime() + 86_400_000).toISOString(),
                frequency: "monthly",
                price: 5,
                rate_plan: { public_name: "Workers Paid" },
                state: "Paid",
              },
            ],
            result_info: { count: 1, page: 1, per_page: 50, total_count: 1 },
          })
        )
        .mockResolvedValueOnce(json({}, 403))
    );

    const result = await fetchUsage("token", { accountId: "account-id" });

    expect(result.totalCost).toBe(5);
    expect(result.costCoverageCaveat).toEqual({
      code: "cloudflare_paygo_usage_unavailable",
      message:
        "Usage-based costs (D1, R2, Workers, Queues overage) are not visible for this account — only the fixed subscription fee is shown. Cost may be understated.",
    });
  });

  it("does not flag a cost coverage caveat when PayGo succeeds, even with zero usage", async () => {
    const now = new Date();
    const periodStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
    ).toISOString();
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(json({ result: { totals: { requests: 10 } } }))
        .mockResolvedValueOnce(json({}, 403))
        .mockResolvedValueOnce(
          json({
            result: [
              {
                id: "sub_1",
                currency: "USD",
                current_period_start: periodStart,
                current_period_end: new Date(now.getTime() + 86_400_000).toISOString(),
                frequency: "monthly",
                price: 5,
                rate_plan: { public_name: "Workers Paid" },
                state: "Paid",
              },
            ],
            result_info: { count: 1, page: 1, per_page: 50, total_count: 1 },
          })
        )
        .mockResolvedValueOnce(json({ result: [] }))
    );

    const result = await fetchUsage("token", { accountId: "account-id" });

    expect(result.totalCost).toBe(5);
    expect(result.costCoverageCaveat).toBeNull();
  });

  it("does not flag a cost coverage caveat when there is no subscription cost either", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(json({ result: { totals: { requests: 10 } } }))
        .mockResolvedValueOnce(json({}, 403))
        .mockResolvedValueOnce(
          json({
            result: [],
            result_info: { count: 0, page: 1, per_page: 50, total_count: 0 },
          })
        )
        .mockResolvedValueOnce(json({}, 403))
    );

    const result = await fetchUsage("token", { accountId: "account-id" });

    expect(result.totalCost).toBeNull();
    expect(result.costCoverageCaveat).toBeNull();
  });

  it("rejects a successful response that omits the subscription result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(json({ result: { totals: { requests: 10 } } }))
        .mockResolvedValueOnce(json({ result: { totals: { requests: 5 } } }))
        .mockResolvedValueOnce(
          json({
            result_info: { count: 0, page: 1, per_page: 50, total_count: 0 },
          })
        )
    );

    await expect(
      fetchUsage("token", { accountId: "account-id" })
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});
