import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { buildContentSecurityPolicy, config, isPublicPath, middleware } from "@/middleware";
import { SESSION_COOKIE_NAME, createSessionToken } from "@/lib/auth";

// The session-cookie middleware runs on almost all paths now to enforce CSP nonces,
// but it uses isPublicPath internally to determine if the route should be session-gated.
//
// isPublicPath === false -> request is session-cookie gated
// isPublicPath === true  -> the route's OWN token check governs
function isSessionGated(pathname: string): boolean {
  return !isPublicPath(pathname);
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
      "/api/openrouter-credits",
      "/api/server-metrics",
      "/api/b2-app-usage",
      "/api/cron",
      "/api/auth/login",
      "/api/bills.ics",
      "/api/datadog-public-config",
      "/api/quota-windows",
      "/api/agents-overview",
      "/api/agent-turns",
      // App Store Connect privacy/support URLs (public legal pages)
      "/privacy",
      "/privacy-policy",
      "/support",
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

describe("CSP build (blank-page regression)", () => {
  it("does not use strict-dynamic so same-origin Next chunks can load without per-tag nonces", () => {
    const csp = buildContentSecurityPolicy("testnonce", true);
    expect(csp).toContain("script-src 'self' 'nonce-testnonce'");
    expect(csp).not.toContain("strict-dynamic");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("upgrade-insecure-requests");
  });

  it("allows unsafe-eval only outside production (Next dev)", () => {
    expect(buildContentSecurityPolicy("n", false)).toContain("'unsafe-eval'");
    expect(buildContentSecurityPolicy("n", true)).not.toContain("'unsafe-eval'");
  });

  it("adds Datadog US5 RUM intake to connect-src only when supplied", () => {
    const withoutRum = buildContentSecurityPolicy("n", true);
    expect(withoutRum).toContain("connect-src 'self'");
    expect(withoutRum).not.toContain("browser-intake");
    const withRum = buildContentSecurityPolicy("n", true, [
      "https://browser-intake-us5-datadoghq.com",
    ]);
    expect(withRum).toContain(
      "connect-src 'self' https://browser-intake-us5-datadoghq.com"
    );
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

describe("middleware matcher — /api/export/daily-rollups exclusion (bearer read-token access)", () => {
  it("does NOT session-gate the exact collection path, so the route's own auth (session cookie OR read token) governs", () => {
    // Same pattern as /api/subscriptions: the route self-authenticates via
    // isUsageReadAuthorized; without the exclusion, bearer tokens 401 here.
    expect(isSessionGated("/api/export/daily-rollups")).toBe(false);
    expect(isSessionGated("/api/export/daily-rollups/")).toBe(false);
  });

  it("still session-gates other export paths and prefix collisions (anchoring holds)", () => {
    expect(isSessionGated("/api/export")).toBe(true);
    expect(isSessionGated("/api/export/other")).toBe(true);
    expect(isSessionGated("/api/export/daily-rollups-foo")).toBe(true);
    expect(isSessionGated("/api/export/daily-rollupsfoo")).toBe(true);
  });
});

describe("middleware matcher — /api/workspace/export exclusion (bearer read-token access)", () => {
  it("does NOT session-gate the exact export path", () => {
    expect(isSessionGated("/api/workspace/export")).toBe(false);
    expect(isSessionGated("/api/workspace/export/")).toBe(false);
  });

  it("still session-gates workspace import", () => {
    expect(isSessionGated("/api/workspace/import")).toBe(true);
  });
});

describe("middleware public install assets", () => {
  it("serves the PWA shell without a dashboard session", () => {
    for (const path of [
      "/manifest.webmanifest",
      "/sw.js",
      "/pwa-icon/192",
      "/pwa-icon/512",
      "/brand/icon-64.png",
      "/brand/icon-192.png",
    ]) {
      expect(isSessionGated(path)).toBe(false);
    }
  });

  it("does not make similarly prefixed paths public", () => {
    expect(isSessionGated("/manifest.webmanifest.backup")).toBe(true);
    expect(isSessionGated("/sw.js.map")).toBe(true);
    expect(isSessionGated("/pwa-icons/192")).toBe(true);
    expect(isSessionGated("/branded/icon.png")).toBe(true);
  });
});

describe("middleware CSRF choke point (cookie-authenticated mutators only)", () => {
  const ORIGINAL_SESSION_SECRET = process.env.SESSION_SECRET;
  const HOST = "usage.jays.services";

  beforeEach(() => {
    process.env.SESSION_SECRET = "middleware-csrf-test-secret";
  });

  afterEach(() => {
    if (ORIGINAL_SESSION_SECRET === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = ORIGINAL_SESSION_SECRET;
  });

  function mutatorRequest(
    path: string,
    headers: Record<string, string>,
    { withSession = true, method = "POST" }: { withSession?: boolean; method?: string } = {}
  ): NextRequest {
    return new NextRequest(`https://${HOST}${path}`, {
      method,
      headers: {
        host: HOST,
        ...(withSession
          ? { cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}` }
          : {}),
        ...headers,
      },
    });
  }

  function expectPassedThrough(response: Response) {
    // NextResponse.next() marks the response so the request continues to the
    // route handler; a 403 CSRF rejection never carries this marker.
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  }

  it("allows a same-origin session-cookie POST", () => {
    const response = middleware(
      mutatorRequest("/api/providers", {
        origin: `https://${HOST}`,
        "sec-fetch-site": "same-origin",
      })
    );
    expectPassedThrough(response);
  });

  it("403s a sibling-subdomain (same-site) POST carrying the session cookie", async () => {
    // SameSite=Lax does NOT block this: a sibling *.jays.services origin is
    // same-SITE, so the browser attaches the cookie to its cross-origin POST.
    const response = middleware(
      mutatorRequest("/api/providers", {
        origin: "https://evil.jays.services",
        "sec-fetch-site": "same-site",
      })
    );
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("Cross-origin request rejected");
  });

  it("403s a cookie-carrying cross-origin POST even to a public (self-authenticating) path", () => {
    // The CSRF check runs BEFORE the isPublicPath branch: the cookie-gated
    // POST /api/subscriptions collection route is marked public for GET's
    // token auth, but a cross-site cookie POST must still be rejected.
    const response = middleware(
      mutatorRequest("/api/subscriptions", {
        origin: "https://evil.jays.services",
        "sec-fetch-site": "same-site",
      })
    );
    expect(response.status).toBe(403);
  });

  it("allows a cross-origin GET with the session cookie (safe method)", () => {
    const response = middleware(
      mutatorRequest(
        "/api/providers",
        { origin: "https://evil.jays.services", "sec-fetch-site": "same-site" },
        { method: "GET" }
      )
    );
    expectPassedThrough(response);
  });

  it("leaves cookieless token clients untouched, even with a cross-site Origin", () => {
    // Chrome extension / OTLP collectors / bearer readers authenticate with
    // headers, not the ambient cookie — the CSRF gate must not apply to them.
    const response = middleware(
      mutatorRequest(
        "/api/ingest/usage",
        {
          origin: "chrome-extension://abcdefghijklmnop",
          "sec-fetch-site": "cross-site",
        },
        { withSession: false }
      )
    );
    expectPassedThrough(response);
  });

  it("leaves the cookieless login POST untouched", () => {
    // No session cookie exists yet at login time, so the CSRF gate (scoped to
    // ambient-cookie authority) must not interfere.
    const response = middleware(
      mutatorRequest(
        "/api/auth/login",
        { origin: `https://${HOST}` },
        { withSession: false }
      )
    );
    expectPassedThrough(response);
  });

  it("allows a header-absent session-cookie POST (iOS URLSession client)", () => {
    const response = middleware(mutatorRequest("/api/providers", {}));
    expectPassedThrough(response);
  });
});
