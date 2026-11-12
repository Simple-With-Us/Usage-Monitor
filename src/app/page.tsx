"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import DashboardHero from "@/components/DashboardHero";
import DashboardSummaryCards from "@/components/DashboardSummaryCards";
import CostCoverageLegend from "@/components/CostCoverageLegend";
import DashboardAttentionPanel from "@/components/DashboardAttentionPanel";
import DashboardProviderWorkspace from "@/components/DashboardProviderWorkspace";
import DashboardPortfolioSection from "@/components/DashboardPortfolioSection";
import OperationsOverview from "@/components/OperationsOverview";
import GlobalBudgetModal from "@/components/GlobalBudgetModal";
import ProjectedCostBreakdownModal, {
  type ProjectedRenewalRow,
} from "@/components/ProjectedCostBreakdownModal";
import {
  COMMAND_PALETTE_PROVIDERS_EVENT,
  type CommandPaletteProviderItem,
} from "@/components/CommandPalette";
import EmptyState from "@/components/EmptyState";
import HistoryWindowControl from "@/components/HistoryWindowControl";
import {
  shouldShowDashboardSkeleton,
  useDashboardData,
  historyRangeLabel,
  mtdSpendLabel,
  type TimeframeOption,
} from "@/hooks/useDashboardData";
import { sumProviderFunds } from "@/lib/provider-financial-semantics";
import { canonicalProviderKey } from "@/lib/provider-identity";
import {
  aggregateProviderPortfolioMoney,
  type ProviderMoneyMember,
} from "@/lib/provider-money-aggregation";
import type { ProviderBudgetIntel } from "@/lib/format";
import { deriveAccountStatus } from "@/lib/ui-status";

export default function DashboardPage() {
  const {
    timeframe,
    setTimeframe,
    providers,
    usageSummary,
    projects,
    subscriptions,
    projectSummary,
    portfolioOpen,
    setPortfolioOpen,
    portfolioLoaded,
    portfolioLoading,
    portfolioError,
    loading,
    refreshing,
    error,
    warnings,
    lastUpdatedAt,
    fetchProviders,
    fetchPortfolioData,
    refreshDashboard,
    openAttentionPanel,
  } = useDashboardData();
  const autoOpenedPortfolio = useRef(false);
  const desktopPortfolioDefault = useRef(false);

  // S9/S10: projection intelligence (projectedStatus, budget runout) lives on
  // the budget-status DTO, not on the dashboard providers payload. Read it
  // once per refresh via the session cookie; failure leaves the UI exactly as
  // before (badges/runout text simply don't render).
  const [budgetIntelByProviderId, setBudgetIntelByProviderId] = useState<
    Record<string, ProviderBudgetIntel>
  >({});
  const [globalBudget, setGlobalBudget] = useState<{
    globalMonthlyBudgetUsd: number | null;
    suggestedGlobalBudgetUsd: number | null;
    effectiveGlobalBudgetUsd: number | null;
    globalBudgetSource: "override" | "suggested" | "none";
    projectBudgetCount: number;
  }>({
    globalMonthlyBudgetUsd: null,
    suggestedGlobalBudgetUsd: null,
    effectiveGlobalBudgetUsd: null,
    globalBudgetSource: "none",
    projectBudgetCount: 0,
  });
  const [globalBudgetOpen, setGlobalBudgetOpen] = useState(false);
  const [projectedOpen, setProjectedOpen] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/budget-status", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (cancelled || !body || !Array.isArray(body.providers)) return;
        const map: Record<string, ProviderBudgetIntel> = {};
        for (const row of body.providers) {
          if (!row || typeof row.id !== "string") continue;
          map[row.id] = {
            projectedStatus: row.projectedStatus ?? null,
            projectedRunoutDate: row.projectedRunoutDate ?? null,
            daysUntilBudgetExhausted: row.daysUntilBudgetExhausted ?? null,
          };
        }
        setBudgetIntelByProviderId(map);
        const summary = body.summary;
        if (summary && typeof summary === "object") {
          setGlobalBudget({
            globalMonthlyBudgetUsd:
              typeof summary.globalMonthlyBudgetUsd === "number"
                ? summary.globalMonthlyBudgetUsd
                : null,
            suggestedGlobalBudgetUsd:
              typeof summary.suggestedGlobalBudgetUsd === "number"
                ? summary.suggestedGlobalBudgetUsd
                : null,
            effectiveGlobalBudgetUsd:
              typeof summary.effectiveGlobalBudgetUsd === "number"
                ? summary.effectiveGlobalBudgetUsd
                : null,
            globalBudgetSource:
              summary.globalBudgetSource === "override" ||
              summary.globalBudgetSource === "suggested"
                ? summary.globalBudgetSource
                : "none",
            projectBudgetCount:
              typeof summary.projectBudgetCount === "number"
                ? summary.projectBudgetCount
                : 0,
          });
        }
      })
      .catch(() => {
        // Best-effort surface; the dashboard works without it.
      });
    return () => {
      cancelled = true;
    };
  }, [lastUpdatedAt]);

  const totalProviderFunds = useMemo(() => sumProviderFunds(providers), [providers]);
  // S6: thread computeBudgetStatus's authoritative fixedAccruedUsd (already on
  // each provider from /api/providers?view=dashboard) into the portfolio
  // aggregator explicitly, so the family math consumes the reconcile rather
  // than the legacy fallback derivation.
  const portfolioMoney = useMemo(
    () =>
      aggregateProviderPortfolioMoney(
        (providers || []).map(
          (provider: any): ProviderMoneyMember => ({
            id: provider.id,
            name: provider.name,
            groupId: provider.groupId ?? null,
            billingAccount: provider.billingAccount ?? null,
            spentUsd: provider.spentUsd ?? null,
            projectedEomUsd: provider.projectedEomUsd ?? 0,
            snapshotCostUsd: provider.snapshotCostUsd ?? null,
            snapshotCostFetchedAt: provider.snapshotCostFetchedAt ?? null,
            snapshotCostWindowStart: provider.snapshotCostWindowStart ?? null,
            snapshotCostWindowEnd: provider.snapshotCostWindowEnd ?? null,
            snapshotCostScope: provider.snapshotCostScope ?? null,
            snapshotFixedCostIncludedUsd: provider.snapshotFixedCostIncludedUsd,
            pushedMonthToDateUsd: provider.pushedMonthToDateUsd,
            receiptCashPaidUsd: provider.receiptCashPaidUsd,
            subscriptionMonthToDateUsd: provider.subscriptionMonthToDateUsd,
            fixedMonthlyCostUsd: provider.fixedMonthlyCostUsd,
            linkedFixedDedupeUsd: provider.linkedFixedDedupeUsd,
            forecastedSubscriptionRenewalsUsd: provider.forecastedSubscriptionRenewalsUsd,
            fixedAccruedUsd: Number.isFinite(provider.fixedAccruedUsd)
              ? provider.fixedAccruedUsd
              : null,
          })
        )
      ),
    [providers]
  );
  const {
    totalCost,
    totalProjectedMonthlyCost,
    ambiguousCostFamilyCount,
    incompleteCostFamilyCount,
  } = portfolioMoney;

  // History/telemetry window label — not the MTD budget hero period.
  const historyWindowLabel = useMemo(() => historyRangeLabel(timeframe), [timeframe]);
  const mtdMonthLabel = useMemo(() => mtdSpendLabel(), []);

  const incompleteCostProviderCount = useMemo(
    () =>
      (providers || []).filter(
        (provider: any) => provider?.isActive && provider?.spendCoverage !== "complete"
      ).length,
    [providers]
  );

  // Prefer Global Budget (override or sum of project budgets). Fall back to
  // sum of provider plan budgets only when global is unset.
  const providerPlanBudgetSum = useMemo(() => {
    let sum = 0;
    let any = false;
    for (const provider of providers || []) {
      const budget = provider?.plan?.monthlyBudgetUsd;
      if (budget != null && Number.isFinite(budget) && budget > 0) {
        sum += budget;
        any = true;
      }
    }
    return any ? sum : null;
  }, [providers]);

  const totalBudgetUsd =
    globalBudget.effectiveGlobalBudgetUsd != null
      ? globalBudget.effectiveGlobalBudgetUsd
      : providerPlanBudgetSum;

  const budgetedProviderCount = useMemo(
    () =>
      (providers || []).filter((provider: any) => {
        const budget = provider?.plan?.monthlyBudgetUsd;
        return budget != null && Number.isFinite(budget) && budget > 0;
      }).length,
    [providers]
  );

  const projectedBreakdown = useMemo(() => {
    let fixedAccruedUsd = 0;
    let projectedVariableUsd = 0;
    let knownRenewalsUsd = 0;
    const renewals: ProjectedRenewalRow[] = [];
    for (const provider of providers || []) {
      const fixed = Number(provider?.fixedAccruedUsd);
      if (Number.isFinite(fixed)) fixedAccruedUsd += fixed;
      const variable = Number(provider?.projectedVariableUsageUsd);
      if (Number.isFinite(variable)) projectedVariableUsd += variable;
      const renew = Number(provider?.forecastedSubscriptionRenewalsUsd);
      if (Number.isFinite(renew)) knownRenewalsUsd += renew;
      const lines = Array.isArray(provider?.forecastedRenewals)
        ? provider.forecastedRenewals
        : [];
      for (const line of lines) {
        if (!line || typeof line.subscriptionId !== "string") continue;
        renewals.push({
          subscriptionId: line.subscriptionId,
          providerId: line.providerId ?? provider.id,
          name: line.name ?? "Subscription",
          chargeUsd: Number(line.chargeUsd) || 0,
          chargeAt: line.chargeAt,
          autoRenew: Boolean(line.autoRenew),
          providerDisplayName: provider.displayName ?? provider.name,
        });
      }
    }
    return {
      fixedAccruedUsd,
      projectedVariableUsd,
      knownRenewalsUsd,
      renewals,
    };
  }, [providers]);

  const chartFamilies = useMemo(
    () =>
      (portfolioMoney.families || []).map((family: any) => {
        const members = (providers || []).filter(
          (p: any) => (canonicalProviderKey(p?.name || "") || p?.id) === family?.key
        );
        const displayName =
          members.find((m: any) => m?.displayName)?.displayName ?? family?.displayName;
        return {
          displayName,
          projectedEomUsd: family?.projectedEomUsd,
          exact: family?.exact,
        };
      }),
    [portfolioMoney.families, providers]
  );

  const attentionItems = useMemo(
    () =>
      (providers || [])
        .flatMap((provider: any) =>
          (provider?.alerts || [])
            .filter((alert: any) => alert?.severity !== "info")
            .map((alert: any) => ({ provider, alert }))
        )
        .sort((left: any, right: any) => {
          const severityRank = { critical: 0, warning: 1, info: 2 } as const;
          const leftRank = severityRank[left?.alert?.severity as keyof typeof severityRank] ?? 2;
          const rightRank = severityRank[right?.alert?.severity as keyof typeof severityRank] ?? 2;
          return (
            leftRank - rightRank ||
            (left?.provider?.displayName || "").localeCompare(right?.provider?.displayName || "") ||
            (left?.alert?.message || "").localeCompare(right?.alert?.message || "")
          );
        }),
    [providers]
  );

  const criticalCount = useMemo(
    () => attentionItems.filter((item) => item.alert?.severity === "critical").length,
    [attentionItems]
  );

  const warningCount = useMemo(
    () => attentionItems.filter((item) => item.alert?.severity === "warning").length,
    [attentionItems]
  );

  const accountStatus = useMemo(
    () =>
      deriveAccountStatus({
        criticalCount,
        warningCount,
        incompleteCostCount: incompleteCostProviderCount + incompleteCostFamilyCount,
        totalSpentUsd: totalCost,
        totalBudgetUsd,
      }),
    [
      criticalCount,
      warningCount,
      incompleteCostProviderCount,
      incompleteCostFamilyCount,
      totalCost,
      totalBudgetUsd,
    ]
  );

  // Open portfolio on critical/incomplete, and default-open on desktop once.
  useEffect(() => {
    if (autoOpenedPortfolio.current || loading || portfolioOpen) return;
    if (criticalCount > 0 || incompleteCostFamilyCount > 0 || incompleteCostProviderCount > 0) {
      autoOpenedPortfolio.current = true;
      setPortfolioOpen(true);
      return;
    }
    if (
      !desktopPortfolioDefault.current &&
      typeof window !== "undefined" &&
      window.matchMedia("(min-width: 1024px)").matches
    ) {
      desktopPortfolioDefault.current = true;
      autoOpenedPortfolio.current = true;
      setPortfolioOpen(true);
    }
  }, [
    criticalCount,
    incompleteCostFamilyCount,
    incompleteCostProviderCount,
    loading,
    portfolioOpen,
    setPortfolioOpen,
  ]);

  const portfolioSummaryParts = [
    `${subscriptions.length} paid service${subscriptions.length === 1 ? "" : "s"}`,
  ];
  if (projects.length > 0 || (projectSummary?.unassignedSpentUsd ?? 0) > 0) {
    portfolioSummaryParts.push(`${projects.length} project${projects.length === 1 ? "" : "s"}`);
  }
  portfolioSummaryParts.push(
    `${attentionItems.length} open alert${attentionItems.length === 1 ? "" : "s"}`
  );
  const portfolioSummary = `${portfolioSummaryParts.join(" · ")} · charts & intelligence`;

  // Push provider shortcuts into the site-wide CommandPalette (mounted in Nav).
  useEffect(() => {
    const items: CommandPaletteProviderItem[] = (providers || []).map((p: any) => ({
      id: p.id,
      label: p.displayName || p.name,
    }));
    window.dispatchEvent(
      new CustomEvent(COMMAND_PALETTE_PROVIDERS_EVENT, { detail: items })
    );
  }, [providers]);

  // Never blank the dashboard once provider rows are on screen — a later
  // loading=true race was flashing content then sticking on skeletons.
  if (shouldShowDashboardSkeleton({ loading, providerCount: providers.length })) {
    return (
      <div className="space-y-8 animate-pulse">
        <div className="h-8 w-48 bg-gray-200 dark:bg-gray-700 rounded"></div>
        <div className="bg-gray-100 dark:bg-gray-800 rounded-2xl border border-gray-200 dark:border-gray-700 h-40"></div>
        <div className="bg-gray-100 dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 h-24"></div>
        <div className="bg-gray-100 dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 h-96"></div>
      </div>
    );
  }

  if (error && providers.length === 0) {
    return (
      <EmptyState
        title="Couldn't load Overview"
        message={error}
        action={
          <button
            type="button"
            onClick={() => fetchProviders()}
            className="min-h-11 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            Retry
          </button>
        }
      />
    );
  }

  if (!loading && providers.length === 0) {
    return (
      <EmptyState
        title="No providers yet"
        message="Connect an API provider, set a monthly budget, and Overview will show spend, pace, and alerts in one place."
        icon={
          <svg className="h-7 w-7" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6v12m6-6H6" />
          </svg>
        }
        action={
          <Link
            href="/settings?tab=connections"
            className="inline-flex min-h-11 items-center rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            Add your first provider
          </Link>
        }
      />
    );
  }

  return (
    <div className="space-y-6 sm:space-y-8">

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-gray-100">Overview</h1>
          <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">
            Month-to-date budgets (UTC)
            {lastUpdatedAt && (
              <span>
                {" · "}
                Updated{" "}
                <time dateTime={new Date(lastUpdatedAt).toISOString()}>
                  {new Date(lastUpdatedAt).toLocaleTimeString([], {
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </time>
              </span>
            )}
            <span className="hidden sm:inline">
              {" · "}
              <kbd className="rounded border border-gray-300 px-1 font-sans text-xs dark:border-gray-600">
                ⌘K
              </kbd>{" "}
              to jump
            </span>
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refreshDashboard()}
          disabled={refreshing}
          className="min-h-11 shrink-0 rounded-xl border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-800 shadow-sm hover:border-gray-400 hover:bg-gray-50 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:hover:border-gray-500 dark:hover:bg-gray-800"
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {/* Section jump links — especially useful on mobile long scrolls */}
      <nav
        aria-label="Overview sections"
        className="flex gap-2 overflow-x-auto pb-1 text-xs font-medium sm:hidden"
      >
        {[
          { href: "#spend", label: "Spend" },
          { href: "#attention", label: "Alerts" },
          { href: "#providers", label: "Providers" },
          { href: "#operations", label: "Ops" },
          { href: "#portfolio", label: "Charts" },
        ].map((item) => (
          <a
            key={item.href}
            href={item.href}
            className="min-h-9 shrink-0 rounded-full border border-gray-200 bg-white px-3 py-1.5 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
          >
            {item.label}
          </a>
        ))}
      </nav>

      {warnings.length > 0 && (
        <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          {warnings.join(" ")}
        </div>
      )}

      <div id="spend" className="scroll-mt-20 space-y-4">
        <DashboardHero
          totalCost={totalCost}
          totalProjectedMonthlyCost={totalProjectedMonthlyCost}
          totalBudgetUsd={totalBudgetUsd}
          budgetedProviderCount={budgetedProviderCount}
          incompleteCostProviderCount={
            incompleteCostProviderCount + incompleteCostFamilyCount
          }
          ambiguousCostFamilyCount={ambiguousCostFamilyCount}
          accountStatus={accountStatus}
          spendPeriodLabel={historyWindowLabel}
          mtdMonthLabel={mtdMonthLabel}
          globalBudgetSource={
            globalBudget.effectiveGlobalBudgetUsd != null
              ? globalBudget.globalBudgetSource
              : "none"
          }
          onOpenGlobalBudget={() => setGlobalBudgetOpen(true)}
          onOpenProjectedBreakdown={() => setProjectedOpen(true)}
        />
        <GlobalBudgetModal
          open={globalBudgetOpen}
          onClose={() => setGlobalBudgetOpen(false)}
          globalMonthlyBudgetUsd={globalBudget.globalMonthlyBudgetUsd}
          suggestedGlobalBudgetUsd={globalBudget.suggestedGlobalBudgetUsd}
          projectBudgetCount={globalBudget.projectBudgetCount}
          onSaved={(next) => setGlobalBudget(next)}
        />
        <ProjectedCostBreakdownModal
          open={projectedOpen}
          onClose={() => setProjectedOpen(false)}
          totalProjectedUsd={totalProjectedMonthlyCost}
          fixedAccruedUsd={projectedBreakdown.fixedAccruedUsd}
          projectedVariableUsd={projectedBreakdown.projectedVariableUsd}
          knownRenewalsUsd={projectedBreakdown.knownRenewalsUsd}
          renewals={projectedBreakdown.renewals}
          mtdMonthLabel={mtdMonthLabel}
        />

        <DashboardSummaryCards
          totalProviderFunds={totalProviderFunds}
          totalProjectedMonthlyCost={totalProjectedMonthlyCost}
          totalCost={totalCost}
          incompleteCostProviderCount={
            incompleteCostProviderCount + incompleteCostFamilyCount
          }
          ambiguousCostFamilyCount={ambiguousCostFamilyCount}
          attentionItemsCount={attentionItems.length}
          criticalCount={criticalCount}
          spendPeriodLabel={mtdMonthLabel}
          onAlertsNavigate={openAttentionPanel}
          accountStatus={accountStatus}
        />
      </div>

      <DashboardAttentionPanel
        attentionItems={attentionItems}
        budgetIntelByProviderId={budgetIntelByProviderId}
      />

      {/* Collapse legend chrome when all costs are complete */}
      {(incompleteCostProviderCount > 0 || incompleteCostFamilyCount > 0) && (
        <CostCoverageLegend />
      )}

      <div id="providers" className="scroll-mt-20">
        <DashboardProviderWorkspace
          providers={providers}
          subscriptions={subscriptions}
          budgetIntelByProviderId={budgetIntelByProviderId}
        />
      </div>

      <div id="portfolio" className="scroll-mt-20 space-y-3">
        <HistoryWindowControl
          value={timeframe as TimeframeOption}
          onChange={(next) => setTimeframe(next)}
          className="w-full"
        />
        <DashboardPortfolioSection
          portfolioOpen={portfolioOpen}
          onToggle={setPortfolioOpen}
          portfolioLoading={portfolioLoading}
          portfolioLoaded={portfolioLoaded}
          portfolioError={portfolioError}
          fetchPortfolioData={fetchPortfolioData}
          providers={providers}
          subscriptions={subscriptions}
          usageSummary={usageSummary}
          projects={projects}
          projectSummary={projectSummary}
          chartFamilies={chartFamilies}
          portfolioSummary={portfolioSummary}
          attentionCount={attentionItems.length}
          timeframe={timeframe as TimeframeOption}
        />
      </div>

      <div id="operations" className="scroll-mt-20">
        <div className="mb-2">
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">
            Infrastructure &amp; ops
          </h2>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            R2 free-tier (UM / ST / CT), receipt inbox, and sibling health — not part of spend totals.
          </p>
        </div>
        <OperationsOverview />
      </div>
    </div>
  );
}
