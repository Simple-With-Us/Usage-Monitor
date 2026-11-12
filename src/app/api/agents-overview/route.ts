import { NextRequest, NextResponse } from "next/server";
import { computeAgentsOverview } from "@/lib/agents-overview";
import { verifySessionToken, SESSION_COOKIE_NAME } from "@/lib/auth";
import { isUsageReadAuthorized } from "@/lib/ingest-auth";

export const dynamic = "force-dynamic";

/**
 * GET /api/agents-overview?window=30d (clients use fixed 30d; 5h|24h|7d|all still accepted)
 *
 * Dual-auth endpoint:
 * 1. Dashboard session cookie (SESSION_COOKIE_NAME)
 * 2. Bearer USAGE_READ_TOKEN via Authorization header
 */
export async function GET(request: NextRequest) {
  const sessionCookie = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const isSessionAuth = sessionCookie ? verifySessionToken(sessionCookie) : false;
  const isTokenAuth = isUsageReadAuthorized(request);

  if (!isSessionAuth && !isTokenAuth) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized. Connect a valid dashboard session or USAGE_READ_TOKEN." },
      { status: 401 }
    );
  }

  const { searchParams } = new URL(request.url);
  const windowParam = (searchParams.get("window") || "30d").toLowerCase();

  let windowDays = 30;
  if (windowParam === "5h") {
    windowDays = 0.2083; // 5 hours in days
  } else if (windowParam === "24h" || windowParam === "1d") {
    windowDays = 1;
  } else if (windowParam === "7d") {
    windowDays = 7;
  } else if (windowParam === "30d") {
    windowDays = 30;
  } else if (windowParam === "all") {
    windowDays = 3650;
  }

  try {
    const data = await computeAgentsOverview(windowDays);
    return NextResponse.json(data);
  } catch (error) {
    console.error("[agents-overview] failed to compute overview:", error);
    return NextResponse.json(
      { ok: false, error: "Failed to compute agents overview" },
      { status: 500 }
    );
  }
}
