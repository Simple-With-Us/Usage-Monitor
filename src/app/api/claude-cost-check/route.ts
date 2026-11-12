import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { buildClaudeCostCheck } from "@/lib/claude-cost-check";
import { SOURCE_APP } from "@/lib/otlp/claude-code-mapper";

export const dynamic = "force-dynamic";

/**
 * GET /api/claude-cost-check?days=30
 *
 * Cross-checks Claude Code's own OTLP cost estimate against an independent
 * token x LiteLLM-catalog derivation over the same ingested rows. Both sides
 * are analytics-only API-equivalent estimates (never cash spend); the value
 * of this endpoint is the DELTA, which flags pricing drift, unpriced new
 * models, or mapper bugs before they silently distort analytics.
 *
 * Dashboard-session gated like every other non-ingest route (no middleware
 * exclusion — this is a read for the owner, not a producer endpoint).
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const isAllTime = searchParams.get("days") === "all";
  const requestedDays = Number(searchParams.get("days") ?? 30);
  const days = isAllTime
    ? 3650
    : Number.isFinite(requestedDays)
    ? Math.min(Math.max(Math.trunc(requestedDays), 1), 3650)
    : 30;
  const since = days >= 3650 ? new Date(0) : new Date(Date.now() - days * 86_400_000);

  // Aggregate in SQLite (groupBy) rather than materializing raw rows — the
  // result set is (model x token-type) rows, bounded by catalog cardinality,
  // not by event volume (see the OOM lessons from #392 in budget-status.ts).
  try {
    const [tokenGroups, costGroups] = await Promise.all([
      prisma.externalUsageEvent.groupBy({
        by: ["keyRef", "label"],
        where: {
          sourceApp: SOURCE_APP,
          metricType: "usage",
          unit: "token",
          occurredAt: { gte: since },
        },
        _sum: { quantity: true },
      }),
      prisma.externalUsageEvent.groupBy({
        by: ["keyRef"],
        where: {
          sourceApp: SOURCE_APP,
          metricType: "cost",
          occurredAt: { gte: since },
        },
        _sum: { costUsd: true },
      }),
    ]);

    const report = buildClaudeCostCheck(
      tokenGroups.map((group) => ({
        model: group.keyRef,
        // label is `token:<type>` for token.usage rows (see claude-code-mapper);
        // anything else defensively maps to "unknown" inside the report.
        tokenType: group.label?.startsWith("token:") ? group.label.slice("token:".length) : "unknown",
        quantity: group._sum.quantity ?? 0,
      })),
      costGroups.map((group) => ({
        model: group.keyRef,
        costUsd: group._sum.costUsd ?? 0,
      }))
    );

    return NextResponse.json({ ok: true, days, ...report });
  } catch (error) {
    console.error("[claude-cost-check] database query failed:", error);
    return NextResponse.json(
      { ok: false, error: "Database unavailable" },
      { status: 503 }
    );
  }
}
