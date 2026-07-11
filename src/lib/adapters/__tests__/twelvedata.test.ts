import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUsage } from "../twelvedata";

describe("twelve data adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads current plan and real-time API credits", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "ok", plan: "Pro" }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "api-credits-used": "11",
          "api-credits-left": "599",
        },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("key");

    expect(result.totalRequests).toBe(11);
    expect(result.credits).toBe(599);
    expect(result.externalBilling?.records[0]).toMatchObject({
      planName: "Pro",
      requestLimit: 610,
    });
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://api.twelvedata.com/api_usage"
    );
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("apikey key");
  });
});
