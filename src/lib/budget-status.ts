import { prisma } from "@/lib/prisma";
import {
  sumMonthToDateExternalCostByProvider,
  sumMonthToDateExternalCostAttribution,
} from "@/lib/external-usage-events";
import { buildProviderAlertState, type ProviderAlert } from "@/lib/provider-alerts";
import { getExternalEventRawCutoff } from "@/lib/data-retention";
import { calculateEomForecast } from "@/lib/forecasting";
import { advancePeriod, isSubscriptionInterval } from "@/lib/subscriptions";

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
  snapshotCostFetchedAt: string | null;
  snapshotFixedCostIncludedUsd: number;
  snapshotCostIncludesUnknownFixed: boolean;
  pushedMonthToDateUsd: number;
  subscriptionMonthToDateUsd: number;
  fixedAccruedUsd: number;
  linkedFixedDedupeUsd: number;
  fixedCostConflict: boolean;
  forecastedSubscriptionRenewalsUsd: number;
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
    budgetedSpentUsd: number;
    unbudgetedSpentUsd: number;
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

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= 0.005;
}

function forecastSubscriptionRenewals(
  subscriptions: Array<{
    costUsd: number;
    currency: string;
    interval: string;
    intervalCount: number;
    nextRenewalAt: Date;
    autoRenew: boolean;
  }>,
  now: Date
): number {
  const monthEnd = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)
  );
  let total = 0;
  for (const subscription of subscriptions) {
    if (
      !subscription.autoRenew ||
      subscription.currency.toUpperCase() !== "USD" ||
      !isSubscriptionInterval(subscription.interval)
    ) {
      continue;
    }
    let renewal = subscription.nextRenewalAt;
    let guard = 0;
    while (renewal < monthEnd && guard < 240) {
      if (renewal > now) total += subscription.costUsd;
      renewal = advancePeriod(
        renewal,
        subscription.interval,
        Math.max(1, Math.trunc(subscription.intervalCount))
      );
      guard += 1;
    }
  }
  return total;
}

export async function computeBudgetStatus(now: Date = new Date()): Promise<BudgetStatusResponse> {
  const monthStart = monthStartUtc(now);
  const rawCutoff = getExternalEventRawCutoff(now);

  const [providers, pushedByProvider, latestCostTimes, materializedSubscriptionEvents] = await Promise.all([
    prisma.provider.findMany({
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
          select: {
            balance: true,
            totalCost: true,
            fixedCostIncludedUsd: true,
            costWindowStart: true,
            costWindowEnd: true,
            costScope: true,
            costIncludesUnknownFixed: true,
            totalRequests: true,
            requestUnit: true,
            requestWindow: true,
            requestWindowStart: true,
            requestWindowEnd: true,
            credits: true,
            fetchedAt: true,
          },
        },
        subscriptions: {
          where: { status: "active" },
          select: {
            id: true,
            costUsd: true,
            currency: true,
            interval: true,
            intervalCount: true,
            nextRenewalAt: true,
            autoRenew: true,
            externalBillingSource: true,
            externalBillingId: true,
          },
        },
        externalBilling: {
          select: {
            source: true,
            externalId: true,
            kind: true,
            status: true,
            amountUsd: true,
            currency: true,
            billingInterval: true,
            currentPeriodStart: true,
          },
        },
      },
    }),
    sumMonthToDateExternalCostByProvider(monthStart, rawCutoff),
    prisma.usageSnapshot.groupBy({
      by: ["providerId"],
      where: {
        fetchedAt: { gte: monthStart, lte: now },
        totalCost: { not: null },
        AND: [
          {
            OR: [
              { costScope: null },
              { costScope: { not: "daily" } },
            ],
          },
          {
            OR: [
              { costWindowStart: null },
              { costWindowStart: { gte: monthStart } },
            ],
          },
        ],
      },
      _max: { fetchedAt: true },
    }),
    prisma.externalUsageEvent.findMany({
      where: {
        sourceApp: "subscription",
        metricType: "subscription",
        occurredAt: { gte: monthStart, lte: now },
      },
      select: { costUsd: true, metadata: true },
    }),
  ]);

  const materializedCostBySubscriptionId = new Map<string, number>();
  for (const event of materializedSubscriptionEvents) {
    if (!event.metadata || typeof event.metadata !== "object" || Array.isArray(event.metadata)) {
      continue;
    }
    const subscriptionId = (event.metadata as Record<string, unknown>).subscriptionId;
    if (typeof subscriptionId !== "string" || event.costUsd == null) continue;
    materializedCostBySubscriptionId.set(
      subscriptionId,
      (materializedCostBySubscriptionId.get(subscriptionId) ?? 0) + event.costUsd
    );
  }

  const latestCostSnapshots = latestCostTimes.length
    ? await prisma.usageSnapshot.findMany({
        where: {
          OR: latestCostTimes.flatMap((row) =>
            row._max.fetchedAt
              ? [{ providerId: row.providerId, fetchedAt: row._max.fetchedAt }]
              : []
          ),
        },
        orderBy: { fetchedAt: "desc" },
        select: {
          providerId: true,
          fetchedAt: true,
          totalCost: true,
          fixedCostIncludedUsd: true,
          costIncludesUnknownFixed: true,
        },
      })
    : [];
  const latestCostByProviderId = new Map<
    string,
    (typeof latestCostSnapshots)[number]
  >();
  for (const snapshot of latestCostSnapshots) {
    if (!latestCostByProviderId.has(snapshot.providerId)) {
      latestCostByProviderId.set(snapshot.providerId, snapshot);
    }
  }

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
    const latestCostSnapshot = latestCostByProviderId.get(p.id) ?? null;
    const fixedMonthlyCostUsd = plan?.fixedMonthlyCostUsd ?? 0;
    const snapshotCostUsd = latestCostSnapshot?.totalCost ?? null;
    const snapshotFixedCostIncludedUsd = Math.max(
      0,
      Math.min(
        latestCostSnapshot?.fixedCostIncludedUsd ?? 0,
        snapshotCostUsd ?? 0
      )
    );
    const ownsNameKeyedSpend = canonicalProviderIdByName.get(p.name.toLowerCase()) === p.id;
    const pushed = ownsNameKeyedSpend
      ? pushedMap.get(p.name.toLowerCase()) ?? { usagePushed: 0, subscriptionPushed: 0 }
      : { usagePushed: 0, subscriptionPushed: 0 };
    const pushedMonthToDateUsd = pushed.usagePushed + pushed.subscriptionPushed;
    // Usage-like pushed cost is deduped against the variable portion of the
    // poll snapshot via max(); fixed representations are reconciled below.
    const snapshotVariableCostUsd = Math.max(
      0,
      (snapshotCostUsd ?? 0) - snapshotFixedCostIncludedUsd
    );
    const usageCost = Math.max(snapshotVariableCostUsd, pushed.usagePushed);
    const liveExternalFixed = p.externalBilling.filter((record) => {
      const status = record.status?.toLowerCase() ?? "";
      return (
        ["plan", "subscription"].includes(record.kind) &&
        !["canceled", "cancelled", "failed", "expired", "inactive"].includes(status) &&
        (record.currency ?? "USD").toUpperCase() === "USD" &&
        record.amountUsd != null &&
        record.amountUsd >= 0 &&
        record.currentPeriodStart != null &&
        record.currentPeriodStart >= monthStart &&
        record.currentPeriodStart <= now
      );
    });
    const localFixed = p.subscriptions.filter(
      (subscription) => subscription.currency.toUpperCase() === "USD"
    );
    let linkedMaterializedFixedUsd = 0;
    for (const subscription of localFixed) {
      if (!subscription.externalBillingSource || !subscription.externalBillingId) continue;
      const externalRecord = liveExternalFixed.find(
        (record) =>
          record.source === subscription.externalBillingSource &&
          record.externalId === subscription.externalBillingId
      );
      if (
        !externalRecord ||
        subscription.intervalCount !== 1 ||
        externalRecord.billingInterval !== subscription.interval ||
        !nearlyEqual(externalRecord.amountUsd ?? -1, subscription.costUsd)
      ) {
        continue;
      }
      linkedMaterializedFixedUsd +=
        materializedCostBySubscriptionId.get(subscription.id) ?? 0;
    }
    const linkedFixedDedupeUsd = Math.min(
      snapshotFixedCostIncludedUsd,
      pushed.subscriptionPushed,
      linkedMaterializedFixedUsd
    );
    const snapshotCostIncludesUnknownFixed =
      latestCostSnapshot?.costIncludesUnknownFixed ?? false;
    const fixedCostConflict =
      (fixedMonthlyCostUsd > 0 &&
        (pushed.subscriptionPushed > 0 || snapshotFixedCostIncludedUsd > 0)) ||
      Math.min(snapshotFixedCostIncludedUsd, pushed.subscriptionPushed) -
        linkedFixedDedupeUsd >
        0.005 ||
      (snapshotCostIncludesUnknownFixed && pushed.subscriptionPushed > 0) ||
      linkedMaterializedFixedUsd - linkedFixedDedupeUsd > 0.005;
    // Preserve every distinct fixed source. Collapse only the amount proven to
    // represent the same provider billing identity through an explicit local
    // Subscription link; equal prices alone are never treated as identity.
    const fixedAccruedUsd =
      fixedMonthlyCostUsd +
      pushed.subscriptionPushed +
      snapshotFixedCostIncludedUsd -
      linkedFixedDedupeUsd;
    const spentUsd = fixedAccruedUsd + usageCost;
    const forecastedSubscriptionRenewalsUsd = forecastSubscriptionRenewals(
      p.subscriptions,
      now
    );
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
          requestUnit: latestSnapshot?.requestUnit ?? null,
          requestWindow: latestSnapshot?.requestWindow ?? null,
          requestWindowStart: latestSnapshot?.requestWindowStart ?? null,
          requestWindowEnd: latestSnapshot?.requestWindowEnd ?? null,
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
    if (fixedCostConflict) {
      budgetAlerts.push({
        code: "fixed_cost_conflict",
        severity: "warning",
        message:
          "Provider-reported and manual fixed costs may overlap; link or remove the manual entry after reconciling the provider billing record.",
      });
    }

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
      snapshotCostFetchedAt: latestCostSnapshot?.fetchedAt.toISOString() ?? null,
      snapshotFixedCostIncludedUsd,
      snapshotCostIncludesUnknownFixed,
      pushedMonthToDateUsd,
      subscriptionMonthToDateUsd: pushed.subscriptionPushed,
      fixedAccruedUsd,
      linkedFixedDedupeUsd,
      fixedCostConflict,
      forecastedSubscriptionRenewalsUsd,
      spentUsd,
      projectedEomUsd:
        calculateEomForecast(spentUsd, fixedAccruedUsd, now) +
        forecastedSubscriptionRenewalsUsd,
      remainingUsd,
      percentUsed,
      status,
      alerts: budgetAlerts,
    };
  });

  const budgeted = providerStatuses.filter((p) => p.monthlyBudgetUsd != null && p.monthlyBudgetUsd > 0);
  const totalBudgetUsd = budgeted.reduce((s, p) => s + (p.monthlyBudgetUsd ?? 0), 0);
  const budgetedSpentUsd = budgeted.reduce((s, p) => s + p.spentUsd, 0);
  const totalSpentUsd = providerStatuses.reduce((s, p) => s + p.spentUsd, 0);

  return {
    ok: true,
    generatedAt: now.toISOString(),
    month: monthLabel(now),
    providers: providerStatuses,
    summary: {
      totalBudgetUsd,
      budgetedSpentUsd,
      unbudgetedSpentUsd: totalSpentUsd - budgetedSpentUsd,
      totalSpentUsd,
      remainingUsd: totalBudgetUsd - budgetedSpentUsd,
      percentUsed: totalBudgetUsd > 0 ? budgetedSpentUsd / totalBudgetUsd : null,
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
    budgetedSpentUsd: number;
    unbudgetedSpentUsd: number;
    unassignedSpentUsd: number;
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
      // Name-keyed pushed spend is assigned to exactly one canonical provider
      // row in computeBudgetStatus. Subtract its direct attribution only from
      // that same owner; duplicate provider rows can carry independent poll
      // snapshots, and subtracting the shared name total from every duplicate
      // silently drops part of their allocatable spend.
      const ownsNameKeyedSpend = provider.pushedMonthToDateUsd > 0;
      const attributed = ownsNameKeyedSpend
        ? attributedByProvider.get(provider.name.toLowerCase()) ?? 0
        : 0;
      const residual = Math.max(0, provider.spentUsd - attributed);
      const attributedFixed = provider.subscriptionMonthToDateUsd > 0
        ? attributedFixedByProvider.get(provider.name.toLowerCase()) ?? 0
        : 0;
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
  const budgetedSpentUsd = budgeted.reduce((s, p) => s + p.spentUsd, 0);
  const attributedProjectSpentUsd = projectStatuses.reduce((s, p) => s + p.spentUsd, 0);
  // Provider totals are the money source of truth. Project rows are an
  // attribution view and may intentionally leave some provider spend
  // unassigned (or be over-allocated by operator configuration), so never
  // derive the app-wide total from only the visible project rows.
  const totalSpentUsd = providerStatus.summary.totalSpentUsd;
  const unassignedSpentUsd = Math.max(0, totalSpentUsd - attributedProjectSpentUsd);

  return {
    ok: true,
    generatedAt: now.toISOString(),
    month: monthLabel(now),
    providers: providerStatus.providers,
    projects: projectStatuses,
    summary: {
      totalBudgetUsd,
      budgetedSpentUsd,
      unbudgetedSpentUsd: Math.max(0, totalSpentUsd - budgetedSpentUsd),
      unassignedSpentUsd,
      totalSpentUsd,
      remainingUsd: totalBudgetUsd - budgetedSpentUsd,
      percentUsed: totalBudgetUsd > 0 ? budgetedSpentUsd / totalBudgetUsd : null,
      overBudget: projectStatuses.some((p) => p.status === "exceeded"),
      warning: projectStatuses.some((p) => p.status === "warning"),
    },
  };
}
