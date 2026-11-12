import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import {
  isUsageReadAuthorized,
  resolveUsageReadToken,
} from "@/lib/ingest-auth";
import { fetchPlatformStatus } from "@/lib/platform-status/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `GET /api/platform-status` — one status card per external platform the
 * fleet depends on (hosting, edge, storage, observability, developer,
 * messaging, payments, secrets).
 *
 * Companion to `/api/server-metrics`: that route is host-centric (one Hetzner
 * box and its Coolify apps), this one is breadth-first across every platform.
 *
 * Dual-auth (same preamble as budget-status and server-metrics): dashboard
 * session cookie OR `USAGE_READ_TOKEN` bearer. Middleware excludes this path
 * so the route can self-authenticate the bearer clients used by the iOS
 * Client Monitor.
 *
 * Credentials never appear in the response — probes return rendered display
 * strings only, and unconfigured platforms report the env var *names* they
 * would need, never values.
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
            "Platform status is not configured (set USAGE_READ_TOKEN in production)",
        },
        { status: 503 }
      );
    }
    if (!isUsageReadAuthorized(request)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const payload = await fetchPlatformStatus();
  return NextResponse.json(payload, {
    headers: {
      "Cache-Control": "private, no-store",
      "x-api-version": "1",
    },
  });
}
