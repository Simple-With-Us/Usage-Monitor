import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { buildContentSecurityPolicy, config, middleware } from "@/middleware";

// The session-cookie middleware only runs on paths its `config.matcher`
// selects. Next.js compiles that matcher (a single negative-lookahead string)
// to decide inclusion; here we reproduce the exclusion semantics the matcher
// encodes — anchor the exported pattern and test membership, exactly the way
// the middleware comment reasons about `(?:/|$)` segment anchoring.
//
// matched === true  -> middleware runs   -> request is session-cookie gated
// matched === false -> middleware skipped -> the route's OWN token check governs
function isSessionGated(pathname: string): boolean {
  expect(config.matcher).toHaveLength(1);
  const pattern = config.matcher[0];
  return new RegExp(`^${pattern}$`).test(pathname);
}

describe("middleware matcher — /api/budget-status exclusion (regression for the prod 401 bug)", () => {
  it("does NOT session-gate /api/budget-status, so the route's own token check runs", () => {
    // Regression: the matcher used to lack this exclusion, so the session gate
    // 401'd every bearer-token request from sibling apps before the route's
    // USAGE_READ_TOKEN/USAGE_INGEST_TOKEN check could authenticate it.
    expect(isSessionGated("/api/budget-status")).toBe(false);
    expect(isSessionGated("/api/budget-status/")).toBe(false);
    expect(isSessionGated("/api/budget-status/anything")).toBe(false);
  });

  it("still session-gates prefix-collision paths (anchoring holds)", () => {
    // `(?:/|$)` anchoring must not leak the exclusion to merely-prefixed paths.
    expect(isSessionGated("/api/budget-status-foo")).toBe(true);
    expect(isSessionGated("/api/budget-statusfoo")).toBe(true);
  });

  it("preserves the existing self-authenticating exclusions", () => {
    for (const p of [
      "/api/ingest",
      "/api/ingest/usage",
      "/api/otlp",
      "/api/otlp/v1/metrics",
      "/api/health",
      "/api/ready",
      "/api/cron",
      "/api/auth/login",
    ]) {
      expect(isSessionGated(p)).toBe(false);
    }
  });

  it("still session-gates ordinary dashboard/API routes and prefix collisions of other exclusions", () => {
    for (const p of [
      "/",
      "/dashboard",
      "/api/providers",
      "/api/budget-status-report", // not the excluded segment
      "/api/ingestor", // prefix of api/ingest, must stay gated
      "/api/healthz", // prefix of api/health, must stay gated
      "/api/readiness", // prefix of api/ready, must stay gated
    ]) {
      expect(isSessionGated(p)).toBe(true);
    }
  });
});

describe("middleware matcher — /api/subscriptions collection-only exclusion (subscription->knob linkage phase 1)", () => {
  it("does NOT session-gate the exact collection path, so the route's own auth (session cookie OR token) governs", () => {
    expect(isSessionGated("/api/subscriptions")).toBe(false);
    expect(isSessionGated("/api/subscriptions/")).toBe(false);
  });

  it("STILL session-gates the [id] sub-route — this is deliberately narrower than the budget-status exclusion", () => {
    // Regression for the "tightly scoped to the collection route ONLY" requirement:
    // PUT/DELETE /api/subscriptions/:id must stay fully session-gated by the
    // middleware (the route itself has no independent auth check), unlike
    // api/budget-status's `(?:/|$)` which deliberately excludes sub-paths too.
    expect(isSessionGated("/api/subscriptions/abc123")).toBe(true);
    expect(isSessionGated("/api/subscriptions/abc123/")).toBe(true);
  });

  it("still session-gates prefix-collision paths (anchoring holds)", () => {
    expect(isSessionGated("/api/subscriptions-foo")).toBe(true);
    expect(isSessionGated("/api/subscriptionsfoo")).toBe(true);
  });
});

describe("middleware CSP", () => {
  it("uses a per-request nonce instead of production script unsafe-inline", () => {
    const policy = buildContentSecurityPolicy("test-nonce", true);
    expect(policy).toContain("script-src 'self' 'nonce-test-nonce' 'strict-dynamic'");
    expect(policy).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(policy).not.toContain("'unsafe-eval'");
    expect(policy).toContain("style-src 'self' 'nonce-test-nonce'");
  });

  it("keeps unsafe-eval limited to local development", () => {
    expect(buildContentSecurityPolicy("test-nonce", false)).toContain("'unsafe-eval'");
  });

  it("forwards the exact response policy so Next can nonce framework scripts", () => {
    const response = middleware(new NextRequest("https://usage.example.test/login"));
    const responsePolicy = response.headers.get("content-security-policy");

    expect(responsePolicy).toBeTruthy();
    expect(response.headers.get("x-middleware-request-content-security-policy")).toBe(
      responsePolicy
    );
    expect(response.headers.get("x-middleware-request-x-nonce")).toBeTruthy();
    expect(response.headers.get("x-middleware-override-headers")?.split(",")).toEqual(
      expect.arrayContaining(["content-security-policy", "x-nonce"])
    );
  });
});
