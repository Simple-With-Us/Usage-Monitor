import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE,
  createSessionToken,
  isSessionAuthConfigured,
  verifyPassword,
} from "@/lib/auth";
import { createRateLimiter, getClientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 5 attempts per IP per minute
const loginRateLimiter = createRateLimiter(60_000, 5);

export async function POST(request: NextRequest) {
  if (!process.env.DASHBOARD_PASSWORD?.trim() || !isSessionAuthConfigured()) {
    return NextResponse.json(
      { error: "Dashboard auth is not configured" },
      { status: 503 }
    );
  }

  const ip = getClientIp(request);
  if (!loginRateLimiter.check(ip)) {
    return NextResponse.json(
      { error: "Too many login attempts. Try again later." },
      { status: 429 }
    );
  }

  let password: unknown;
  try {
    const body = await request.json();
    password = body?.password;
  } catch {
    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  }

  if (typeof password !== "string" || !password || !verifyPassword(password)) {
    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE_NAME, createSessionToken(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
  return response;
}
