import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUsage } from "../anthropic";

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("anthropic adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("paginates the official cost report and converts USD cents", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          data: [{ results: [{ amount: "125", currency: "USD" }] }],
          has_more: true,
          next_page: "page_2",
        })
      )
      .mockResolvedValueOnce(
        response({
          data: [{ results: [{ amount: "75", currency: "USD" }] }],
          has_more: false,
          next_page: null,
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("standard-key", {
      adminApiKey: "admin-key",
    });

    expect(result.totalCost).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain("page=page_2");
    expect(fetchMock.mock.calls[0][1].headers["x-api-key"]).toBe("admin-key");
  });
});
