import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken, SESSION_COOKIE_NAME } from "@/lib/auth";
import { isUsageReadAuthorized } from "@/lib/ingest-auth";
import { getAiRequestPerformance } from "@/lib/ai-request-performance";

export const dynamic = "force-dynamic";

/**
 * GET /api/ai-requests/performance?days=7
 *
 * Per harness and model: request count, p50/p95 duration and TTFT, p50
 * output tokens per second, cache-hit ratio, token sums and the harness's
 * PAYG-equivalent cost estimate, from AiRequest (UM-1590).  Dual-auth like
 * /api/agent-turns: dashboard session cookie OR bearer USAGE_READ_TOKEN.
 */
export async function GET(request: NextRequest) {
  const sessionCookie = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const isSessionAuth = sessionCookie ? verifySessionToken(sessionCookie) : false;
  if (!isSessionAuth && !isUsageReadAuthorized(request)) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized. Connect a valid dashboard session or USAGE_READ_TOKEN." },
      { status: 401 }
    );
  }

  const daysRaw = Number(new URL(request.url).searchParams.get("days") ?? "7");
  const days = Number.isFinite(daysRaw) ? Math.min(Math.max(Math.trunc(daysRaw), 1), 90) : 7;

  try {
    return NextResponse.json(await getAiRequestPerformance(days));
  } catch (error) {
    console.error("[ai-requests/performance] failed:", error);
    return NextResponse.json({ ok: false, error: "Failed to summarize AI requests" }, { status: 500 });
  }
}
