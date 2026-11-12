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

  it.each(["", "sk-ant-api03-standard-key"])(
    "skips polling for an individual account instead of sending its Messages API key (%j)",
    async (apiKey) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(fetchUsage(apiKey)).rejects.toMatchObject({
        code: "UNSUPPORTED",
        message: expect.stringMatching(/unavailable to individual accounts/i),
      });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it("does not mistake a Messages API key in advanced config for an Admin key", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchUsage("", { adminApiKey: "sk-ant-api03-standard-key" })
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

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
      adminApiKey: "sk-ant-admin01-config-key",
    });

    expect(result.totalCost).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain("page=page_2");
    expect(fetchMock.mock.calls[0][1].headers["x-api-key"]).toBe(
      "sk-ant-admin01-config-key"
    );
  });

  it("rejects a malformed 200 instead of reconciling an empty report", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response({ has_more: false })));

    await expect(fetchUsage("sk-ant-admin01-test-key")).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("rejects a bucket that omits result shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        response({ data: [{}], has_more: false, next_page: null })
      )
    );

    await expect(fetchUsage("sk-ant-admin01-test-key")).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("fails closed when the next page cursor repeats", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(
          response({ data: [], has_more: true, next_page: "repeat" })
        )
        .mockResolvedValueOnce(
          response({ data: [], has_more: true, next_page: "repeat" })
        )
    );

    await expect(fetchUsage("sk-ant-admin01-test-key")).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("fails closed when has_more omits next_page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        response({ data: [], has_more: true, next_page: null })
      )
    );

    await expect(fetchUsage("sk-ant-admin01-test-key")).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("retains direct polling for legacy rows whose primary key is an Admin key", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      response({ data: [], has_more: false, next_page: null })
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchUsage("sk-ant-admin01-test-key");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].headers["x-api-key"]).toBe(
      "sk-ant-admin01-test-key"
    );
  });
});
