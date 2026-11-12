import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import {
  isUsageReadAuthorized,
  resolveUsageReadToken,
} from "@/lib/ingest-auth";
import { getLatestMacHealth } from "@/lib/mac-health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `GET /api/health/mac` — latest Mac heartbeat (CPU, memory, disk, launchd flags).
 *
 * Dual-auth (dashboard session cookie OR `USAGE_READ_TOKEN` bearer), matching
 * `/api/operations` and `/api/server-metrics`.
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
            "Mac health is not configured (set USAGE_READ_TOKEN in production)",
        },
        { status: 503 }
      );
    }
    if (!isUsageReadAuthorized(request)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const health = await getLatestMacHealth();
  return NextResponse.json(health, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

