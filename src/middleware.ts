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
  const publicAssetPaths = [
    "/manifest.webmanifest",
    "/sw.js",
  ];
  if (publicAssetPaths.includes(pathname)) return true;
  if (pathname === "/pwa-icon" || pathname.startsWith("/pwa-icon/")) return true;

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

export function middleware(request: NextRequest) {
  // Generate a nonce for inline scripts and styles
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");

  const isProduction = process.env.NODE_ENV === "production";
  const cspHeader = `
    default-src 'self';
    script-src 'self' 'nonce-${nonce}' 'strict-dynamic' ${isProduction ? "" : "'unsafe-eval'"};
    style-src 'self' 'nonce-${nonce}';
    img-src 'self' data: blob:;
    font-src 'self' data:;
    connect-src 'self';
    object-src 'none';
    base-uri 'self';
    form-action 'self';
    frame-ancestors 'none';
    ${isProduction ? "upgrade-insecure-requests;" : ""}
  `
    .replace(/\s{2,}/g, " ")
    .trim();

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
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
