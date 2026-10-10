import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, isCsrfSafeRequest, verifySessionToken } from "@/lib/auth";
import { sentryConnectSrcOrigins } from "@/lib/sentry-options";
import { datadogConnectSrcOrigins } from "@/lib/datadog-options";

export const config = {
  runtime: "nodejs",
  matcher: [
    // Apply to all routes except Next.js internals and static assets
    "/((?!_next/static|_next/image|favicon\\.ico).*)",
  ],
};

export const isPublicPath = (pathname: string) => {
  // PWA install shell must load without a dashboard session.
  const publicAssetPaths = [
    "/manifest.webmanifest",
    "/sw.js",
  ];
  if (publicAssetPaths.includes(pathname)) return true;
  if (pathname === "/pwa-icon" || pathname.startsWith("/pwa-icon/")) return true;
  // Brand mark used on the public login page (and optional offline shell).
  if (pathname === "/brand" || pathname.startsWith("/brand/")) return true;

  const publicPaths = [
    "/login",
    // App Store Connect + public legal pages (must not require dashboard login).
    "/privacy",
    "/privacy-policy",
    "/support",
    "/api/auth/login",
    "/api/cron",
    "/api/ingest",
    "/api/otlp",
    "/api/apns",
    "/api/settings",
    "/api/budget-status",
    // Self-authenticates (session OR USAGE_READ_TOKEN) for BotFleet skip-model.
    "/api/quota-windows",
    "/api/health",
    "/api/ready",
    // Public OpenRouter money probe for a dedicated UptimeRobot keyword monitor
    // (account credits + per-key limits via management key). See
    // src/app/api/openrouter-credits/route.ts.
    "/api/openrouter-credits",
    // Self-authenticates (session OR USAGE_READ_TOKEN) for iOS Client Monitor
    // host usage + Coolify app inventory. See src/app/api/server-metrics/route.ts.
    "/api/server-metrics",
    // Same dual-auth pattern: per-platform status cards (hosting, edge,
    // storage, observability, developer, messaging, payments, secrets) for the
    // web Platforms page and the iOS Platforms tab.
    // See src/app/api/platform-status/route.ts.
    "/api/platform-status",
    // Fleet operations aggregator (receipt inbox, peer app health, Coolify
    // fleet, R2 free tier, backup layers). Read-only infrastructure status in
    // the same class as server-metrics, exposed to the iOS client via the same
    // dual-auth preamble. See src/app/api/operations/route.ts.
    "/api/operations",
    // Agents overview aggregator (live agent runs, token counts, quota burn,
    // API-equivalent cost comparison). Self-authenticates via session or USAGE_READ_TOKEN.
    "/api/agents-overview",
    // Owner-recorded expense ledger. GET self-authenticates via dashboard
    // session or USAGE_READ_TOKEN (expenses dashboard sync); POST keeps its
    // own session/OWNER_EXPENSE_TOKEN check in the route.
    // See src/app/api/owner-expenses/route.ts.
    "/api/owner-expenses",    // Remaining-quota windows for BotFleet skip-model. Same dual-auth as
    // budget-status / agents-overview.
    "/api/quota-windows",
    // Unlisted Apple Calendar subscribe URL; the route checks BILLS_CALENDAR_TOKEN.
    "/api/bills.ics",
    // Public RUM/browser-log config.  Returns only public intake fields.
    "/api/datadog-public-config",
  ];
  if (publicPaths.includes(pathname)) return true;
  if (publicPaths.some((p) => pathname.startsWith(p + "/"))) return true;
  if (pathname === "/api/subscriptions" || pathname === "/api/subscriptions/") return true;
  // Self-authenticates via isUsageReadAuthorized (same pattern as the
  // subscriptions collection exclusion above) — without this, bearer read
  // tokens 401 at the session gate before the route's own auth runs.
  if (pathname === "/api/export/daily-rollups" || pathname === "/api/export/daily-rollups/") return true;
  if (pathname === "/api/workspace/export" || pathname === "/api/workspace/export/") return true;
  // Self-authenticates via isUsageReadAuthorized (same pattern as the
  // daily-rollups exclusion above) — without this, bearer read tokens 401 at
  // the session gate before the route's own auth runs.
  if (pathname === "/api/agent-model-mix" || pathname === "/api/agent-model-mix/") return true;
  return false;
};

/**
 * Build the Content-Security-Policy header value.
 *
 * Important: do NOT use 'strict-dynamic' unless every framework script tag is
 * nonced. With 'strict-dynamic', browsers ignore host allowlists like 'self',
 * so un-nonced Next.js chunk <script src="/_next/static/..."> tags are blocked
 * and the UI renders as a blank page (observed on usage.jays.services login).
 *
 * - script-src: 'self' allows same-origin Next chunks; nonce covers inline
 *   boot scripts (density / next-themes) that read x-nonce in the root layout.
 * - style-src: 'unsafe-inline' is required for next-themes / CSS-in-JS style
 *   attributes that cannot take a nonce in this app today.
 */
export function buildContentSecurityPolicy(
  nonce: string,
  isProduction: boolean,
  extraConnectSrc: readonly string[] = []
): string {
  const connectSrc = ["'self'", ...extraConnectSrc].join(" ");
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'${isProduction ? "" : " 'unsafe-eval'"}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connectSrc}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(isProduction ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

export function middleware(request: NextRequest) {
  // Generate a nonce for inline scripts that the root layout attaches.
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");

  const isProduction = process.env.NODE_ENV === "production";
  const cspHeader = buildContentSecurityPolicy(
    nonce,
    isProduction,
    [...datadogConnectSrcOrigins(), ...sentryConnectSrcOrigins()]
  );

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  // Next.js reads CSP from the request to optionally nonce framework scripts.
  requestHeaders.set("Content-Security-Policy", cspHeader);

  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const isAuthenticated = verifySessionToken(token);

  let response: NextResponse;
  // CSRF choke point. Gated on `token &&` so only ambient-cookie authority is
  // covered: token-authed clients (chrome extension -> /api/ingest/usage, OTLP
  // collectors, cron, the bearer readers) carry no cookie and are untouched,
  // and POST /api/auth/login has no cookie yet so login still works. It runs
  // before the isPublicPath branch so it still covers the cookie-gated
  // /api/subscriptions collection POST, which isPublicPath marks public.
  if (token && !isCsrfSafeRequest(request)) {
    response = NextResponse.json(
      { error: "Cross-origin request rejected" },
      { status: 403, headers: requestHeaders }
    );
  } else if (isAuthenticated || isPublicPath(request.nextUrl.pathname)) {
    response = NextResponse.next({
      request: {
        headers: requestHeaders,
      },
    });
  } else {
    if (request.nextUrl.pathname.startsWith("/api/")) {
      response = NextResponse.json(
        { error: "Unauthorized" },
        { status: 401, headers: requestHeaders }
      );
    } else {
      const loginUrl = new URL("/login", request.url);
      loginUrl.searchParams.set("next", request.nextUrl.pathname);
      response = NextResponse.redirect(loginUrl, { headers: requestHeaders });
    }
  }

  response.headers.set("Content-Security-Policy", cspHeader);
  return response;
}
