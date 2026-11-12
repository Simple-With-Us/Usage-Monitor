import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUsage } from "../tradier";

describe("tradier adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("surfaces used, remaining, total, and reset rate-limit metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ balances: { total_equity: 1_000 } }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-ratelimit-allowed": "120",
            "x-ratelimit-used": "20",
            "x-ratelimit-available": "100",
            "x-ratelimit-expiry": "1783857600",
          },
        })
      )
    );

    const result = await fetchUsage("key", { accountId: "account" });

    expect(result.externalBilling?.records[0]).toMatchObject({
      requestLimit: 120,
      usageQuantity: 20,
      remainingQuantity: 100,
      usageUnit: "requests",
      rollupRole: "metadata",
      dateKind: "quota_reset",
    });
  });

  function stubBalancesResponse(expiryHeaderValue: string) {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ balances: { total_equity: 1_000 } }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-ratelimit-allowed": "120",
            "x-ratelimit-used": "20",
            "x-ratelimit-available": "100",
            "x-ratelimit-expiry": expiryHeaderValue,
          },
        })
      )
    );
  }

  it("parses an epoch-millisecond expiry header without re-multiplying", async () => {
    // 1784073600000 ms = 2026-07-15T00:00:00.000Z, a current-era instant.
    stubBalancesResponse("1784073600000");

    const result = await fetchUsage("key", { accountId: "account" });

    const rawData = result.rawData as { rateLimit: { expiryAt: string | null } };
    expect(rawData.rateLimit.expiryAt).toBe("2026-07-15T00:00:00.000Z");
    expect(result.externalBilling?.records[0]).toMatchObject({
      currentPeriodEnd: "2026-07-15T00:00:00.000Z",
    });
  });

  it("parses an epoch-second expiry header by multiplying to milliseconds", async () => {
    // 1784073600 s = 2026-07-15T00:00:00.000Z.
    stubBalancesResponse("1784073600");

    const result = await fetchUsage("key", { accountId: "account" });

    const rawData = result.rawData as { rateLimit: { expiryAt: string | null } };
    expect(rawData.rateLimit.expiryAt).toBe("2026-07-15T00:00:00.000Z");
    expect(result.externalBilling?.records[0]).toMatchObject({
      currentPeriodEnd: "2026-07-15T00:00:00.000Z",
    });
  });

  it("degrades an implausible expiry header to null instead of throwing", async () => {
    // A digit string that, treated as either seconds or ms, still lands far
    // outside any sane calendar year - this must never reach persistence.
    stubBalancesResponse("1784000000000000");

    const result = await fetchUsage("key", { accountId: "account" });

    const rawData = result.rawData as { rateLimit: { expiryAt: string | null } };
    expect(rawData.rateLimit.expiryAt).toBeNull();
    expect(result.externalBilling?.records[0]).toMatchObject({
      currentPeriodEnd: null,
    });
  });

  it("still parses a non-numeric expiry date string", async () => {
    stubBalancesResponse("2026-07-15T00:00:00Z");

    const result = await fetchUsage("key", { accountId: "account" });

    const rawData = result.rawData as { rateLimit: { expiryAt: string | null } };
    expect(rawData.rateLimit.expiryAt).toBe("2026-07-15T00:00:00.000Z");
    expect(result.externalBilling?.records[0]).toMatchObject({
      currentPeriodEnd: "2026-07-15T00:00:00.000Z",
    });
  });
});
