import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchJson,
  isForbiddenOutboundAddress,
  redactUrlForError,
  resolveSafeOutboundAddress,
} from "../helpers";

// These tests exercise the transport hardening added to fetchJson: a
// per-request timeout, bounded retry-on-transient-status behavior with
// Retry-After / exponential backoff, and URL redaction in error messages.
//
// Nothing here is allowed to actually sleep or hit the network: `fetch` is
// mocked and all backoff sleeps are driven by Vitest fake timers.
//
// Runtime note: this repo runs on Node >= 20 (AbortSignal.any lands in
// 20.3 / 19.7, AbortSignal.timeout in 17.3), so the composed-signal path in
// fetchWithTimeout is available. The timeout *firing* is simulated by having
// the mocked fetch reject with an AbortError rather than by advancing a real
// AbortSignal.timeout, because Vitest fake timers do not fake
// AbortSignal.timeout in this runtime (verified empirically).

const JSON_HEADERS = { "content-type": "application/json" };

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

// Runs a fetchJson call that is expected to reject and returns the thrown
// Error. Typed so the resolved-value union doesn't bleed into the caller.
async function expectRejection(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected the call to reject, but it resolved");
}

function abortError(): Error {
  // Mirrors what fetch throws when its AbortSignal fires: an Error whose
  // .name is "AbortError". DOMException isn't reliably constructable in every
  // runtime, so use a plain Error with the same discriminant fetchJson keys on.
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  return err;
}

describe("redactUrlForError", () => {
  it("strips the query string so API keys never leak into error messages", () => {
    expect(
      redactUrlForError("https://api.example.com/v1/usage?key=super-secret-123")
    ).toBe("https://api.example.com/v1/usage?[REDACTED]");
  });

  it("leaves a URL without a query string unchanged", () => {
    expect(redactUrlForError("https://api.example.com/v1/usage")).toBe(
      "https://api.example.com/v1/usage"
    );
  });
});

describe("fetchJson", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("(a) throws a redacted error when the request aborts (timeout)", async () => {
    fetchMock.mockRejectedValue(abortError());

    const url = "https://api.example.com/v1/usage?key=super-secret-123";
    await expect(fetchJson(url)).rejects.toThrowError(
      "Request to https://api.example.com/v1/usage?[REDACTED] timed out after"
    );

    // The API key / query string must not appear anywhere in the thrown message.
    const err = await expectRejection(() => fetchJson(url));
    expect(err.message).not.toContain("super-secret-123");
    expect(err.message).not.toContain("key=");
    expect(fetchMock).toHaveBeenCalled();
  });

  it("wraps a generic network error with a redacted URL (no timeout wording)", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNRESET"));

    const url = "https://api.example.com/v1/usage?token=abc";
    const err = await expectRejection(() => fetchJson(url));
    expect(err.message).toContain(
      "Request to https://api.example.com/v1/usage?[REDACTED] failed: ECONNRESET"
    );
    expect(err.message).not.toContain("token=abc");
    expect(err.message).not.toContain("timed out");
  });

  it("(b) passes a successful response through as { ok, status, data, headers }", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ balance: 42 }, 200, { "x-custom": "yes" })
    );

    const result = await fetchJson("https://api.example.com/v1/usage");
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.data).toEqual({ balance: 42 });
    expect(result.headers).toBeInstanceOf(Headers);
    expect(result.headers.get("x-custom")).toBe("yes");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("(c) retries after Retry-After given in seconds, then succeeds", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ error: "slow down" }, 429, { "retry-after": "2" })
      )
      .mockResolvedValueOnce(jsonResponse({ balance: 7 }, 200));

    const promise = fetchJson("https://api.example.com/v1/usage");
    // 2s Retry-After (<= 15s cap) => it sleeps then retries.
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;

    expect(result.status).toBe(200);
    expect(result.data).toEqual({ balance: 7 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("(d) parses Retry-After given as an HTTP-date", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-07-06T12:00:00.000Z");
    vi.setSystemTime(now);
    // 3 seconds in the future, expressed as an HTTP-date string.
    const retryAt = new Date(now.getTime() + 3000).toUTCString();

    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ error: "slow down" }, 503, { "retry-after": retryAt })
      )
      .mockResolvedValueOnce(jsonResponse({ balance: 9 }, 200));

    const promise = fetchJson("https://api.example.com/v1/usage");
    // Not yet past the retry point: still only one call.
    await vi.advanceTimersByTimeAsync(2999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Cross the 3s mark: the retry fires.
    await vi.advanceTimersByTimeAsync(1);
    const result = await promise;

    expect(result.status).toBe(200);
    expect(result.data).toEqual({ balance: 9 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("(e) returns immediately without waiting when Retry-After exceeds the 15s cap", async () => {
    vi.useFakeTimers();
    // 20s > MAX_RETRY_AFTER_WAIT_MS (15s): must NOT sleep or retry.
    fetchMock.mockResolvedValue(
      jsonResponse({ error: "come back later" }, 429, { "retry-after": "20" })
    );

    const result = await fetchJson("https://api.example.com/v1/usage");

    expect(result.status).toBe(429);
    expect(result.data).toEqual({ error: "come back later" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // No timers should be pending, proving it never scheduled a backoff sleep.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("(f) retries a retryable status at most twice, then returns the last response", async () => {
    vi.useFakeTimers();
    // No Retry-After => exponential backoff: 2**0*1000 then 2**1*1000.
    // Each call must return a *distinct* Response (as real fetch does): the
    // first two get their bodies cancelled on retry, and only the last one's
    // body is read via .json(). Reusing one Response instance would have its
    // body cancelled by the retry path before the final read.
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: "unavailable" }, 503))
      .mockResolvedValueOnce(jsonResponse({ error: "unavailable" }, 503))
      .mockResolvedValueOnce(jsonResponse({ error: "unavailable" }, 503));

    const promise = fetchJson("https://api.example.com/v1/usage");
    // Flush both backoff sleeps: 1000ms + 2000ms.
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;

    // 1 initial + 2 retries = 3 total, then it gives up and returns the 503.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.status).toBe(503);
    expect(result.data).toEqual({ error: "unavailable" });
  });

  it("(f2) cancels the discarded response body before retrying so the connection is not leaked", async () => {
    vi.useFakeTimers();

    // The retried (429) response's body must be cancelled before the next
    // fetch; the final (200) response's body is consumed normally by .json()
    // and must NOT be cancelled.
    const retriedResponse = jsonResponse({ error: "slow down" }, 429, {
      "retry-after": "2",
    });
    const finalResponse = jsonResponse({ balance: 7 }, 200);
    const retriedCancel = vi.spyOn(retriedResponse.body!, "cancel");
    const finalCancel = vi.spyOn(finalResponse.body!, "cancel");

    fetchMock
      .mockResolvedValueOnce(retriedResponse)
      .mockResolvedValueOnce(finalResponse);

    const promise = fetchJson("https://api.example.com/v1/usage");
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;

    expect(result.status).toBe(200);
    expect(result.data).toEqual({ balance: 7 });
    expect(retriedCancel).toHaveBeenCalledTimes(1);
    expect(finalCancel).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("(g) does not retry a non-retryable status (e.g. 401)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "unauthorized" }, 401));

    const result = await fetchJson("https://api.example.com/v1/usage");

    expect(result.status).toBe(401);
    expect(result.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("(h) does not retry a non-GET method even on a retryable status", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: "slow down" }, 429, { "retry-after": "2" })
    );

    const result = await fetchJson("https://api.example.com/v1/usage", {
      method: "POST",
    });

    // Retryable status + Retry-After present, but POST is not idempotent =>
    // returned straight through with no retry and no wait.
    expect(result.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("honors an explicit options.timeoutMs in the timeout error message", async () => {
    fetchMock.mockRejectedValue(abortError());

    const err = await expectRejection(() =>
      fetchJson("https://api.example.com/v1/usage", undefined, {
        timeoutMs: 1234,
      })
    );

    expect(err.message).toContain("timed out after 1234ms");
  });

  it("rejects plaintext HTTP before sending credentials", async () => {
    await expect(fetchJson("http://api.example.com/usage")).rejects.toMatchObject({
      code: "UNSAFE_OUTBOUND_URL",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bounds provider response bodies", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ value: "x".repeat(200) }), {
        headers: { "content-type": "application/json" },
      })
    );

    await expect(
      fetchJson("https://api.example.com/usage", undefined, {
        maxResponseBytes: 32,
      })
    ).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
  });

  it("classifies malformed successful JSON as an invalid provider response", async () => {
    fetchMock.mockResolvedValue(
      new Response("{broken", {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    await expect(
      fetchJson("https://api.example.com/usage")
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});

describe("untrusted outbound address validation", () => {
  it("blocks local, private, link-local, and metadata-adjacent ranges", () => {
    expect(isForbiddenOutboundAddress("127.0.0.1")).toBe(true);
    expect(isForbiddenOutboundAddress("10.0.0.1")).toBe(true);
    expect(isForbiddenOutboundAddress("169.254.169.254")).toBe(true);
    expect(isForbiddenOutboundAddress("::1")).toBe(true);
    expect(isForbiddenOutboundAddress("8.8.8.8")).toBe(false);
  });

  it("fails closed when any DNS answer is private", async () => {
    await expect(
      resolveSafeOutboundAddress(
        new URL("https://api.example.com/usage"),
        async () => [
          { address: "8.8.8.8", family: 4 },
          { address: "127.0.0.1", family: 4 },
        ]
      )
    ).rejects.toMatchObject({ code: "UNSAFE_OUTBOUND_URL" });
  });
});
