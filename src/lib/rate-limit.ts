/**
 * Simple in-memory rate limiter with automatic entry cleanup.
 *
 * Uses a Map to track request counts per key (e.g., IP address) within a
 * sliding window. Old entries are purged on every check to prevent memory
 * leaks - no external dependencies required.
 *
 * NOTE: In-process memory only — rate-limit state is not shared across
 * multiple instances/workers. Fine for a single-instance deployment;
 * switch to a shared store (Redis, etc.) if you scale horizontally.
 */

import { createHash } from "crypto";
import { isCloudflareIp } from "./cloudflare-ip-ranges";

interface RateLimitEntry {
  count: number;
  resetAt: number; // epoch ms when the window resets
}

export interface RateLimiter {
  /**
   * Returns true if the request should be allowed, false if rate-limited.
   * Calling this also increments the counter for `key`.
   */
  check(key: string): boolean;

  /**
   * Clears every tracked key. Intended for test isolation (module-level
   * limiter singletons otherwise leak window state across tests); production
   * code never calls this.
   */
  reset(): void;

  /**
   * Returns true if `key` currently has budget remaining, WITHOUT consuming
   * any of it. Use this to gate work (e.g. "is this request even allowed to
   * proceed?") when you don't yet know whether the attempt should count
   * against the limit.
   */
  isAllowed(key: string): boolean;

  /**
   * Consumes one unit of `key`'s budget. Use this to record an attempt after
   * the fact (e.g. only once you know the attempt failed), separately from
   * the `isAllowed` check that gated whether it was permitted to happen.
   */
  recordAttempt(key: string): void;
}

/**
 * Creates a rate limiter that allows at most `maxRequests` per `windowMs`
 * window per distinct key.
 *
 * @param windowMs  Duration of the rate-limit window in milliseconds.
 * @param maxRequests  Maximum number of requests allowed per key in the window.
 */
export function createRateLimiter(
  windowMs: number,
  maxRequests: number
): RateLimiter {
  const store = new Map<string, RateLimitEntry>();

  // Purge expired entries. Called inline on every check so we never need a
  // background timer - the cleanup cost is just iterating the Map, which is
  // fine for the request volumes this app handles.
  function purgeExpired(now: number): void {
    for (const [key, entry] of store) {
      if (now >= entry.resetAt) {
        store.delete(key);
      }
    }
  }

  return {
    check(key: string): boolean {
      const now = Date.now();

      // Clean up old entries first
      purgeExpired(now);

      const existing = store.get(key);

      if (!existing || now >= existing.resetAt) {
        // First request in this window (or window expired)
        store.set(key, { count: 1, resetAt: now + windowMs });
        return true;
      }

      if (existing.count < maxRequests) {
        existing.count += 1;
        return true;
      }

      // Rate limit exceeded
      return false;
    },

    isAllowed(key: string): boolean {
      const now = Date.now();
      purgeExpired(now);

      const existing = store.get(key);
      if (!existing || now >= existing.resetAt) {
        // No active window yet (or the previous one expired) - nothing has
        // been consumed, so budget is available. Deliberately does not
        // create an entry: an isAllowed() check alone must never consume.
        return true;
      }
      return existing.count < maxRequests;
    },

    recordAttempt(key: string): void {
      const now = Date.now();
      purgeExpired(now);

      const existing = store.get(key);
      if (!existing || now >= existing.resetAt) {
        store.set(key, { count: 1, resetAt: now + windowMs });
        return;
      }
      existing.count += 1;
    },

    reset(): void {
      store.clear();
    },
  };
}

/**
 * Process-wide named limiter registry. Route modules create their limiters
 * through this so tests can retrieve the same instance and `reset()` it
 * between cases — Next.js route files cannot export extra bindings (only
 * HTTP methods + config), so a route-local module const is unreachable from
 * test files. First call wins: later calls with the same name ignore the
 * supplied window/budget and return the existing limiter.
 */
const namedLimiters = new Map<string, RateLimiter>();

export function getNamedRateLimiter(
  name: string,
  windowMs: number,
  maxRequests: number
): RateLimiter {
  let limiter = namedLimiters.get(name);
  if (!limiter) {
    limiter = createRateLimiter(windowMs, maxRequests);
    namedLimiters.set(name, limiter);
  }
  return limiter;
}

/**
 * Builds the rate-limit key used for authenticated ingest traffic: a SHA-256
 * hash of the presented bearer/header token. Each distinct credential gets
 * its own bucket, so producers sharing Cloudflare's egress IP no longer
 * share one rate bucket (the old pre-auth per-IP behavior), and one producer
 * bursting can never 429 the others. The raw token is never used as (or
 * logged through) the key itself.
 */
export function getIngestIdentityRateLimitKey(token: string): string {
  return `ingest-token:${createHash("sha256").update(token).digest("hex")}`;
}

/**
 * Extracts the nearest trusted peer address from a Next.js request, checking
 * common proxy headers.
 *
 * Only the rightmost X-Forwarded-For hop is trusted. That entry is the peer
 * address our own reverse proxy (Caddy, on the Oracle Cloud production VPS)
 * observed and appended when it forwarded the request; every entry to its
 * left is copied verbatim from whatever the client sent and can be freely
 * spoofed - e.g. to rotate through fake IPs and evade per-IP rate limiting.
 * Trusting the leftmost entry (the historical behavior here) makes limiting
 * trivially bypassable.
 *
 * IMPORTANT - this is NOT necessarily "the client": usage.jays.services is
 * fronted by Cloudflare in front of Caddy, so in production the rightmost
 * hop Caddy observes is Cloudflare's own egress IP, which is SHARED by
 * every Cloudflare-proxied client, not a per-visitor address. Only when a
 * request reaches Caddy directly (bypassing Cloudflare) does this hop
 * identify one true peer. Callers that need to distinguish individual
 * Cloudflare-proxied clients (e.g. login rate limiting) should pair this
 * with `cf-connecting-ip` rather than treating this value alone as a client
 * identity - see `getLoginRateLimitKey` below.
 */
export function getClientIp(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const hops = forwardedFor
      .split(",")
      .map((hop) => hop.trim())
      .filter(Boolean);
    const trustedHop = hops[hops.length - 1];
    if (trustedHop) return trustedHop;
  }
  return request.headers.get("x-real-ip")?.trim() || "127.0.0.1";
}

/**
 * Builds the rate-limit key used for login attempts: the tuple of (rightmost
 * X-Forwarded-For hop, CF-Connecting-IP header value or "" when absent).
 *
 * Why a tuple instead of `getClientIp` alone: usage.jays.services sits
 * behind Cloudflare, which proxies to Caddy on the Oracle VPS. For that
 * path, the rightmost XFF hop Caddy observes is Cloudflare's own egress
 * IP - shared by every Cloudflare-proxied client - so keying only on it
 * would bucket unrelated visitors together. Cloudflare itself sets
 * `CF-Connecting-IP` from the TLS-terminated connection before forwarding
 * the request, so a client arriving through Cloudflare cannot forge it;
 * pairing it with the shared egress hop separates distinct CF-proxied
 * clients back out again.
 *
 * Why it's still safe for traffic that reaches Caddy directly (bypassing
 * Cloudflare): there, `CF-Connecting-IP` is just another ordinary header a
 * client can set to anything, including rotating it per request. But the
 * rightmost XFF hop in that path is that direct peer's own address as
 * observed by Caddy - unspoofable by the client. Rotating the
 * forged `CF-Connecting-IP` in that scenario only fragments the tuple key
 * *under that one unspoofable hop*; it cannot collide with, or exhaust the
 * budget of, any other source. The login route pairs this tuple limiter with
 * a backstop keyed by `getLoginBackstopKey` below, which re-aggregates by
 * whichever identity is actually unspoofable for the request's topology.
 */
export function getLoginRateLimitKey(request: Request): string {
  const rightmostHop = getClientIp(request);
  const cfConnectingIp = request.headers.get("cf-connecting-ip")?.trim() || "";
  return `${rightmostHop}|cf-connecting-ip=${cfConnectingIp}`;
}

/**
 * Builds the rate-limit key used for the login backstop: a secondary check
 * that re-aggregates by the one identity a single abusive source cannot
 * rotate away from, so it can't escape the tuple limiter above by
 * fragmenting its own key across many distinct tuple values.
 *
 * The identity that's actually unspoofable depends on whether this request
 * genuinely transited Cloudflare, which we can check: `isCloudflareIp`
 * verifies the rightmost XFF hop (the peer our own proxy observed) against
 * Cloudflare's published edge ranges.
 *
 * - When the rightmost hop IS a Cloudflare IP, this request really did come
 *   through Cloudflare, so `CF-Connecting-IP` is Cloudflare-set and
 *   trustworthy as a per-client identity - keying on it alone gives every
 *   distinct real visitor sharing Cloudflare's shared egress hop its own
 *   backstop bucket. This is what fixes the production (Cloudflare -> Caddy)
 *   case: a burst of distinct CF-proxied attacker clients draining their own
 *   tuple budgets can no longer also drain a bucket shared with the
 *   legitimate owner, because they no longer share a bucket at all.
 * - When the rightmost hop is NOT a Cloudflare IP (traffic reaching this
 *   deployment directly, bypassing Cloudflare), `CF-Connecting-IP` is just an
 *   ordinary header the client can set to anything, including a fresh value
 *   per request - trusting it here would let that one source evade the
 *   backstop entirely by rotating it. Falling back to the rightmost hop alone
 *   re-aggregates by that peer's own unspoofable address instead, exactly as
 *   this backstop worked before the Cloudflare-range check existed.
 */
export function getLoginBackstopKey(request: Request): string {
  const rightmostHop = getClientIp(request);
  const cfConnectingIp = request.headers.get("cf-connecting-ip")?.trim() || "";
  if (cfConnectingIp && isCloudflareIp(rightmostHop)) {
    return cfConnectingIp;
  }
  return rightmostHop;
}
