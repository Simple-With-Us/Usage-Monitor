import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE,
  createSessionToken,
  verifyPassword,
} from "@/lib/auth";
import { readBoundedJsonBody } from "@/lib/bounded-request-body";
import {
  createRateLimiter,
  getLoginBackstopKey,
  getLoginRateLimitKey,
} from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Primary per-client limiter: keyed on the (rightmost XFF hop, CF-Connecting-IP)
// tuple via `getLoginRateLimitKey`, not the rightmost XFF hop alone. This
// deployment (usage.jays.services) is always fronted by Cloudflare in front
// of Render, so the rightmost XFF hop Render observes is Cloudflare's own
// egress IP - shared by every Cloudflare-proxied client, not a per-visitor
// address. CF-Connecting-IP is set by Cloudflare itself from the
// TLS-terminated connection and can't be forged by a client going through
// Cloudflare, so pairing it with the shared egress hop separates distinct
// CF-proxied clients back out again. See `getLoginRateLimitKey` in
// rate-limit.ts for the full rationale, including why this stays safe for
// traffic that reaches Render directly.
const loginRateLimiterByTuple = createRateLimiter(60_000, 5);

// Backstop keyed via `getLoginBackstopKey` - NOT an IP-independent global
// bucket, and NOT simply the rightmost XFF hop alone. A single source can
// fragment its own tuple key into many buckets by forging and rotating
// CF-Connecting-IP (see rate-limit.ts), so this backstop needs to
// re-aggregate by the one identity that source cannot spoof - but which
// identity is actually unspoofable depends on whether the request really
// transited Cloudflare. `getLoginBackstopKey` checks the rightmost hop
// against Cloudflare's published IP ranges to decide: for genuine
// Cloudflare-fronted traffic (this deployment's production topology) it
// keys per CF-Connecting-IP, so a burst of distinct CF-proxied clients
// hammering through the same shared Cloudflare egress IP each get their own
// bucket and cannot exhaust one shared pool to deny login to a different
// client, including the legitimate owner. Only for traffic that reaches
// Render directly (bypassing Cloudflare, where CF-Connecting-IP is just an
// ordinary spoofable header) does it fall back to the rightmost hop alone,
// re-aggregating that one peer's attempts regardless of how many tuple keys
// it produced. Same ~20/min budget the old global backstop used.
const loginBackstop = createRateLimiter(60_000, 20);

export async function POST(request: NextRequest) {
  if (!process.env.DASHBOARD_PASSWORD?.trim() || !process.env.SESSION_SECRET?.trim()) {
    return NextResponse.json(
      { error: "Dashboard auth is not configured" },
      { status: 503 }
    );
  }

  const tupleKey = getLoginRateLimitKey(request);
  const backstopKey = getLoginBackstopKey(request);

  // Only check whether budget is available - do NOT consume yet. Consuming
  // happens later, only for attempts that turn out to be failed logins, so a
  // legitimate successful login never eats into the attacker-facing budget.
  const withinTupleLimit = loginRateLimiterByTuple.isAllowed(tupleKey);
  const withinBackstop = loginBackstop.isAllowed(backstopKey);
  if (!withinTupleLimit || !withinBackstop) {
    return NextResponse.json(
      { error: "Too many login attempts. Try again later." },
      { status: 429 }
    );
  }

  let password: unknown;
  try {
    // Bounded because this is the one pre-auth body read in the app: the
    // limiters above deliberately don't consume on isAllowed(), so without a
    // ceiling N concurrent slow POSTs each buffer their whole body before any
    // attempt is ever recorded. 4 KiB is generous for {"password":"..."}.
    // Oversized bodies fall into the catch below, which returns the same
    // uniform 401 AND records the attempt - so a body flood now burns
    // rate-limit budget instead of being free, and adds no response oracle.
    const body = (await readBoundedJsonBody(request, {
      maxBytes: 4096,
      label: "Login payload",
    })) as { password?: unknown } | null;
    password = body?.password;
  } catch {
    loginRateLimiterByTuple.recordAttempt(tupleKey);
    loginBackstop.recordAttempt(backstopKey);
    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  }

  if (typeof password !== "string" || !password || !verifyPassword(password)) {
    // Failed authentication: record the attempt against both budgets.
    loginRateLimiterByTuple.recordAttempt(tupleKey);
    loginBackstop.recordAttempt(backstopKey);
    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  }

  // Successful login: intentionally does not call recordAttempt on either
  // limiter, so the legitimate owner logging in repeatedly never exhausts
  // their own budget.
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
