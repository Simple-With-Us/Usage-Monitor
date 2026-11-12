import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { hasValidDashboardSession } from "@/lib/auth";
import { isUsageReadAuthorized } from "@/lib/ingest-auth";

export const dynamic = "force-dynamic";

// GET /api/export/daily-rollups — bounded export of the
// ExternalUsageEventDailyRollup table (the same durable, per-day cost/usage
// aggregate the budget views and retention rollups are built from) as JSON
// (default) or CSV (`?format=csv`).
//
// Auth: dashboard session cookie OR the usage read token
// (`isUsageReadAuthorized` — USAGE_READ_TOKEN with the documented ingest
// fallback), matching GET /api/budget-status and GET /api/subscriptions.
// NOTE: like `/api/subscriptions`, this route self-authenticates; bearer-token
// access additionally requires the collection path to be excluded from the
// dashboard-session middleware (src/middleware.ts's isPublicPath). Dashboard
// session access works without that exclusion.
//
// Window: `from`/`to` are inclusive UTC calendar days (YYYY-MM-DD). Defaults
// to the last 30 UTC days; windows longer than MAX_WINDOW_DAYS are rejected
// (400) rather than silently clamped. Rows are capped at MAX_ROWS.

const DEFAULT_WINDOW_DAYS = 30;
const MAX_WINDOW_DAYS = 92;
const MAX_ROWS = 10_000;

const DAY_PARAM = /^\d{4}-\d{2}-\d{2}$/;

function parseDay(raw: string): Date | null {
  if (!DAY_PARAM.test(raw)) return null;
  const [year, month, day] = raw.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  // Reject non-existent calendar days (e.g. 2026-02-31 rolls into March).
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

function formatDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// CSV cells that begin with a formula-trigger character are prefixed with a
// apostrophe so opening the export in a spreadsheet cannot execute text
// stored in group keys or labels.
function csvCell(value: string | number | null): string {
  if (value === null) return "";
  let text = String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  if (/[",\n\r]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

const CSV_COLUMNS: Array<{
  header: string;
  value: (row: Record<string, unknown>) => string | number | null;
}> = [
  { header: "day", value: (r) => r.day as string },
  { header: "groupKey", value: (r) => r.groupKey as string },
  { header: "sourceApp", value: (r) => r.sourceApp as string },
  { header: "environment", value: (r) => r.environment as string | null },
  { header: "provider", value: (r) => r.provider as string },
  { header: "service", value: (r) => r.service as string | null },
  { header: "label", value: (r) => r.label as string | null },
  { header: "keyRef", value: (r) => r.keyRef as string | null },
  { header: "billingMode", value: (r) => r.billingMode as string },
  { header: "metricType", value: (r) => r.metricType as string },
  { header: "unit", value: (r) => r.unit as string | null },
  { header: "limitWindow", value: (r) => r.limitWindow as string | null },
  { header: "tier", value: (r) => r.tier as string | null },
  { header: "confidence", value: (r) => r.confidence as string },
  { header: "projectId", value: (r) => r.projectId as string | null },
  { header: "eventCount", value: (r) => r.eventCount as number },
  { header: "pricedEventCount", value: (r) => r.pricedEventCount as number | null },
  { header: "unpricedEventCount", value: (r) => r.unpricedEventCount as number | null },
  {
    header: "unclassifiedCostEventCount",
    value: (r) => r.unclassifiedCostEventCount as number | null,
  },
  { header: "totalCostUsd", value: (r) => r.totalCostUsd as number },
  { header: "totalRequests", value: (r) => r.totalRequests as number },
  { header: "totalQuantity", value: (r) => r.totalQuantity as number },
  { header: "totalCredits", value: (r) => r.totalCredits as number },
  { header: "maxLimit", value: (r) => r.maxLimit as number | null },
  { header: "latestOccurredAt", value: (r) => r.latestOccurredAt as string },
];

export async function GET(request: NextRequest) {
  if (!hasValidDashboardSession(request) && !isUsageReadAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = new URL(request.url).searchParams;

  const format = params.get("format") ?? "json";
  if (format !== "json" && format !== "csv") {
    return NextResponse.json(
      { error: 'Invalid "format" — expected "json" or "csv"' },
      { status: 400 }
    );
  }

  // Defaults: the last DEFAULT_WINDOW_DAYS UTC days, inclusive.
  const todayUtc = new Date();
  todayUtc.setUTCHours(0, 0, 0, 0);
  const defaultTo = todayUtc;
  const defaultFrom = new Date(
    defaultTo.getTime() - (DEFAULT_WINDOW_DAYS - 1) * 86_400_000
  );

  const fromRaw = params.get("from");
  const toRaw = params.get("to");
  const from = fromRaw ? parseDay(fromRaw) : defaultFrom;
  const to = toRaw ? parseDay(toRaw) : defaultTo;
  if (!from) {
    return NextResponse.json(
      { error: 'Invalid "from" — expected a real UTC day as YYYY-MM-DD' },
      { status: 400 }
    );
  }
  if (!to) {
    return NextResponse.json(
      { error: 'Invalid "to" — expected a real UTC day as YYYY-MM-DD' },
      { status: 400 }
    );
  }
  if (from.getTime() > to.getTime()) {
    return NextResponse.json(
      { error: '"from" must be on or before "to"' },
      { status: 400 }
    );
  }
  const windowDays = (to.getTime() - from.getTime()) / 86_400_000 + 1;
  if (windowDays > MAX_WINDOW_DAYS) {
    return NextResponse.json(
      { error: `Date window too large — maximum ${MAX_WINDOW_DAYS} days` },
      { status: 400 }
    );
  }

  try {
    // `to` is an inclusive calendar day; the rollup `day` column is stored at
    // UTC midnight, so bound exclusively on the next day.
    const toExclusive = new Date(to.getTime() + 86_400_000);
    const rows = await prisma.externalUsageEventDailyRollup.findMany({
      where: { day: { gte: from, lt: toExclusive } },
      orderBy: [{ day: "asc" }, { groupKey: "asc" }],
      take: MAX_ROWS + 1,
    });
    const truncated = rows.length > MAX_ROWS;
    const page = truncated ? rows.slice(0, MAX_ROWS) : rows;

    const serialized = page.map((row) => ({
      day: formatDay(row.day),
      groupKey: row.groupKey,
      sourceApp: row.sourceApp,
      environment: row.environment,
      provider: row.provider,
      service: row.service,
      label: row.label,
      keyRef: row.keyRef,
      billingMode: row.billingMode,
      metricType: row.metricType,
      unit: row.unit,
      limitWindow: row.limitWindow,
      tier: row.tier,
      confidence: row.confidence,
      projectId: row.projectId,
      eventCount: row.eventCount,
      pricedEventCount: row.pricedEventCount,
      unpricedEventCount: row.unpricedEventCount,
      unclassifiedCostEventCount: row.unclassifiedCostEventCount,
      totalCostUsd: row.totalCostUsd,
      totalRequests: row.totalRequests,
      totalQuantity: row.totalQuantity,
      totalCredits: row.totalCredits,
      maxLimit: row.maxLimit,
      latestOccurredAt: row.latestOccurredAt.toISOString(),
    }));

    if (format === "csv") {
      const lines = [
        CSV_COLUMNS.map((c) => c.header).join(","),
        ...serialized.map((row) =>
          CSV_COLUMNS.map((c) => csvCell(c.value(row))).join(",")
        ),
      ];
      return new NextResponse(lines.join("\n") + "\n", {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="daily-rollups_${formatDay(from)}_${formatDay(to)}.csv"`,
          "Cache-Control": "no-store",
        },
      });
    }

    return NextResponse.json(
      {
        from: formatDay(from),
        to: formatDay(to),
        rowCount: serialized.length,
        truncated,
        rows: serialized,
      },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    return NextResponse.json(
      { error: "Failed to export daily rollups" },
      { status: 500 }
    );
  }
}
