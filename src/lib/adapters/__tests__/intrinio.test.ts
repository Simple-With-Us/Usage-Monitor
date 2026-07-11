import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUsage } from "../intrinio";

describe("intrinio adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads current per-feed usage without retaining account email", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            usage: [
              { access_code: "feed-a", count: "10", limit: "100" },
              { access_code: "feed-b", count: "5", limit: "50" },
            ],
            account: { email: "private@example.com" },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
    );

    const result = await fetchUsage("key");

    expect(result.totalRequests).toBe(15);
    expect(result.credits).toBe(135);
    expect(result.externalBilling?.records).toHaveLength(2);
    expect(JSON.stringify(result.rawData)).not.toContain("private@example.com");
  });
});
