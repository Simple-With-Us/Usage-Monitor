import { NextRequest, NextResponse } from "next/server";
import { buildAgentModelMixReport, loadAgentModelMixRows } from "@/lib/agent-model-mix";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import { isUsageReadAuthorized, resolveUsageReadToken } from "@/lib/ingest-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/agent-model-mix?days=7 — fleet-wide (every sourceApp, not one
// producer) rollup of ExternalUsageEvent token/cost/event volume grouped by
// sourceApp x provider x model x seat x project over a trailing window.
// Built for the weekly "fleet-mode compliance digest" script (a sibling
// repo) to poll.
//
// Auth: dashboard session cookie OR the dedicated USAGE_READ_TOKEN bearer
// (isUsageReadAuthorized, with the documented non-production/break-glass
// ingest-token fallback) — the exact dual-auth pattern GET /api/budget-status
// uses.  See src/middleware.ts's isPublicPath for the matching exclusion this
// route needs so a bearer request reaches this check instead of 401ing at
// the session gate first.
//
// Window: `days` (default 7, 1-90 inclusive) is the primary interface.  An
// optional `since`/`until` ISO pair overrides it for ad hoc ranges.
const DEFAULT_WINDOW_DAYS = 7;
const MAX_WINDOW_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

export async function GET(request: NextRequest) {
  const hasDashboardSession = verifySessionToken(
    request.cookies.get(SESSION_COOKIE_NAME)?.value
  );

  if (!hasDashboardSession) {
    if (!resolveUsageReadToken()) {
      return NextResponse.json(
        {
          error:
            "Agent model mix is not configured (set USAGE_READ_TOKEN in production)",
        },
        { status: 503 }
      );
    }
    if (!isUsageReadAuthorized(request)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const params = new URL(request.url).searchParams;
  const sinceParam = params.get("since");
  const untilParam = params.get("until");
  const now = new Date();

  let windowStart: Date;
  let windowEnd: Date;
  let days: number;

  if (sinceParam || untilParam) {
    if (!sinceParam || !untilParam) {
      return badRequest("Both `since` and `until` are required when either is set");
    }
    const since = new Date(sinceParam);
    const until = new Date(untilParam);
    if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime())) {
      return badRequest("`since` and `until` must be valid ISO 8601 timestamps");
    }
    if (until.getTime() <= since.getTime()) {
      return badRequest("`until` must be after `since`");
    }
    windowStart = since;
    windowEnd = until;
    days = Math.round(((until.getTime() - since.getTime()) / DAY_MS) * 100) / 100;
  } else {
    const rawDays = params.get("days");
    days = rawDays === null ? DEFAULT_WINDOW_DAYS : Number(rawDays);
    if (!Number.isInteger(days) || days < 1 || days > MAX_WINDOW_DAYS) {
      return badRequest(`\`days\` must be an integer between 1 and ${MAX_WINDOW_DAYS}`);
    }
    windowEnd = now;
    windowStart = new Date(windowEnd.getTime() - days * DAY_MS);
  }

  // loadAgentModelMixRows fails closed to [] on a query error (see its
  // docblock) rather than throwing, so no try/catch is needed here -- the
  // same fail-closed convention loadAnalyticsTokenRows uses in
  // external-usage-events.ts.  (Unlike this route, GET /api/cost-by-session
  // has no such contract: loadCostBySessionRows has no try/catch of its own
  // and a query error there propagates as a 500 -- see the TOTAL() fix note
  // in cost-by-session.ts for a bug that used to make that likelier.)
  const rows = await loadAgentModelMixRows(windowStart, windowEnd);
  const report = buildAgentModelMixReport(rows, windowStart, windowEnd, days, now);

  return NextResponse.json(report, {
    headers: {
      "cache-control": "no-store",
      "x-api-version": "1",
    },
  });
}
