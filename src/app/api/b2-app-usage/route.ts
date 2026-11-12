import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import {
  isUsageReadAuthorized,
  resolveUsageReadToken,
} from "@/lib/ingest-auth";
import { getB2AppUsageBreakdown } from "@/lib/b2-app-usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `GET /api/b2-app-usage` — fleet Backblaze B2 storage + daily download /
 * Class C breakdown across UM · ST · CT (and fleet/other buckets).
 *
 * Dual-auth: dashboard session OR `USAGE_READ_TOKEN` (iOS Client Monitor).
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
            "B2 app usage is not configured (set USAGE_READ_TOKEN in production)",
        },
        { status: 503 }
      );
    }
    if (!isUsageReadAuthorized(request)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    const payload = await getB2AppUsageBreakdown();
    return NextResponse.json(payload, {
      headers: {
        "Cache-Control": "private, no-store",
        "x-api-version": "1",
      },
    });
  } catch {
    return NextResponse.json(
      { configured: false, error: "read_failed" },
      { status: 502 }
    );
  }
}
