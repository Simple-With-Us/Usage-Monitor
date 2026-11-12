import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Auth contract for the two infrastructure read routes the iOS Platforms tab
 * depends on: `GET /api/platform-status` and `GET /api/operations`.
 *
 * Both are listed in `isPublicPath` (src/middleware.ts) so their own bearer
 * check can run at all — which means the handler's dual-auth preamble is the
 * ONLY thing in front of this data.  These tests exist so that removing it
 * fails loudly rather than silently publishing fleet infrastructure status.
 */

const READ_TOKEN = "platform-status-read-token";
const SESSION_PASSWORD = "test-dashboard-password";

let platformStatusGET: typeof import("../route").GET;
let operationsGET: typeof import("../../operations/route").GET;
let createSessionToken: typeof import("@/lib/auth").createSessionToken;
let SESSION_COOKIE_NAME: typeof import("@/lib/auth").SESSION_COOKIE_NAME;

// Neither handler should reach the network in these tests.
vi.mock("@/lib/platform-status/registry", () => ({
  fetchPlatformStatus: vi.fn(async () => ({
    platforms: [],
    summary: { total: 0, configured: 0, healthy: 0, degraded: 0, unconfigured: 0 },
    degraded: false,
    stale: false,
    cacheAgeSeconds: 0,
    fetchedAt: "2026-08-11T00:00:00.000Z",
  })),
}));

vi.mock("@/lib/operations-health", () => ({
  fetchOperationsHealth: vi.fn(async () => ({ fetchedAt: "2026-08-11T00:00:00.000Z" })),
}));

beforeAll(async () => {
  process.env.USAGE_READ_TOKEN = READ_TOKEN;
  process.env.DASHBOARD_PASSWORD = SESSION_PASSWORD;
  process.env.SESSION_SECRET = "test-session-secret";
  delete process.env.USAGE_INGEST_TOKEN;

  ({ GET: platformStatusGET } = await import("../route"));
  ({ GET: operationsGET } = await import("../../operations/route"));
  ({ createSessionToken, SESSION_COOKIE_NAME } = await import("@/lib/auth"));
});

afterAll(() => {
  delete process.env.USAGE_READ_TOKEN;
  delete process.env.DASHBOARD_PASSWORD;
  delete process.env.SESSION_SECRET;
});

function request(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("https://usage.jays.services/api/platform-status", { headers });
}

/**
 * Both handlers share the same auth preamble but resolve different payload
 * types, so the table is typed on the request/response contract they have in
 * common rather than on either concrete handler.
 */
type RouteHandler = (request: NextRequest) => Promise<Response>;

const ROUTES: Array<{ name: string; handler: () => RouteHandler }> = [
  { name: "GET /api/platform-status", handler: () => platformStatusGET },
  { name: "GET /api/operations", handler: () => operationsGET },
];

describe.each(ROUTES)("$name auth", ({ handler }) => {
  it("rejects an anonymous request", async () => {
    const response = await handler()(request());
    expect(response.status).toBe(401);
  });

  it("rejects a wrong bearer token", async () => {
    const response = await handler()(
      request({ authorization: "Bearer not-the-right-token" })
    );
    expect(response.status).toBe(401);
  });

  it("accepts the USAGE_READ_TOKEN bearer", async () => {
    const response = await handler()(request({ authorization: `Bearer ${READ_TOKEN}` }));
    expect(response.status).toBe(200);
  });

  it("accepts a valid dashboard session cookie", async () => {
    const token = createSessionToken();
    const response = await handler()(request({ cookie: `${SESSION_COOKIE_NAME}=${token}` }));
    expect(response.status).toBe(200);
  });

  it("never caches the response in a shared cache", async () => {
    const response = await handler()(request({ authorization: `Bearer ${READ_TOKEN}` }));
    expect(response.headers.get("cache-control")).toContain("private");
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
});

describe("middleware exclusions stay in sync with the handlers", () => {
  it("lists both self-authenticating routes as public paths", async () => {
    const { isPublicPath } = await import("@/middleware");
    // Listed so the handler's own bearer check can run — see the route
    // comments.  If these ever stop being listed, bearer clients 401 at the
    // session gate and the iOS Platforms tab goes dark.
    expect(isPublicPath("/api/platform-status")).toBe(true);
    expect(isPublicPath("/api/operations")).toBe(true);
  });
});
