import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUsage } from "../unusualwhales";

function stubResponse(status: number, headers: Record<string, string> = {}, body: unknown = { data: [] }) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...headers },
      })
    )
  );
}

describe("unusualwhales adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads the daily request count header from a minimal congress-trades read", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ ticker: "AAPL" }] }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-uw-daily-req-count": "42",
        },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("key");

    expect(result.totalRequests).toBe(42);
    expect(result.credits).toBeNull();
    expect(result.balance).toBeNull();
    expect(result.totalCost).toBeNull();
    expect(result.externalBilling).toMatchObject({
      source: "unusual-whales-daily-request-count",
      authoritative: true,
      records: [
        expect.objectContaining({
          externalId: "daily-request-count",
          kind: "account",
          serviceName: "Unusual Whales API",
          usageQuantity: 42,
          remainingQuantity: null,
          requestLimit: null,
          usageUnit: "requests",
          rollupRole: "metadata",
          dateKind: "quota_reset",
        }),
      ],
    });
    expect(result.rawData).toMatchObject({
      dailyRequestCount: 42,
      pollConsumesRequest: true,
      capabilities: expect.objectContaining({
        dailyRequestCount: true,
        billingCost: false,
        requestLimit: false,
      }),
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      "https://api.unusualwhales.com/api/congress/recent-trades?limit=1"
    );
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer key",
    });
  });

  it("degrades to unknown usage when the header is absent", async () => {
    stubResponse(200);

    const result = await fetchUsage("key");

    expect(result.totalRequests).toBeNull();
    expect(result.externalBilling).toBeUndefined();
    expect(result.rawData).toMatchObject({ dailyRequestCount: null });
  });

  it("degrades an implausibly large header value to null instead of persisting it", async () => {
    stubResponse(200, { "x-uw-daily-req-count": "9999999999" });

    const result = await fetchUsage("key");

    expect(result.totalRequests).toBeNull();
    expect(result.externalBilling).toBeUndefined();
    expect(result.rawData).toMatchObject({ dailyRequestCount: null });
  });

  it("degrades a negative header value to null instead of persisting it", async () => {
    stubResponse(200, { "x-uw-daily-req-count": "-5" });

    const result = await fetchUsage("key");

    expect(result.totalRequests).toBeNull();
    expect(result.externalBilling).toBeUndefined();
  });

  it("surfaces an unauthorized key as an HTTP adapter error", async () => {
    stubResponse(401, {}, { error: "Unauthorized" });

    await expect(fetchUsage("bad-key")).rejects.toMatchObject({
      code: "HTTP_ERROR",
      status: 401,
    });
  });

  it("keeps a stable auth reason and drops the free-form message", async () => {
    stubResponse(401, {}, {
      reason: "unrecognized_token",
      message: "token sk-live-secret was revoked",
      retryable: false,
    });

    await expect(fetchUsage("123e4567-e89b-12d3-a456-426614174000")).rejects.toMatchObject({
      code: "HTTP_ERROR",
      status: 401,
      retryable: false,
      message: "Provider API returned HTTP 401: unrecognized_token",
    });
  });

  it("surfaces a forbidden key as an HTTP adapter error", async () => {
    stubResponse(403, {}, { error: "Forbidden" });

    await expect(fetchUsage("key")).rejects.toMatchObject({
      code: "HTTP_ERROR",
      status: 403,
    });
  });

  it("surfaces rate limiting as a retryable HTTP adapter error", async () => {
    // retry-after: 0 lets fetchJson's built-in 429 retry loop exhaust its
    // attempts immediately instead of sleeping for real backoff delays.
    stubResponse(429, { "retry-after": "0" }, { error: "Too Many Requests" });

    await expect(fetchUsage("key")).rejects.toMatchObject({
      code: "HTTP_ERROR",
      status: 429,
      retryable: true,
    });
  });
});
