import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUsage } from "../stripe";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("stripe adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sums month-to-date USD fees from paginated balance transactions", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json({ available: [{ amount: 5000, currency: "usd" }], pending: [] })
      )
      .mockResolvedValueOnce(
        json({
          data: [
            { id: "txn_1", currency: "usd", fee: 30 },
            { id: "txn_2", currency: "eur", fee: 100 },
          ],
          has_more: true,
        })
      )
      .mockResolvedValueOnce(
        json({ data: [{ id: "txn_3", currency: "usd", fee: 20 }], has_more: false })
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("sk_test_key");

    expect(result.balance).toBe(50);
    expect(result.totalCost).toBe(0.5);
    expect(result.totalRequests).toBeNull();
    expect(result.rawData).toMatchObject({
      fees: {
        transactionCount: 3,
        byCurrency: {
          EUR: { amount: 1, transactions: 1 },
          USD: { amount: 0.5, transactions: 2 },
        },
      },
    });
    expect(result.externalBilling?.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rollupRole: "canonical", amountUsd: 0.5, currency: "USD" }),
        expect.objectContaining({ rollupRole: "canonical", amountUsd: 1, currency: "EUR" }),
        expect.objectContaining({ rollupRole: "component", amountUsd: 1, currency: "EUR" }),
      ])
    );
    expect(String(fetchMock.mock.calls[2][0])).toContain("starting_after=txn_2");
  });

  it("rejects a malformed 200 instead of booking an authoritative zero", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(json({ available: [], pending: [] }))
        .mockResolvedValueOnce(json({ has_more: false }))
    );

    await expect(fetchUsage("sk_test_key")).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("fails closed when pagination repeats a cursor", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(json({ available: [], pending: [] }))
        .mockResolvedValueOnce(
          json({ data: [{ id: "txn_1", currency: "usd", fee: 30 }], has_more: true })
        )
        .mockResolvedValueOnce(
          json({ data: [{ id: "txn_1", currency: "usd", fee: 20 }], has_more: true })
        )
    );

    await expect(fetchUsage("sk_test_key")).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("fails closed when has_more has no next cursor", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(json({ available: [], pending: [] }))
        .mockResolvedValueOnce(json({ data: [], has_more: true }))
    );

    await expect(fetchUsage("sk_test_key")).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("returns null canonical USD cost instead of zero for non-USD-only activity", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(json({ available: [{ amount: 900, currency: "eur" }], pending: [] }))
        .mockResolvedValueOnce(
          json({
            data: [{ id: "txn_eur", currency: "eur", fee: 125, reporting_category: "card" }],
            has_more: false,
          })
        )
    );

    const result = await fetchUsage("sk_test_key");

    expect(result.totalCost).toBeNull();
    expect(result.costScope).toBe("unknown");
    expect(result.externalBilling?.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          serviceName: "Stripe processing fees",
          amountUsd: 1.25,
          currency: "EUR",
          rollupRole: "canonical",
        }),
        expect.objectContaining({
          serviceName: "card",
          amountUsd: 1.25,
          currency: "EUR",
          rollupRole: "component",
        }),
      ])
    );
  });
});
