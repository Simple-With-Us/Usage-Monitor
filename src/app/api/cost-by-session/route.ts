import { NextRequest, NextResponse } from "next/server";
import {
  DEFAULT_WINDOW_DAYS,
  MAX_WINDOW_DAYS,
  buildCostBySessionReport,
  loadCostBySessionRows,
  parseSessionIdsParam,
} from "@/lib/cost-by-session";
import { getExternalEventRawCutoff } from "@/lib/data-retention";

export const dynamic = "force-dynamic";

/**
 * GET /api/cost-by-session?ids=a,b,c[&since=ISO][&until=ISO]
 *
 * "Cost per board item": given the Claude Code session id(s) THE BOARD
 * (mac-collab) recorded on a finding via `board claim/status/comment
 * --session`, sums tokens and API-equivalent cost across those sessions from
 * the same ExternalUsageEvent rows the /api/otlp/v1/metrics ingest already
 * writes. See src/lib/cost-by-session.ts for the aggregation and the
 * analytics-only cost caveat.
 *
 * Dashboard-session gated like every other non-ingest route (no middleware
 * exclusion in src/middleware.ts -- same pattern as GET /api/llm-burn).
 *
 * `since`/`until` default to the trailing DEFAULT_WINDOW_DAYS and are capped
 * at MAX_WINDOW_DAYS apart so a stale or typo'd session id can't force a
 * full-table scan; a request wider than that 400s rather than silently
 * clamping, matching /api/export/daily-rollups.
 *
 * The *effective* `since` used for the query is additionally clamped up to
 * the live raw-event retention cutoff (data-retention.ts's
 * getExternalEventRawCutoff): a session older than that horizon has already
 * had its raw rows (and their session.id metadata) rolled up and pruned, so
 * querying past it can only ever find nothing -- reporting it as
 * "unmatched" would misleadingly suggest that session had no claude-code
 * usage at all, rather than "usage too old to still carry a session id".
 * The response's `window.clampedToRawRetention` flags when this happened.
 *
 * When even `until` is before that cutoff, the whole window has aged out
 * (retention deletes rows with occurredAt < cutoff, so a row exactly at the
 * cutoff survives and `until == cutoff` still queries that one instant):
 * clamping would yield a reversed range, so the route skips the query
 * and answers with every id unmatched and `window.expiredBeforeRawRetention`
 * set.  `window.rawRetentionCutoff` is always included.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const parsedIds = parseSessionIdsParam(searchParams);
  if ("error" in parsedIds) {
    return NextResponse.json({ error: parsedIds.error }, { status: 400 });
  }

  const now = new Date();
  const untilParam = searchParams.get("until");
  const sinceParam = searchParams.get("since");

  const until = untilParam ? new Date(untilParam) : now;
  if (Number.isNaN(until.getTime())) {
    return NextResponse.json({ error: "invalid_until" }, { status: 400 });
  }

  const defaultSince = new Date(until.getTime() - DEFAULT_WINDOW_DAYS * 86_400_000);
  const since = sinceParam ? new Date(sinceParam) : defaultSince;
  if (Number.isNaN(since.getTime())) {
    return NextResponse.json({ error: "invalid_since" }, { status: 400 });
  }
  if (since > until) {
    return NextResponse.json({ error: "since_after_until" }, { status: 400 });
  }
  const windowDays = (until.getTime() - since.getTime()) / 86_400_000;
  if (windowDays > MAX_WINDOW_DAYS) {
    return NextResponse.json(
      { error: `window_too_large (max ${MAX_WINDOW_DAYS} days)` },
      { status: 400 }
    );
  }

  const retentionCutoff = getExternalEventRawCutoff(now);
  if (until < retentionCutoff) {
    return NextResponse.json({
      ...buildCostBySessionReport(parsedIds.ids, []),
      window: {
        since: since.toISOString(),
        until: until.toISOString(),
        requestedSince: since.toISOString(),
        clampedToRawRetention: false,
        expiredBeforeRawRetention: true,
        rawRetentionCutoff: retentionCutoff.toISOString(),
      },
    });
  }
  const effectiveSince = since < retentionCutoff ? retentionCutoff : since;

  const rows = await loadCostBySessionRows(parsedIds.ids, effectiveSince, until);
  const report = buildCostBySessionReport(parsedIds.ids, rows);

  return NextResponse.json({
    ...report,
    window: {
      since: effectiveSince.toISOString(),
      until: until.toISOString(),
      requestedSince: since.toISOString(),
      clampedToRawRetention: effectiveSince.getTime() !== since.getTime(),
      expiredBeforeRawRetention: false,
      rawRetentionCutoff: retentionCutoff.toISOString(),
    },
  });
}
