import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth";

export const config = {
  runtime: "nodejs",
  matcher: [
    // Apply to all routes except Next.js internals and static assets
    "/((?!_next/static|_next/image|favicon\\.ico).*)",
  ],
};

export const isPublicPath = (pathname: string) => {
  const publicPaths = [
    "/login",
    "/api/auth/login",
    "/api/cron",
    "/api/ingest",
    "/api/otlp",
    "/api/budget-status",
    "/api/health",
    "/api/ready",
  ];
  if (publicPaths.includes(pathname)) return true;
  if (publicPaths.some((p) => pathname.startsWith(p + "/"))) return true;
  if (pathname === "/api/subscriptions" || pathname === "/api/subscriptions/") return true;
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
  isProduction: boolean
): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'${isProduction ? "" : " 'unsafe-eval'"}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
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
  const cspHeader = buildContentSecurityPolicy(nonce, isProduction);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  // Next.js reads CSP from the request to optionally nonce framework scripts.
  requestHeaders.set("Content-Security-Policy", cspHeader);

  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const isAuthenticated = verifySessionToken(token);

  let response: NextResponse;
  if (isAuthenticated || isPublicPath(request.nextUrl.pathname)) {
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
