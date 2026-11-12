import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  buildLlmBurnReport,
  DEFAULT_WINDOW_HOURS,
  MAX_WINDOW_HOURS,
  monthStartUtc,
  tokenTypeFromLabel,
  type LlmBurnCostGroup,
  type LlmBurnTokenGroup,
} from "@/lib/llm-burn";

export const dynamic = "force-dynamic";

/**
 * GET /api/llm-burn?hours=5
 *
 * ccusage-style burn-window report generalized to every LLM platform in
 * ExternalUsageEvent: trailing-window token/cost burn, elapsed-activity burn
 * rate, and month-to-date budget pace + linear month-end projection.
 * Analytics-only API-equivalent estimates — never cash spend and never read
 * by budget math (see src/lib/llm-burn.ts's docblock).
 *
 * Dashboard-session gated like every other non-ingest route (no middleware
 * exclusion — this is a read for the owner, not a producer endpoint).
 *
 * All aggregation happens in SQLite via groupBy, never by materializing raw
 * rows (the OOM lesson from budget-status.ts): token groups are bounded by
 * provider x model x token-type cardinality, cost/activity groups by
 * provider count. The token groupBy includes `label` to recover the
 * claude-code token type — same accepted exposure as claude-cost-check.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const requestedHours = Number(searchParams.get("hours") ?? DEFAULT_WINDOW_HOURS);
  const hours = Number.isFinite(requestedHours)
    ? Math.min(Math.max(Math.trunc(requestedHours), 1), MAX_WINDOW_HOURS)
    : DEFAULT_WINDOW_HOURS;

  const now = new Date();
  const windowStart = new Date(now.getTime() - hours * 3_600_000);
  const monthStart = monthStartUtc(now);

  const tokenWhere = (since: Date) => ({
    metricType: "usage",
    unit: "token",
    occurredAt: { gte: since, lte: now },
  });
  const costWhere = (since: Date) => ({
    occurredAt: { gte: since, lte: now },
    OR: [
      { metricType: "cost" },
      // Generic producers put costUsd on the usage event itself; claude-code
      // pushes separate cost events. Both are "reported" cost; combining them
      // per provider is safe because no producer in the fleet does both.
      { metricType: "usage", costUsd: { not: null } },
    ],
  });

  const [
    windowTokenGroups,
    windowCostGroups,
    windowActivity,
    mtdTokenGroups,
    mtdCostGroups,
    providers,
  ] = await Promise.all([
    prisma.externalUsageEvent.groupBy({
      by: ["provider", "keyRef", "label"],
      where: tokenWhere(windowStart),
      _sum: { quantity: true },
    }),
    prisma.externalUsageEvent.groupBy({
      by: ["provider"],
      where: costWhere(windowStart),
      _sum: { costUsd: true },
    }),
    prisma.externalUsageEvent.groupBy({
      by: ["provider"],
      where: {
        metricType: { in: ["usage", "cost"] },
        occurredAt: { gte: windowStart, lte: now },
      },
      _min: { occurredAt: true },
      _max: { occurredAt: true },
      _count: { _all: true },
    }),
    prisma.externalUsageEvent.groupBy({
      by: ["provider", "keyRef", "label"],
      where: tokenWhere(monthStart),
      _sum: { quantity: true },
    }),
    prisma.externalUsageEvent.groupBy({
      by: ["provider"],
      where: costWhere(monthStart),
      _sum: { costUsd: true },
    }),
    // Budgets: name matched case-insensitively in JS inside the report
    // builder (Prisma mode:"insensitive" is Postgres-only; SQLite here).
    prisma.provider.findMany({
      select: { name: true, plan: { select: { monthlyBudgetUsd: true } } },
    }),
  ]);

  const toTokenGroups = (
    groups: { provider: string; keyRef: string | null; label: string | null; _sum: { quantity: number | null } }[]
  ): LlmBurnTokenGroup[] =>
    groups.map((group) => ({
      provider: group.provider,
      model: group.keyRef,
      tokenType: tokenTypeFromLabel(group.label),
      quantity: group._sum.quantity ?? 0,
    }));

  const toCostGroups = (
    groups: { provider: string; _sum: { costUsd: number | null } }[]
  ): LlmBurnCostGroup[] =>
    groups.map((group) => ({ provider: group.provider, costUsd: group._sum.costUsd ?? 0 }));

  const report = buildLlmBurnReport({
    now,
    windowHours: hours,
    windowTokenGroups: toTokenGroups(windowTokenGroups),
    windowCostGroups: toCostGroups(windowCostGroups),
    windowActivity: windowActivity
      .filter((group) => group._min.occurredAt != null && group._max.occurredAt != null)
      .map((group) => ({
        provider: group.provider,
        firstOccurredAt: group._min.occurredAt as Date,
        lastOccurredAt: group._max.occurredAt as Date,
        eventCount: group._count._all,
      })),
    mtdTokenGroups: toTokenGroups(mtdTokenGroups),
    mtdCostGroups: toCostGroups(mtdCostGroups),
    budgets: providers.map((provider) => ({
      providerName: provider.name,
      monthlyBudgetUsd: provider.plan?.monthlyBudgetUsd ?? null,
    })),
  });

  return NextResponse.json({ ok: true, ...report });
}
