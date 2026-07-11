import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUsage } from "../mistral";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Mistral billing adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the official Admin API and exposes spend/rate limits", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ start_date: "2026-07-01T00:00:00Z", end_date: "2026-07-11T00:00:00Z", currency: "USD", chat: {} }))
      .mockResolvedValueOnce(json({ limits: { completion: { total_usage: 12, usage_limit: 100, monthly_limit_reached: false }, currency: "USD", last_payment_failure: false } }))
      .mockResolvedValueOnce(json({ requests_per_second: 5, tokens_limits_by_model: {} }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("inference-key", { adminApiKey: "admin-key" });

    expect(result.totalCost).toBe(12);
    expect(result.balance).toBe(88);
    const spendSync = result.externalBillingSyncs?.find(
      (sync) => sync.source === "mistral-spend-limits"
    );
    const rateSync = result.externalBillingSyncs?.find(
      (sync) => sync.source === "mistral-rate-limits"
    );
    expect(spendSync?.records[0]).toMatchObject({
      spendLimitUsd: 100,
    });
    expect(rateSync?.records[0]).toMatchObject({
      requestLimit: 5,
    });
    expect(fetchMock.mock.calls[0][0]).toContain("https://console.mistral.ai/api/admin/usage?");
    expect(fetchMock.mock.calls[0][1].headers["x-api-key"]).toBe("admin-key");
  });

  it("does not reconcile usage billing when its cost endpoint fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(
          json({
            start_date: "2026-07-01T00:00:00Z",
            end_date: "2026-07-11T00:00:00Z",
            currency: "USD",
          })
        )
        .mockResolvedValueOnce(json({}, 403))
        .mockResolvedValueOnce(json({ requests_per_second: 5 }))
    );

    const result = await fetchUsage("admin-key");
    const sources = result.externalBillingSyncs?.map((sync) => sync.source);

    expect(result.totalCost).toBeNull();
    expect(sources).toEqual(["mistral-rate-limits"]);
    expect(sources).not.toContain("mistral-usage-billing");
    expect(sources).not.toContain("mistral-spend-limits");
  });
});
