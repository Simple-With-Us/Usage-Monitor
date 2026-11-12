import { NextRequest, NextResponse } from "next/server";
import {
  DEFAULT_MUSE_CODE_BURN_WINDOW_MINUTES,
  MAX_MUSE_CODE_BURN_WINDOW_MINUTES,
  buildMuseCodeBurnReport,
  loadMuseCodeBurnGroups,
} from "@/lib/muse-code-burn";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import { isUsageReadAuthorized, resolveUsageReadToken } from "@/lib/ingest-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/muse-code-burn?window=90 — Muse Code token burn for a trailing
// window in MINUTES (default 90, 1-240): total tokens, burn rate per hour,
// per-model split, contributor-model tokens/share, and allContributor,
// summed from the token events the CodeCaps app posts as producer
// "muse-code" (metricType "usage", unit "token", keyRef = modelId).
//
// This exists because /api/llm-burn cannot serve the CodeCaps evaluator:
// its window is whole hours (90 minutes is not expressible), its report
// folds per-model groups away, and it is dashboard-session only.  This
// route follows GET /api/agent-model-mix's dual auth instead — dashboard
// session cookie OR the dedicated USAGE_READ_TOKEN bearer.  See
// src/middleware.ts's isPublicPath for the matching exclusion this route
// needs so a bearer request reaches this check instead of 401ing at the
// session gate first.
export async function GET(request: NextRequest) {
  const hasDashboardSession = verifySessionToken(
    request.cookies.get(SESSION_COOKIE_NAME)?.value
  );

  if (!hasDashboardSession) {
    if (!resolveUsageReadToken()) {
      return NextResponse.json(
        {
          error:
            "Muse Code burn is not configured (set USAGE_READ_TOKEN in production)",
        },
        { status: 503 }
      );
    }
    if (!isUsageReadAuthorized(request)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const rawWindow = new URL(request.url).searchParams.get("window");
  const windowMinutes =
    rawWindow === null
      ? DEFAULT_MUSE_CODE_BURN_WINDOW_MINUTES
      : Number(rawWindow);
  if (
    !Number.isInteger(windowMinutes) ||
    windowMinutes < 1 ||
    windowMinutes > MAX_MUSE_CODE_BURN_WINDOW_MINUTES
  ) {
    return NextResponse.json(
      {
        error: `\`window\` must be an integer between 1 and ${MAX_MUSE_CODE_BURN_WINDOW_MINUTES} (minutes)`,
      },
      { status: 400 }
    );
  }

  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - windowMinutes * 60_000);
  // loadMuseCodeBurnGroups fails closed to empty groups on a query error
  // (see its docblock), so no try/catch is needed here — the report then
  // carries zero totals rather than the route 500ing.
  const groups = await loadMuseCodeBurnGroups(windowStart, windowEnd);
  const report = buildMuseCodeBurnReport(groups, {
    windowMinutes,
    windowStart,
    windowEnd,
    generatedAt: windowEnd,
  });

  return NextResponse.json(report, {
    headers: {
      "cache-control": "no-store",
      "x-api-version": "1",
    },
  });
}
