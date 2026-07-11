import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth";

export function buildContentSecurityPolicy(
  nonce: string,
  production = process.env.NODE_ENV === "production"
): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${
      production ? "" : " 'unsafe-eval'"
    }`,
    `style-src 'self' 'nonce-${nonce}'`,
    // Recharts and a small number of dynamic progress indicators still use
    // style attributes. Scope this exception to attributes; inline <style>
    // elements require the per-request nonce above.
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(production ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

function nextWithNonce(request: NextRequest): NextResponse {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const contentSecurityPolicy = buildContentSecurityPolicy(nonce);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  // Next.js reads the nonce from the CSP request header while rendering its
  // framework scripts. Forward the exact policy returned to the browser so
  // every generated script receives the nonce that the response enforces.
  requestHeaders.set("Content-Security-Policy", contentSecurityPolicy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", contentSecurityPolicy);
  return response;
}

export const config = {
  runtime: "nodejs",
  matcher: [
    // Exclusions are anchored to full path segments (via `(?:/|$)`) so that
    // routes merely *prefixed* with an excluded name (e.g. /api/crontab,
    // /api/ingestor, /loginpage) are NOT accidentally left unauthenticated.
    // api/otlp is excluded for the same reason as api/ingest: both routes
    // authenticate pushed telemetry with their own Bearer USAGE_INGEST_TOKEN
    // check (see src/lib/ingest-auth.ts), not the dashboard session cookie —
    // an OTLP exporter (Claude Code) has no way to obtain that cookie.
    // api/budget-status is excluded for the same reason: it authenticates its
    // own Bearer/x-usage-ingest-token check (USAGE_READ_TOKEN, falling back to
    // USAGE_INGEST_TOKEN — see src/app/api/budget-status/route.ts) so sibling
    // apps can poll spend before an LLM call. Such a caller has no session
    // cookie, so leaving this in the matcher 401'd every request before the
    // route's own token check ever ran.
    // api/subscriptions is excluded ONLY for the exact collection path
    // (`api/subscriptions` or `api/subscriptions/`, via `/?$` anchored to end
    // of string — deliberately NOT `(?:/|$)`, which would also swallow
    // sub-paths). GET on the collection route self-authenticates with either
    // the dashboard session cookie or isUsageReadAuthorized (same
    // USAGE_READ_TOKEN/USAGE_INGEST_TOKEN pattern as budget-status) so a
    // headless sibling app can read subscriptions/knobEnv; POST stays
    // session-cookie-only inside the route itself. The `/api/subscriptions/
    // [id]` PUT/DELETE routes are NOT matched by this exclusion (they don't
    // end the string right after the collection segment) and so stay fully
    // session-gated by this middleware, as they always were.
    "/((?!_next/static|_next/image|favicon\\.ico|api/auth/login(?:/|$)|api/cron(?:/|$)|api/ingest(?:/|$)|api/otlp(?:/|$)|api/budget-status(?:/|$)|api/subscriptions/?$|api/health(?:/|$)|api/ready(?:/|$)).*)",
  ],
};

export function middleware(request: NextRequest) {
  if (
    request.nextUrl.pathname === "/login" ||
    request.nextUrl.pathname.startsWith("/login/")
  ) {
    return nextWithNonce(request);
  }
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (verifySessionToken(token)) {
    return nextWithNonce(request);
  }
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("next", request.nextUrl.pathname);
  return NextResponse.redirect(loginUrl);
}
