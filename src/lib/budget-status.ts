import { prisma } from "@/lib/prisma";
import {
  sumMonthToDateExternalCostByProvider,
  sumMonthToDateExternalCostAttribution,
} from "@/lib/external-usage-events";
import { buildProviderAlertState, type ProviderAlert } from "@/lib/provider-alerts";
import { getExternalEventRawCutoff } from "@/lib/data-retention";
import { calculateEomForecast } from "@/lib/forecasting";

// Budget-status computation for the read endpoint (GET /api/budget-status).
//
// Consuming apps (e.g. Agentic Trading's cost-aware feedback loop) poll this to decide whether to
// throttle spend. Spend is combined across BOTH channels the monitor tracks:
//   - poll snapshots  (UsageSnapshot.totalCost — cumulative cost the poll adapter reported)
//   - pushed telemetry (ExternalUsageEvent.costUsd — month-to-date, the ONLY signal for providers
//     the poll adapters are blind to: Anthropic, Voyage, Robinhood)
// To avoid double-counting a provider that reports through both channels, per-provider spend uses
// max(snapshotCost, pushedMonthToDate) + fixedMonthlyCost — matching the existing alert convention
// in provider-alerts.ts (which treats fixedMonthlyCost + snapshot.totalCost as the monthly figure).

const WARNING_RATIO = 0.8;

export type BudgetStatusLevel = "ok" | "warning" | "exceeded" | "unconfigured";

export interface ProviderBudgetStatus {
  id: string;
  name: string;
  displayName: string;
  monthlyBudgetUsd: number | null;
  fixedMonthlyCostUsd: number;
  snapshotCostUsd: number | null;
  pushedMonthToDateUsd: number;
  subscriptionMonthToDateUsd: number;
  fixedAccruedUsd: number;
  spentUsd: number;
  projectedEomUsd: number;
  remainingUsd: number | null;
  percentUsed: number | null;
  status: BudgetStatusLevel;
  alerts: ProviderAlert[];
}

export interface BudgetStatusResponse {
  ok: true;
  generatedAt: string;
  month: string; // YYYY-MM (UTC)
  providers: ProviderBudgetStatus[];
  summary: {
    totalBudgetUsd: number;
    totalSpentUsd: number;
    remainingUsd: number;
    percentUsed: number | null;
    overBudget: boolean;
    warning: boolean;
  };
}

function monthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function monthLabel(now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

export async function computeBudgetStatus(now: Date = new Date()): Promise<BudgetStatusResponse> {
  const monthStart = monthStartUtc(now);
  const rawCutoff = getExternalEventRawCutoff(now);

  const [providers, pushedByProvider] = await Promise.all([
    prisma.provider.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        displayName: true,
        isActive: true,
        refreshIntervalMin: true,
        plan: {
          select: {
            billingMode: true,
            fixedMonthlyCostUsd: true,
            monthlyBudgetUsd: true,
            monthlyRequestLimit: true,
            lowBalanceUsd: true,
            lowCredits: true,
            renewalDate: true,
            billingInterval: true,
            mustKeepFunded: true,
          },
        },
        snapshots: {
          orderBy: { fetchedAt: "desc" },
          take: 1,
          select: { balance: true, totalCost: true, totalRequests: true, credits: true, fetchedAt: true },
        },
      },
    }),
    sumMonthToDateExternalCostByProvider(monthStart, rawCutoff),
  ]);

  // Case-insensitive provider name → month-to-date pushed cost (split into
  // usage-like vs subscription — see sumMonthToDateExternalCostByProvider).
  const pushedMap = pushedByProvider;

  // External events identify providers by case-insensitive name, while the
  // settings table can contain legacy duplicate Provider rows. Assign each
  // name-keyed pushed/subscription total to exactly one deterministic owner so
  // duplicates cannot multiply spend. Prefer the row with a configured budget,
  // then any plan, then lexical id for a stable tie-break.
  const canonicalProviderIdByName = new Map<string, string>();
  for (const provider of providers) {
    const key = provider.name.toLowerCase();
    const currentId = canonicalProviderIdByName.get(key);
    if (!currentId) {
      canonicalProviderIdByName.set(key, provider.id);
      continue;
    }
    const current = providers.find((candidate) => candidate.id === currentId)!;
    const rank = (candidate: typeof provider) =>
      (candidate.plan?.monthlyBudgetUsd != null ? 4 : 0) + (candidate.plan ? 2 : 0);
    if (rank(provider) > rank(current) || (rank(provider) === rank(current) && provider.id < current.id)) {
      canonicalProviderIdByName.set(key, provider.id);
    }
  }

  const providerStatuses: ProviderBudgetStatus[] = providers.map((p) => {
    const plan = p.plan;
    const latestSnapshot = p.snapshots[0] ?? null;
    const fixedMonthlyCostUsd = plan?.fixedMonthlyCostUsd ?? 0;
    const snapshotCostUsd = latestSnapshot?.totalCost ?? null;
    const ownsNameKeyedSpend = canonicalProviderIdByName.get(p.name.toLowerCase()) === p.id;
    const pushed = ownsNameKeyedSpend
      ? pushedMap.get(p.name.toLowerCase()) ?? { usagePushed: 0, subscriptionPushed: 0 }
      : { usagePushed: 0, subscriptionPushed: 0 };
    const pushedMonthToDateUsd = pushed.usagePushed + pushed.subscriptionPushed;
    // Usage-like pushed cost is deduped against the poll snapshot via max()
    // (they measure the same spend); materialized subscription fees are DISJOINT
    // from metered usage and are always added on top — otherwise a subscription
    // on a poll-tracked provider vanishes whenever snapshot ≥ the fee.
    const usageCost = Math.max(snapshotCostUsd ?? 0, pushed.usagePushed) + pushed.subscriptionPushed;
    const spentUsd = fixedMonthlyCostUsd + usageCost;
    const fixedAccruedUsd = fixedMonthlyCostUsd + pushed.subscriptionPushed;
    const monthlyBudgetUsd = plan?.monthlyBudgetUsd ?? null;

    // Reuse the shared alert logic for budget alerts by feeding the combined usage cost as the
    // snapshot's totalCost (so budget_exceeded/budget_warning reflect BOTH poll + pushed spend).
    const alertState = buildProviderAlertState(
      {
        isActive: p.isActive,
        refreshIntervalMin: p.refreshIntervalMin,
        plan: plan ?? null,
        latestSnapshot: {
          balance: latestSnapshot?.balance ?? null,
          totalCost: usageCost,
          totalRequests: latestSnapshot?.totalRequests ?? null,
          credits: latestSnapshot?.credits ?? null,
          fetchedAt: latestSnapshot?.fetchedAt ?? now,
        },
        trackedSpendUsd: spentUsd,
        fixedAccruedUsd,
      },
      now
    );
    const budgetAlerts = alertState.alerts.filter(
      (a) => a.code === "budget_exceeded" || a.code === "budget_warning"
    );

    let status: BudgetStatusLevel;
    let remainingUsd: number | null;
    let percentUsed: number | null;
    if (monthlyBudgetUsd == null || monthlyBudgetUsd <= 0) {
      status = "unconfigured";
      remainingUsd = null;
      percentUsed = null;
    } else {
      remainingUsd = monthlyBudgetUsd - spentUsd;
      percentUsed = spentUsd / monthlyBudgetUsd;
      status =
        spentUsd >= monthlyBudgetUsd
          ? "exceeded"
          : spentUsd >= monthlyBudgetUsd * WARNING_RATIO
            ? "warning"
            : "ok";
    }

    return {
      id: p.id,
      name: p.name,
      displayName: p.displayName,
      monthlyBudgetUsd,
      fixedMonthlyCostUsd,
      snapshotCostUsd,
      pushedMonthToDateUsd,
      subscriptionMonthToDateUsd: pushed.subscriptionPushed,
      fixedAccruedUsd,
      spentUsd,
      projectedEomUsd: calculateEomForecast(spentUsd, fixedAccruedUsd, now),
      remainingUsd,
      percentUsed,
      status,
      alerts: budgetAlerts,
    };
  });

  const budgeted = providerStatuses.filter((p) => p.monthlyBudgetUsd != null && p.monthlyBudgetUsd > 0);
  const totalBudgetUsd = budgeted.reduce((s, p) => s + (p.monthlyBudgetUsd ?? 0), 0);
  const totalSpentUsd = budgeted.reduce((s, p) => s + p.spentUsd, 0);

  return {
    ok: true,
    generatedAt: now.toISOString(),
    month: monthLabel(now),
    providers: providerStatuses,
    summary: {
      totalBudgetUsd,
      totalSpentUsd,
      remainingUsd: totalBudgetUsd - totalSpentUsd,
      percentUsed: totalBudgetUsd > 0 ? totalSpentUsd / totalBudgetUsd : null,
      overBudget: providerStatuses.some((p) => p.status === "exceeded"),
      warning: providerStatuses.some((p) => p.status === "warning"),
    },
  };
}

export interface ProjectBudgetStatus {
  id: string;
  name: string;
  description: string | null;
  monthlyBudgetUsd: number | null;
  spentUsd: number;
  projectedEomUsd: number;
  // Cost attributed directly to this project — events carrying its projectId
  // (incl. materialized subscription charges) plus the legacy fallback where an
  // untagged event's sourceApp matches this project's name.
  directUsd: number;
  // Cost distributed to this project by ProviderProjectAllocation percentages
  // out of each provider's residual (spend not directly attributed anywhere).
  allocatedUsd: number;
  remainingUsd: number | null;
  percentUsed: number | null;
  status: BudgetStatusLevel;
}

export interface ProjectBudgetStatusResponse {
  ok: true;
  generatedAt: string;
  month: string;
  providers: ProviderBudgetStatus[];
  projects: ProjectBudgetStatus[];
  summary: {
    totalBudgetUsd: number;
    totalSpentUsd: number;
    remainingUsd: number;
    percentUsed: number | null;
    overBudget: boolean;
    warning: boolean;
  };
}

export async function computeProjectBudgetStatus(now: Date = new Date()): Promise<ProjectBudgetStatusResponse> {
  const [providerStatus, projects, attribution] = await Promise.all([
    computeBudgetStatus(now),
    prisma.project.findMany({
      include: {
        allocations: true,
      },
      orderBy: { name: "asc" }
    }),
    sumMonthToDateExternalCostAttribution(monthStartUtc(now), getExternalEventRawCutoff(now)),
  ]);

  // Lowercased Project.name -> id, for the legacy sourceApp-name fallback.
  const projectIdByName = new Map(projects.map((p) => [p.name.toLowerCase(), p.id]));

  // Slice the (provider, sourceApp, projectId) triples into:
  //   directByProjectId  — cost attributed to a specific project. A row counts
  //     when it carries a projectId (authoritative), OR — only if untagged —
  //     when its sourceApp matches a known Project.name (legacy behaviour, kept
  //     for back-compat but no longer able to double-count a projectId row).
  //   attributedByProvider — for each provider, the slice of its cost that
  //     landed on SOME project above; subtracted from provider.spentUsd to get
  //     the residual that percentage allocations distribute (this is the fix
  //     for the old code, which subtracted a differently-keyed pushed total).
  const directByProjectId = new Map<string, number>();
  const directFixedByProjectId = new Map<string, number>();
  const attributedByProvider = new Map<string, number>();
  const attributedFixedByProvider = new Map<string, number>();
  for (const row of attribution) {
    const projectId = row.projectId ?? projectIdByName.get(row.sourceApp.toLowerCase()) ?? null;
    if (!projectId) continue;
    directByProjectId.set(projectId, (directByProjectId.get(projectId) ?? 0) + row.costUsd);
    const providerKey = row.provider.toLowerCase();
    attributedByProvider.set(providerKey, (attributedByProvider.get(providerKey) ?? 0) + row.costUsd);
    if (row.metricType === "subscription") {
      directFixedByProjectId.set(
        projectId,
        (directFixedByProjectId.get(projectId) ?? 0) + row.costUsd
      );
      attributedFixedByProvider.set(
        providerKey,
        (attributedFixedByProvider.get(providerKey) ?? 0) + row.costUsd
      );
    }
  }

  const providerById = new Map(providerStatus.providers.map((p) => [p.id, p]));

  const projectStatuses: ProjectBudgetStatus[] = projects.map((proj) => {
    // 1. Direct per-event attribution (projectId, plus legacy name match).
    const directUsd = directByProjectId.get(proj.id) ?? 0;
    const directFixedUsd = directFixedByProjectId.get(proj.id) ?? 0;

    // 2. Percentage allocation of each provider's residual — the spend NOT
    // already directly attributed to any project (fixed fees, poll-snapshot
    // usage, and any untagged pushed telemetry).
    let allocatedUsd = 0;
    let allocatedFixedUsd = 0;
    for (const alloc of proj.allocations) {
      const provider = providerById.get(alloc.providerId);
      if (!provider) continue;
      const attributed = attributedByProvider.get(provider.name.toLowerCase()) ?? 0;
      const residual = Math.max(0, provider.spentUsd - attributed);
      const attributedFixed = attributedFixedByProvider.get(provider.name.toLowerCase()) ?? 0;
      const fixedResidual = Math.max(0, provider.fixedAccruedUsd - attributedFixed);
      const ratio = Math.max(0, Math.min(100, alloc.percentage)) / 100;
      allocatedUsd += residual * ratio;
      allocatedFixedUsd += Math.min(residual, fixedResidual) * ratio;
    }

    const spentUsd = directUsd + allocatedUsd;

    let status: BudgetStatusLevel;
    let remainingUsd: number | null;
    let percentUsed: number | null;
    if (proj.monthlyBudgetUsd == null || proj.monthlyBudgetUsd <= 0) {
      status = "unconfigured";
      remainingUsd = null;
      percentUsed = null;
    } else {
      remainingUsd = proj.monthlyBudgetUsd - spentUsd;
      percentUsed = spentUsd / proj.monthlyBudgetUsd;
      status =
        spentUsd >= proj.monthlyBudgetUsd
          ? "exceeded"
          : spentUsd >= proj.monthlyBudgetUsd * WARNING_RATIO
            ? "warning"
            : "ok";
    }

    return {
      id: proj.id,
      name: proj.name,
      description: proj.description,
      monthlyBudgetUsd: proj.monthlyBudgetUsd,
      spentUsd,
      projectedEomUsd: calculateEomForecast(
        spentUsd,
        Math.min(spentUsd, directFixedUsd + allocatedFixedUsd),
        now
      ),
      directUsd,
      allocatedUsd,
      remainingUsd,
      percentUsed,
      status,
    };
  });

  const budgeted = projectStatuses.filter((p) => p.monthlyBudgetUsd != null && p.monthlyBudgetUsd > 0);
  const totalBudgetUsd = budgeted.reduce((s, p) => s + (p.monthlyBudgetUsd ?? 0), 0);
  const totalSpentUsd = budgeted.reduce((s, p) => s + p.spentUsd, 0);

  return {
    ok: true,
    generatedAt: now.toISOString(),
    month: monthLabel(now),
    providers: providerStatus.providers,
    projects: projectStatuses,
    summary: {
      totalBudgetUsd,
      totalSpentUsd,
      remainingUsd: totalBudgetUsd - totalSpentUsd,
      percentUsed: totalBudgetUsd > 0 ? totalSpentUsd / totalBudgetUsd : null,
      overBudget: projectStatuses.some((p) => p.status === "exceeded"),
      warning: projectStatuses.some((p) => p.status === "warning"),
    },
  };
}
