import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUsage } from "../xai";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("xAI billing adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses invoice preview as spend and prepaid total as balance", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ total: { val: "-4500" }, changes: [{ changeOrigin: "PURCHASE" }] }))
      .mockResolvedValueOnce(json({ coreInvoice: { totalWithCorr: { val: "1234" } }, effectiveSpendingLimit: "20000", billingCycle: { year: 2026, month: 7 } }))
      .mockResolvedValueOnce(json({ spendingLimits: { effectiveSl: { val: "20000" }, effectiveHardSl: { val: "22500" } } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("inference-key", {
      teamId: "team-1",
      managementKey: "management-key",
    });

    expect(result.balance).toBe(45);
    expect(result.totalCost).toBe(12.34);
    expect(result.externalBilling?.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "invoice", amountUsd: 12.34, spendLimitUsd: 200 }),
      ])
    );
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer management-key");
  });
});
