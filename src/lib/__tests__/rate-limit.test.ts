import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRateLimiter,
  getClientIp,
  getIngestIdentityRateLimitKey,
  getLoginBackstopKey,
  getLoginRateLimitKey,
  getNamedRateLimiter,
} from "../rate-limit";

describe("createRateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows up to maxRequests per key within the window, then blocks", () => {
    const limiter = createRateLimiter(60_000, 3);
    expect(limiter.check("a")).toBe(true);
    expect(limiter.check("a")).toBe(true);
    expect(limiter.check("a")).toBe(true);
    expect(limiter.check("a")).toBe(false);
    expect(limiter.check("a")).toBe(false);
  });

  it("tracks separate keys independently", () => {
    const limiter = createRateLimiter(60_000, 1);
    expect(limiter.check("a")).toBe(true);
    expect(limiter.check("b")).toBe(true);
    expect(limiter.check("a")).toBe(false);
    expect(limiter.check("b")).toBe(false);
  });

  it("resets a key's count once its window elapses", () => {
    const limiter = createRateLimiter(60_000, 1);
    expect(limiter.check("a")).toBe(true);
    expect(limiter.check("a")).toBe(false);

    vi.advanceTimersByTime(60_000);

    expect(limiter.check("a")).toBe(true);
  });

  describe("isAllowed / recordAttempt", () => {
    it("isAllowed never consumes budget, no matter how many times it's called", () => {
      const limiter = createRateLimiter(60_000, 2);
      expect(limiter.isAllowed("a")).toBe(true);
      expect(limiter.isAllowed("a")).toBe(true);
      expect(limiter.isAllowed("a")).toBe(true);
      expect(limiter.isAllowed("a")).toBe(true);
      // Still fully available after repeated checks - only recordAttempt
      // consumes budget, confirmed by draining it explicitly here.
      limiter.recordAttempt("a");
      limiter.recordAttempt("a");
      expect(limiter.isAllowed("a")).toBe(false);
    });

    it("recordAttempt consumes budget even without a prior isAllowed call", () => {
      const limiter = createRateLimiter(60_000, 2);
      limiter.recordAttempt("a");
      limiter.recordAttempt("a");
      expect(limiter.isAllowed("a")).toBe(false);
    });

    it("isAllowed reflects budget already consumed by recordAttempt", () => {
      const limiter = createRateLimiter(60_000, 1);
      expect(limiter.isAllowed("a")).toBe(true);
      limiter.recordAttempt("a");
      expect(limiter.isAllowed("a")).toBe(false);
    });

    it("recordAttempt respects window expiry like check does", () => {
      const limiter = createRateLimiter(60_000, 1);
      limiter.recordAttempt("a");
      expect(limiter.isAllowed("a")).toBe(false);

      vi.advanceTimersByTime(60_000);

      expect(limiter.isAllowed("a")).toBe(true);
    });
  });
});

describe("getClientIp", () => {
  it("trusts only the rightmost X-Forwarded-For hop", () => {
    const request = new Request("https://example.com", {
      headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1" },
    });
    // The rightmost entry is the peer address our own proxy observed; the
    // leftmost is client-supplied and must not be trusted for rate limiting.
    expect(getClientIp(request)).toBe("10.0.0.1");
  });

  it("is not fooled by an attacker padding extra spoofed hops onto the header", () => {
    const spoofed = new Request("https://example.com", {
      headers: {
        "x-forwarded-for": "1.2.3.4, 5.6.7.8, 9.9.9.9, 10.0.0.1",
      },
    });
    const direct = new Request("https://example.com", {
      headers: { "x-forwarded-for": "10.0.0.1" },
    });
    // Rotating every hop except the trusted one must resolve to the same key
    // as the trusted hop alone - otherwise an attacker can bypass a per-IP
    // limiter simply by varying the untrusted, client-controlled prefix.
    expect(getClientIp(spoofed)).toBe(getClientIp(direct));
  });

  it("trims whitespace around the trusted hop", () => {
    const request = new Request("https://example.com", {
      headers: { "x-forwarded-for": "1.2.3.4 ,  10.0.0.1  " },
    });
    expect(getClientIp(request)).toBe("10.0.0.1");
  });

  it("falls back to x-real-ip when x-forwarded-for is absent", () => {
    const request = new Request("https://example.com", {
      headers: { "x-real-ip": "198.51.100.7" },
    });
    expect(getClientIp(request)).toBe("198.51.100.7");
  });

  it("falls back to 127.0.0.1 when no proxy headers are present", () => {
    const request = new Request("https://example.com");
    expect(getClientIp(request)).toBe("127.0.0.1");
  });

  it("ignores a blank x-forwarded-for value and falls back", () => {
    const request = new Request("https://example.com", {
      headers: { "x-forwarded-for": "  ", "x-real-ip": "198.51.100.7" },
    });
    expect(getClientIp(request)).toBe("198.51.100.7");
  });
});

describe("getLoginRateLimitKey", () => {
  it("gives two Cloudflare-proxied clients sharing the same egress IP distinct keys", () => {
    // usage.jays.services is fronted by Cloudflare -> Render, so the
    // rightmost XFF hop is Cloudflare's shared egress IP - identical for
    // every CF-proxied client - while CF-Connecting-IP (CF-set, untrustworthy
    // only outside the CF path) still tells them apart.
    const clientA = new Request("https://usage.jays.services/api/auth/login", {
      headers: {
        "x-forwarded-for": "203.0.113.50",
        "cf-connecting-ip": "198.51.100.11",
      },
    });
    const clientB = new Request("https://usage.jays.services/api/auth/login", {
      headers: {
        "x-forwarded-for": "203.0.113.50",
        "cf-connecting-ip": "198.51.100.22",
      },
    });
    expect(getClientIp(clientA)).toBe(getClientIp(clientB));
    expect(getLoginRateLimitKey(clientA)).not.toBe(getLoginRateLimitKey(clientB));
  });

  it("is stable for the same client across repeated requests", () => {
    const makeRequest = () =>
      new Request("https://usage.jays.services/api/auth/login", {
        headers: {
          "x-forwarded-for": "203.0.113.50",
          "cf-connecting-ip": "198.51.100.11",
        },
      });
    expect(getLoginRateLimitKey(makeRequest())).toBe(getLoginRateLimitKey(makeRequest()));
  });

  it("uses an empty cf-connecting-ip component when the header is absent", () => {
    const withoutCf = new Request("https://usage.jays.services/api/auth/login", {
      headers: { "x-forwarded-for": "203.0.113.50" },
    });
    const withEmptyCf = new Request("https://usage.jays.services/api/auth/login", {
      headers: { "x-forwarded-for": "203.0.113.50", "cf-connecting-ip": "" },
    });
    // Both "absent" and "explicitly empty" resolve to the same "" component,
    // matching the documented "'' when absent" semantics.
    expect(getLoginRateLimitKey(withoutCf)).toBe(getLoginRateLimitKey(withEmptyCf));
    expect(getLoginRateLimitKey(withoutCf)).toContain("cf-connecting-ip=");
  });

  it("differs from getClientIp alone, so a shared egress IP doesn't collapse distinct tuples", () => {
    const request = new Request("https://usage.jays.services/api/auth/login", {
      headers: {
        "x-forwarded-for": "203.0.113.50",
        "cf-connecting-ip": "198.51.100.11",
      },
    });
    expect(getLoginRateLimitKey(request)).not.toBe(getClientIp(request));
  });
});

describe("getLoginBackstopKey", () => {
  it("keys by CF-Connecting-IP when the rightmost hop is a real Cloudflare IP", () => {
    // 173.245.48.1 is within Cloudflare's published 173.245.48.0/20 range -
    // i.e. this simulates genuine production (Cloudflare -> Render) traffic,
    // where CF-Connecting-IP is Cloudflare-set and trustworthy.
    const clientA = new Request("https://usage.jays.services/api/auth/login", {
      headers: { "x-forwarded-for": "173.245.48.1", "cf-connecting-ip": "198.51.100.11" },
    });
    const clientB = new Request("https://usage.jays.services/api/auth/login", {
      headers: { "x-forwarded-for": "173.245.48.1", "cf-connecting-ip": "198.51.100.22" },
    });
    // Same shared egress hop, but distinct CF-Connecting-IP -> distinct
    // backstop buckets, so one client's exhaustion can't touch the other's.
    expect(getLoginBackstopKey(clientA)).toBe("198.51.100.11");
    expect(getLoginBackstopKey(clientB)).toBe("198.51.100.22");
    expect(getLoginBackstopKey(clientA)).not.toBe(getLoginBackstopKey(clientB));
  });

  it("falls back to the rightmost hop alone when it is not a Cloudflare IP", () => {
    // 45.33.12.9 is not in any published Cloudflare range - this simulates
    // traffic reaching the deployment directly, bypassing Cloudflare, where
    // CF-Connecting-IP is just an ordinary, attacker-settable header.
    const request = new Request("https://usage.jays.services/api/auth/login", {
      headers: { "x-forwarded-for": "45.33.12.9", "cf-connecting-ip": "10.10.10.1" },
    });
    expect(getLoginBackstopKey(request)).toBe("45.33.12.9");
  });

  it("rotating a forged cf-connecting-ip from a non-Cloudflare peer does not change the backstop key", () => {
    const makeRequest = (cfIp: string) =>
      new Request("https://usage.jays.services/api/auth/login", {
        headers: { "x-forwarded-for": "45.33.12.9", "cf-connecting-ip": cfIp },
      });
    const keys = new Set([
      getLoginBackstopKey(makeRequest("10.10.10.1")),
      getLoginBackstopKey(makeRequest("10.10.10.2")),
      getLoginBackstopKey(makeRequest("10.10.10.3")),
    ]);
    // All three resolve to the same key (the unspoofable rightmost hop), so
    // rotating the forged header cannot fragment the backstop.
    expect(keys.size).toBe(1);
  });

  it("falls back to the rightmost hop when cf-connecting-ip is absent, even behind a Cloudflare IP", () => {
    const request = new Request("https://usage.jays.services/api/auth/login", {
      headers: { "x-forwarded-for": "173.245.48.1" },
    });
    expect(getLoginBackstopKey(request)).toBe("173.245.48.1");
  });
});

describe("getIngestIdentityRateLimitKey", () => {
  it("gives distinct tokens distinct buckets and the same token a stable key", () => {
    const keyA = getIngestIdentityRateLimitKey("token-a");
    const keyB = getIngestIdentityRateLimitKey("token-b");
    expect(keyA).not.toBe(keyB);
    expect(getIngestIdentityRateLimitKey("token-a")).toBe(keyA);
  });

  it("never embeds the raw token in the key", () => {
    const key = getIngestIdentityRateLimitKey("super-secret-ingest-token");
    expect(key).not.toContain("super-secret-ingest-token");
    expect(key).toMatch(/^ingest-token:[0-9a-f]{64}$/);
  });
});

describe("getNamedRateLimiter", () => {
  it("returns the same instance for the same name and a fresh one per name", () => {
    const first = getNamedRateLimiter("test-named-a", 1_000, 1);
    const again = getNamedRateLimiter("test-named-a", 60_000, 99);
    const other = getNamedRateLimiter("test-named-b", 1_000, 1);
    expect(again).toBe(first);
    expect(other).not.toBe(first);
    first.reset();
    other.reset();
  });

  it("reset clears consumed budget (test isolation hook)", () => {
    const limiter = getNamedRateLimiter("test-named-reset", 60_000, 1);
    expect(limiter.check("key")).toBe(true);
    expect(limiter.check("key")).toBe(false);
    limiter.reset();
    expect(limiter.check("key")).toBe(true);
    limiter.reset();
  });
});
