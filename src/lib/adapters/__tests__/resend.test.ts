import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUsage } from "../resend";

describe("resend adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("surfaces rate limits and labels quota headers as email usage counts", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "key-1" }] }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "ratelimit-limit": "100",
          "ratelimit-remaining": "73",
          "ratelimit-reset": "1s",
          "x-resend-monthly-quota": "1234",
          "x-resend-daily-quota": "45",
        },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("key");

    expect(result.externalBilling?.records[0]).toMatchObject({
      serviceName: "Resend API",
      requestLimit: 100,
      usageQuantity: 27,
      remainingQuantity: 73,
      rollupRole: "metadata",
    });
    const emailUsage = result.externalBillingSyncs?.find(
      (sync) => sync.source === "resend-email-quota-usage"
    );
    expect(emailUsage).toMatchObject({ authoritative: true });
    expect(emailUsage?.records).toEqual([
      expect.objectContaining({
        externalId: "monthly-email-usage",
        planName: "Monthly emails used",
        requestLimitWindow: "month",
        usageQuantity: 1234,
        remainingQuantity: null,
        usageUnit: "emails",
      }),
      expect.objectContaining({
        externalId: "daily-email-usage",
        planName: "Daily emails used",
        requestLimitWindow: "day",
        usageQuantity: 45,
        remainingQuantity: null,
        usageUnit: "emails",
      }),
    ]);
    for (const record of emailUsage?.records ?? []) {
      expect(record.requestLimit).toBeUndefined();
    }
    expect(result.totalCost).toBeNull();
    expect(result.costScope).toBe("unknown");
    expect(result.rawData).toMatchObject({
      emailUsage: { monthlyEmailsUsed: 1234, dailyEmailsUsed: 45 },
      capabilities: { emailUsageCounts: true, emailQuotaLimits: false },
    });
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://api.resend.com/api-keys");
  });

  it("preserves prior email-usage rows when quota headers are absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      )
    );

    const result = await fetchUsage("key");
    expect(result.externalBillingSyncs).toBeUndefined();
    expect(result.rawData).toMatchObject({
      emailUsage: { monthlyEmailsUsed: null, dailyEmailsUsed: null },
    });
  });
});
