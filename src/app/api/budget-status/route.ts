import { NextRequest, NextResponse } from "next/server";
import { computeProjectBudgetStatus } from "@/lib/budget-status";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import { isUsageReadAuthorized, resolveUsageReadToken } from "@/lib/ingest-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read token: dedicated USAGE_READ_TOKEN preferred; ingest fallback only outside
// production (or when USAGE_READ_TOKEN_ALLOW_INGEST_FALLBACK=true). See C10.
export async function GET(request: NextRequest) {
  const hasDashboardSession = verifySessionToken(
    request.cookies.get(SESSION_COOKIE_NAME)?.value
  );

  // Native clients can authenticate once with the dashboard password and use
  // the same HttpOnly session as the web UI. Headless/read-only clients retain
  // the dedicated bearer-token path. The endpoint stays public in middleware
  // so it can continue self-authenticating both credential types here.
  if (!hasDashboardSession) {
    if (!resolveUsageReadToken()) {
      return NextResponse.json(
        {
          error:
            "Budget status is not configured (set USAGE_READ_TOKEN in production)",
        },
        { status: 503 }
      );
    }
    if (!isUsageReadAuthorized(request)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const status = await computeProjectBudgetStatus();
  const generatedAt = status.generatedAt;
  const generatedMs = Date.parse(generatedAt);
  const ageSeconds =
    Number.isFinite(generatedMs) && generatedMs > 0
      ? Math.max(0, Math.floor((Date.now() - generatedMs) / 1000))
      : null;
  return NextResponse.json(status, {
    headers: {
      "cache-control": "no-store",
      // Wave F / E7: throttle consumers can prefer fresh snapshots without
      // parsing the full body, and can back off when Age is high.
      "x-budget-generated-at": generatedAt,
      ...(ageSeconds != null ? { age: String(ageSeconds) } : {}),
    },
  });
}
