import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUsage } from "../twilio";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("twilio adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads month-to-date total price from official Usage Records", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ balance: "42.50", currency: "USD" }))
      .mockResolvedValueOnce(
        json({
          usage_records: [
            {
              category: "totalprice",
              price: "12.34",
              price_unit: "usd",
              start_date: "2026-07-01",
              end_date: "2026-07-11",
            },
          ],
        })
      )
      .mockResolvedValueOnce(
        json({
          usage_records: [
            {
              category: "sms",
              count: "25",
              count_unit: "messages",
              price: "0.50",
              price_unit: "usd",
              start_date: "2026-07-01",
              end_date: "2026-07-11",
            },
          ],
          next_page_uri: null,
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("auth-token", { accountId: "AC123" });

    expect(result.balance).toBe(42.5);
    expect(result.totalCost).toBe(12.34);
    expect(String(fetchMock.mock.calls[1][0])).toContain(
      "/Usage/Records/ThisMonth.json?Category=totalprice"
    );
    expect(result.externalBilling?.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rollupRole: "canonical", amountUsd: 12.34 }),
        expect.objectContaining({ serviceName: "sms", usageQuantity: 25, rollupRole: "component" }),
      ])
    );
    expect(result.externalBilling).toMatchObject({ authoritative: true });
    expect(result.externalBilling?.records[0].dateKind).toBe("report_through");
  });

  it("uses a restricted API Key SID as username while keeping Account SID in the URL", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ balance: "42.50", currency: "USD" }))
      .mockResolvedValueOnce(json({ usage_records: [] }))
      .mockResolvedValueOnce(json({ usage_records: [], next_page_uri: null }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchUsage("restricted-secret", {
      accountId: "AC123",
      apiKeySid: "SK123",
    });

    expect(String(fetchMock.mock.calls[0][0])).toContain("/Accounts/AC123/");
    const authorization = fetchMock.mock.calls[0][1].headers.Authorization;
    expect(Buffer.from(authorization.slice("Basic ".length), "base64").toString()).toBe(
      "SK123:restricted-secret"
    );
  });

  it("does not assume missing price currency and preserves prior breakdowns on partial failure", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ balance: "42.50", currency: "USD" }))
      .mockResolvedValueOnce(
        json({
          usage_records: [{
            category: "totalprice",
            price: "12.34",
            start_date: "2026-07-01",
            end_date: "2026-07-11",
          }],
        })
      )
      .mockResolvedValueOnce(new Response("forbidden", { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("auth-token", { accountId: "AC123" });

    expect(result.totalCost).toBeNull();
    expect(result.externalBilling).toMatchObject({ authoritative: false });
    expect(result.externalBilling?.records[0]).toMatchObject({
      amountUsd: null,
      currency: null,
    });
  });
});
