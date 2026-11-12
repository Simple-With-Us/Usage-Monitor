import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import {
  isUsageReadAuthorized,
  resolveUsageReadToken,
} from "@/lib/ingest-auth";
import { fetchServerMetrics } from "@/lib/server-metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `GET /api/server-metrics` — Hetzner host utilization + Coolify app inventory
 * + fleet backup locations (B2 dumps / Litestream / local) for UM · ST · CT.
 *
 * Dual-auth (same as budget-status): dashboard session cookie OR
 * `USAGE_READ_TOKEN` bearer. Middleware excludes this path so the route can
 * self-authenticate bearer clients used by the iOS Client Monitor.
 */
export async function GET(request: NextRequest) {
  const hasDashboardSession = verifySessionToken(
    request.cookies.get(SESSION_COOKIE_NAME)?.value
  );

  if (!hasDashboardSession) {
    if (!resolveUsageReadToken()) {
      return NextResponse.json(
        {
          error:
            "Server metrics are not configured (set USAGE_READ_TOKEN in production)",
        },
        { status: 503 }
      );
    }
    if (!isUsageReadAuthorized(request)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const payload = await fetchServerMetrics();
  return NextResponse.json(payload, {
    headers: {
      "Cache-Control": "private, no-store",
      "x-api-version": "1",
    },
  });
}
