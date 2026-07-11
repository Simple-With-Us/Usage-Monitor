import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUsage } from "../github";

describe("github billing adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sums enhanced-billing net amounts without persisting repository details", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          usageItems: [
            { product: "Actions", sku: "Linux", quantity: 10, netAmount: 1.25, repositoryName: "private/repo" },
            { product: "Copilot", sku: "Premium", netQuantity: 2, netAmount: 0.5 },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("token", { org: "Acme" });

    expect(result.totalCost).toBe(1.75);
    expect(result.externalBilling?.records[0]).toMatchObject({
      kind: "billing_period",
      amountUsd: 1.75,
      currency: "USD",
    });
    expect(JSON.stringify(result.rawData)).not.toContain("private/repo");
    expect(fetchMock.mock.calls[0][0]).toContain(
      "/organizations/Acme/settings/billing/usage?"
    );
  });
});
