import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUsage } from "../deno";
import { AdapterError } from "../helpers";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("Deno Deploy Adapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("throws UNSUPPORTED when no API key is provided", async () => {
    await expect(fetchUsage("")).rejects.toThrow(AdapterError);
  });

  it("fetches user info when API token is provided", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json({
          id: "usr_123",
          name: "Congress Trade",
          email: "ct@jays.services",
        })
      )
    );

    const result = await fetchUsage("ddp_test_token");
    expect(result.externalBilling?.records[0].externalId).toBe("usr_123");
  });
});
