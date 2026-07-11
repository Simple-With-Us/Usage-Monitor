import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchUsage } from "../hetzner";

describe("hetzner adapter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("syncs server plans without misclassifying run-rate as accrued spend", async () => {
    const fetchSpy = vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        servers: [
          {
            id: 1,
            name: "server1",
            status: "running",
            outgoing_traffic: 1000,
            datacenter: { location: { name: "fsn1" } },
            server_type: {
              name: "cx11",
              prices: [
                {
                  location: "fsn1",
                  price_monthly: { net: "3.50", gross: "4.16" },
                  price_hourly: { net: "0.005", gross: "0.006" },
                },
              ],
            },
          },
          {
            id: 2,
            name: "server2",
            status: "running",
            outgoing_traffic: 500,
            datacenter: { location: { name: "nbg1" } },
            server_type: {
              name: "cx21",
              prices: [
                {
                  location: "nbg1",
                  price_monthly: { net: "5.00", gross: "5.95" },
                  price_hourly: { net: "0.008", gross: "0.009" },
                },
              ],
            },
          },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        pricing: { currency: "EUR" },
      }), { status: 200, headers: { "content-type": "application/json" } }));

    const result = await fetchUsage("fake-key");

    expect(fetchSpy).toHaveBeenNthCalledWith(1, "https://api.hetzner.cloud/v1/servers", {
      headers: { Authorization: "Bearer fake-key" },
      redirect: "error",
      signal: expect.any(AbortSignal),
    });

    expect(result.totalCost).toBeNull();
    expect(result.totalRequests).toBeNull();
    
    const rawData = result.rawData as Record<string, unknown>;
    expect(rawData.totalBandwidthBytes).toBe(1500);
    expect(rawData.monthlyRunRate).toEqual({ amount: 8.5, currency: "EUR" });
    expect(rawData.servers).toHaveLength(2);
    expect(result.externalBilling?.records).toHaveLength(2);
    expect(result.externalBilling?.records[0]).toMatchObject({
      amountUsd: null,
      currency: "EUR",
    });
  });

  it("handles fetch errors", async () => {
    vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }))
      .mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }));

    await expect(fetchUsage("bad-key")).rejects.toMatchObject({
      code: "HTTP_ERROR",
      status: 401,
    });
  });
});
