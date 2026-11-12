import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import {
  isUsageReadAuthorized,
  resolveUsageReadToken,
} from "@/lib/ingest-auth";
import { fetchOperationsHealth } from "@/lib/operations-health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `GET /api/operations` — fleet operations aggregator (receipt inbox, peer app
 * health, Coolify fleet, R2 free-tier usage, backup layers).
 *
 * Dual-auth (dashboard session cookie OR `USAGE_READ_TOKEN` bearer), matching
 * `/api/server-metrics`. This path is listed in `isPublicPath` so the bearer
 * check below can run at all — middleware would otherwise 401 before the
 * handler executes. That listing makes the auth below load-bearing: it is the
 * only thing standing in front of this data, so it must not be removed.
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
            "Operations health is not configured (set USAGE_READ_TOKEN in production)",
        },
        { status: 503 }
      );
    }
    if (!isUsageReadAuthorized(request)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  return NextResponse.json(await fetchOperationsHealth(), {
    headers: { "Cache-Control": "private, no-store" },
  });
}
