import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { buildApiEquivalentCost } from "@/lib/claude-cost-check";
import { SUBSCRIPTION_ANALYTICS_SOURCE_APPS } from "@/lib/subscription-analytics";

export const dynamic = "force-dynamic";

/**
 * GET /api/api-equivalent-cost?days=30
 *
 * Token x LiteLLM catalog vs producer-reported estimate for every
 * subscription-seat sourceApp that has ingested telemetry (Claude Code OTLP,
 * Codex JSONL, Grok Build updates.jsonl). Both sides are analytics-only
 * API-equivalent estimates — never cash spend.
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
  const sourceApps = [...SUBSCRIPTION_ANALYTICS_SOURCE_APPS];

  try {
    const [tokenGroups, costGroups] = await Promise.all([
      prisma.externalUsageEvent.groupBy({
        by: ["provider", "sourceApp", "keyRef", "label"],
        where: {
          sourceApp: { in: sourceApps },
          metricType: "usage",
          unit: "token",
          occurredAt: { gte: since },
        },
        _sum: { quantity: true },
      }),
      prisma.externalUsageEvent.groupBy({
        by: ["provider", "sourceApp", "keyRef"],
        where: {
          sourceApp: { in: sourceApps },
          metricType: "cost",
          occurredAt: { gte: since },
        },
        _sum: { costUsd: true },
      }),
    ]);

    const report = buildApiEquivalentCost(
      tokenGroups.map((group) => ({
        provider: group.provider,
        sourceApp: group.sourceApp,
        model: group.keyRef,
        tokenType: group.label?.startsWith("token:")
          ? group.label.slice("token:".length)
          : "unknown",
        quantity: group._sum.quantity ?? 0,
      })),
      costGroups.map((group) => ({
        provider: group.provider,
        sourceApp: group.sourceApp,
        model: group.keyRef,
        costUsd: group._sum.costUsd ?? 0,
      }))
    );

    return NextResponse.json({ ok: true, days, ...report });
  } catch (error) {
    console.error("[api-equivalent-cost] database query failed:", error);
    return NextResponse.json(
      { ok: false, error: "Database unavailable" },
      { status: 503 }
    );
  }
}
