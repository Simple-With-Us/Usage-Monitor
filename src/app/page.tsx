"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { ChevronRight } from "lucide-react";
import {
  type ProviderCostCoverage,
  type ProviderCostCoverageCaveat,
} from "@/components/ProviderCard";
import SentryHealthCard from "@/components/SentryHealthCard";
import DashboardSummaryCards from "@/components/DashboardSummaryCards";
import CostCoverageLegend from "@/components/CostCoverageLegend";
import ExternalTelemetryPanel, { type ExternalUsageSummary } from "@/components/ExternalTelemetryPanel";
import ProjectsPanel, { type ProjectBudgetStatus } from "@/components/ProjectsPanel";
import type { ExternalBillingRecord } from "@/components/ExternalBillingDetails";
import PaidServicesPanel from "@/components/PaidServicesPanel";
import type { SubscriptionRow } from "@/components/SubscriptionsPanel";
import DashboardProviderWorkspace from "@/components/DashboardProviderWorkspace";
import OperationsOverview from "@/components/OperationsOverview";
import { sumProviderFunds } from "@/lib/provider-financial-semantics";
import { canonicalProviderKey } from "@/lib/provider-identity";
import { aggregateProviderPortfolioMoney } from "@/lib/provider-money-aggregation";

interface Provider {
  id: string;
  name: string;
  displayName: string;
  type: string;
  refreshIntervalMin: number;
  isActive: boolean;
  groupId: string | null;
  billingAccount: {
    matchKey: string;
    evidence: "explicit_account" | "shared_credential";
  } | null;
  label: string | null;
  keyPreview?: string | null;
  anthropicAdminApiConfigured?: boolean;
  geminiKeyStatus?: {
    state: "valid" | "invalid" | "unreadable" | "unavailable" | "unchecked" | "not_configured";
    httpStatus: number | null;
    availableModelCount: number | null;
    checkedAt: string | null;
  } | null;
  geminiBillingStatus?: {
    state: "ready" | "pending" | "error" | "configuration_changed" | "unchecked" | "not_configured";
    errorCode: string | null;
    httpStatus: number | null;
    retryable: boolean;
    checkedAt: string | null;
  } | null;
  geminiMonitoringStatus?: {
    state: "ready" | "empty" | "partial" | "permission_denied" | "error" | "configuration_changed" | "project_required" | "credential_required" | "unchecked" | "not_configured";
    projectId: string | null;
    errorCode: string | null;
    httpStatus: number | null;
    retryable: boolean;
    checkedAt: string | null;
  } | null;
  config?: Record<string, unknown>;
  secretConfigMeta?: { configured: boolean; fields: string[]; readable: boolean };
  estimatedMonthlyCostUsd: number;
  projectedEomUsd: number;
  spentUsd?: number;
  receiptCashPaidUsd?: number;
  receiptCashEventCount?: number;
  observedVariableUsageUsd?: number;
  snapshotCostUsd?: number | null;
  pushedMonthToDateUsd?: number;
  subscriptionMonthToDateUsd?: number;
  fixedMonthlyCostUsd?: number;
  linkedFixedDedupeUsd?: number;
  forecastedSubscriptionRenewalsUsd?: number;
  snapshotFixedCostIncludedUsd?: number;
  estimatedApiEquivalentUsd?: number;
  snapshotCostFetchedAt?: string | null;
  snapshotCostWindowStart?: string | null;
  snapshotCostWindowEnd?: string | null;
  snapshotCostScope?: string | null;
  spendCoverage: ProviderCostCoverage;
  costCoverageCaveat?: ProviderCostCoverageCaveat | null;
  pushedCostCoverage: ProviderCostCoverage;
  pushedPricedEventCount: number;
  pushedUnpricedEventCount: number;
  pushedUnclassifiedCostEventCount: number;
  externalBilling?: ExternalBillingRecord[];
  externalBillingHiddenCount?: number;
  plan: {
    fixedMonthlyCostUsd: number | null;
    monthlyBudgetUsd: number | null;
    monthlyRequestLimit: number | null;
    renewalDate: string | null;
    billingInterval: string | null;
    notes: string | null;
  } | null;
  billingMode: "actual" | "estimated" | "manual";
  alerts: {
    severity: "critical" | "warning" | "info";
    message: string;
  }[];
  latestSnapshot: {
    balance: number | null;
    totalCost: number | null;
    totalRequests: number | null;
    credits: number | null;
    fetchedAt: string;
  } | null;
}

interface ProjectBudgetResponse {
  projects: ProjectBudgetStatus[];
  summary: {
    totalSpentUsd: number;
    unbudgetedSpentUsd: number;
    unassignedSpentUsd: number;
  };
}

async function fetchJson<T>(url: string, label: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Failed to fetch ${label}`);
  }
  return response.json() as Promise<T>;
}

const AUTO_REFRESH_INTERVAL_MS = 60_000;
const FOCUS_REFRESH_THROTTLE_MS = 15_000;
const DashboardCharts = dynamic(() => import("@/components/DashboardCharts"));

export default function DashboardPage() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [usageSummary, setUsageSummary] = useState<ExternalUsageSummary | null>(null);
  const [projects, setProjects] = useState<ProjectBudgetStatus[]>([]);
  const [subscriptions, setSubscriptions] = useState<SubscriptionRow[]>([]);
  const [projectSummary, setProjectSummary] = useState<ProjectBudgetResponse["summary"] | null>(null);
  const [portfolioOpen, setPortfolioOpen] = useState(false);
  const [portfolioLoaded, setPortfolioLoaded] = useState(false);
  const [portfolioLoading, setPortfolioLoading] = useState(false);
  const [portfolioError, setPortfolioError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const loadedOnce = useRef(false);
  const hasProviderData = useRef(false);
  const isFetchingRef = useRef(false);
  const lastSuccessAtRef = useRef(0);
  const portfolioDetailsRef = useRef<HTMLDetailsElement>(null);
  const portfolioFetchInFlightRef = useRef(false);

  const fetchProviders = useCallback(async (opts?: { background?: boolean }) => {
    const background = opts?.background === true;
    // Background refreshes (interval poll, focus/visibility refetch) must never blank
    // the UI or disable the manual refresh button - only data and the timestamp update.
    // Foreground calls (initial load, manual refresh/retry) show refreshing/loading and
    // clear the error/warnings immediately, matching prior behavior - clearing them up
    // front for background calls would instead flash the (still-empty) main content or
    // blank the visible warnings banner mid-flight. setWarnings(nextWarnings) below always
    // runs after Promise.allSettled (which never rejects), so background outcomes still
    // update the banner atomically once the fetch settles.
    const startForegroundUiState = () => {
      if (loadedOnce.current && hasProviderData.current) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
      setError("");
      setWarnings([]);
    };

    if (isFetchingRef.current) {
      // Guard against overlapping in-flight refreshes: don't start a second fetch.
      // Background calls just no-op here - the in-flight fetch already covers them. But a
      // foreground call (manual refresh/retry) must not silently drop the click with no
      // feedback: "upgrade" the in-flight fetch by applying the same UI state a fresh
      // foreground call would, then return without starting one. The in-flight fetch's own
      // finally block clears refreshing/loading unconditionally once it settles, so the
      // button reflects the outcome either way.
      if (!background) startForegroundUiState();
      return;
    }
    isFetchingRef.current = true;

    if (background) {
      // no loading/refreshing UI state
    } else {
      startForegroundUiState();
    }

    try {
      const [providersResult, subscriptionsResult] = await Promise.allSettled([
        fetchJson<Provider[]>("/api/providers?view=dashboard", "providers"),
        fetchJson<SubscriptionRow[]>("/api/subscriptions", "paid services"),
      ]);

      const nextWarnings: string[] = [];
      if (providersResult.status === "fulfilled") {
        setProviders(providersResult.value);
        hasProviderData.current = true;
        setError("");
      } else if (!hasProviderData.current) {
        setError(providersResult.reason instanceof Error ? providersResult.reason.message : "Failed to load providers");
      } else {
        nextWarnings.push("Provider data could not be refreshed; showing the last successful result.");
      }

      if (subscriptionsResult.status === "fulfilled") {
        setSubscriptions(subscriptionsResult.value);
      } else {
        nextWarnings.push("Tracked subscriptions are temporarily unavailable.");
      }

      setWarnings(nextWarnings);
      if (providersResult.status === "fulfilled") {
        setLastUpdatedAt(new Date().toISOString());
        lastSuccessAtRef.current = Date.now();
      }
    } finally {
      loadedOnce.current = true;
      // Cleared unconditionally: background calls never set these to true, and this also
      // covers the case where a foreground call "upgraded" this in-flight fetch via the
      // guard above and set them itself.
      setLoading(false);
      setRefreshing(false);
      isFetchingRef.current = false;
    }
  }, []);

  const fetchPortfolioData = useCallback(async () => {
    if (portfolioFetchInFlightRef.current) return;
    portfolioFetchInFlightRef.current = true;
    setPortfolioLoading(true);
    setPortfolioError("");
    const failures: string[] = [];
    try {
      try {
        setUsageSummary(
          await fetchJson<ExternalUsageSummary>(
            "/api/usage-events?days=30",
            "app telemetry"
          )
        );
      } catch {
        failures.push("External app telemetry is temporarily unavailable.");
      }
      // Keep the two raw-telemetry aggregations sequential on SQLite's single
      // connection instead of starting both expensive reads together.
      try {
        const response = await fetchJson<ProjectBudgetResponse>(
          "/api/projects?includeSummary=1",
          "projects"
        );
        setProjects(response.projects);
        setProjectSummary(response.summary);
      } catch {
        failures.push("Project budgets are temporarily unavailable.");
      }
      setPortfolioError(failures.join(" "));
      setPortfolioLoaded(failures.length === 0);
    } finally {
      setPortfolioLoading(false);
      portfolioFetchInFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    fetchProviders();
  }, [fetchProviders]);

  useEffect(() => {
    // Refetch on regained focus / visibility, throttled so tab-switching doesn't
    // hammer the API when the last refresh (poll, focus, or manual) was recent.
    const refreshIfDue = () => {
      if (document.hidden) return;
      if (Date.now() - lastSuccessAtRef.current < FOCUS_REFRESH_THROTTLE_MS) return;
      fetchProviders({ background: true });
    };

    // Skip ticks while the tab is hidden; visibilitychange picks up the refresh on return.
    const handleIntervalTick = () => {
      if (document.hidden) return;
      fetchProviders({ background: true });
    };

    const handleVisibilityChange = () => {
      if (!document.hidden) refreshIfDue();
    };

    const intervalId = window.setInterval(handleIntervalTick, AUTO_REFRESH_INTERVAL_MS);
    window.addEventListener("focus", refreshIfDue);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refreshIfDue);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [fetchProviders]);

  // Always-visible Attention strip (Wave D / D1). Scroll only — no longer
  // buried inside the Portfolio detail accordion.
  const openAttentionPanel = useCallback(() => {
    window.requestAnimationFrame(() => {
      document.getElementById("attention")?.scrollIntoView({ block: "start" });
    });
  }, []);

  useEffect(() => {
    if (!portfolioOpen) return;
    if (!document.hidden) void fetchPortfolioData();
    const interval = window.setInterval(
      () => {
        if (!document.hidden) void fetchPortfolioData();
      },
      AUTO_REFRESH_INTERVAL_MS
    );
    return () => window.clearInterval(interval);
  }, [fetchPortfolioData, portfolioOpen]);

  useEffect(() => {
    const openIfAttentionHash = () => {
      if (window.location.hash !== "#attention") return;
      openAttentionPanel();
    };
    openIfAttentionHash();
    window.addEventListener("hashchange", openIfAttentionHash);
    return () => window.removeEventListener("hashchange", openIfAttentionHash);
  }, [loading, openAttentionPanel]); // re-run after the skeleton is replaced - the details ref is null during loading

  const refreshDashboard = useCallback(async () => {
    await fetchProviders();
    if (portfolioOpen) await fetchPortfolioData();
  }, [fetchPortfolioData, fetchProviders, portfolioOpen]);

  const totalProviderFunds = sumProviderFunds(providers);
  const portfolioMoney = aggregateProviderPortfolioMoney(providers);
  const {
    totalCost,
    totalProjectedMonthlyCost,
    ambiguousCostFamilyCount,
    incompleteCostFamilyCount,
  } = portfolioMoney;
  const incompleteCostProviderCount = providers.filter(
    (provider) => provider.isActive && provider.spendCoverage !== "complete"
  ).length;
  const chartFamilies = portfolioMoney.families.map((family) => {
    const members = providers.filter(
      (p) => (canonicalProviderKey(p.name) || p.id) === family.key
    );
    const displayName =
      members.find((m) => m.displayName)?.displayName ?? family.displayName;
    return {
      displayName,
      projectedEomUsd: family.projectedEomUsd,
      exact: family.exact,
    };
  });
  const attentionItems = providers.flatMap((provider) =>
    provider.alerts
      .filter((alert) => alert.severity !== "info")
      .map((alert) => ({ provider, alert }))
  ).sort((left, right) => {
    const severityRank = { critical: 0, warning: 1, info: 2 } as const;
    return (
      severityRank[left.alert.severity] - severityRank[right.alert.severity] ||
      left.provider.displayName.localeCompare(right.provider.displayName) ||
      left.alert.message.localeCompare(right.alert.message)
    );
  });
  const criticalCount = attentionItems.filter(
    (item) => item.alert.severity === "critical"
  ).length;

  // "Portfolio detail" accordion summary line - page-level state only (no Sentry/telemetry
  // counts: SentryHealthCard fetches its own data and page.tsx has no Sentry state).
  const portfolioSummaryParts = [
    `${subscriptions.length} paid service${subscriptions.length === 1 ? "" : "s"}`,
  ];
  if (projects.length > 0 || (projectSummary?.unassignedSpentUsd ?? 0) > 0) {
    portfolioSummaryParts.push(`${projects.length} project${projects.length === 1 ? "" : "s"}`);
  }
  portfolioSummaryParts.push(
    `${attentionItems.length} open alert${attentionItems.length === 1 ? "" : "s"}`
  );
  const portfolioSummary = `${portfolioSummaryParts.join(" · ")} · charts & health`;

  if (loading) {
    return (
      <div className="space-y-8 animate-pulse">
        <div className="h-8 w-48 bg-gray-200 rounded"></div>
        <div className="bg-gray-100 rounded-xl border border-gray-200 h-24"></div>
        <div className="bg-gray-100 rounded-xl border border-gray-200 h-96"></div>
        <div className="bg-gray-100 rounded-xl border border-gray-200 h-14"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4">
        <p role="alert" className="text-red-600 dark:text-red-300">{error}</p>
        <button
          type="button"
          onClick={() => fetchProviders()}
          className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-900"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Dashboard</h1>
        <div className="flex items-center gap-3">
          {lastUpdatedAt && (
            <span className="hidden text-xs text-gray-500 dark:text-gray-400 sm:inline">
              Updated {new Date(lastUpdatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
            </span>
          )}
          <button
            type="button"
            onClick={() => void refreshDashboard()}
            disabled={refreshing}
            className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {warnings.length > 0 && (
        <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          {warnings.join(" ")}
        </div>
      )}

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
        onAlertsNavigate={openAttentionPanel}
      />

      <div
        id="attention"
        className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden"
      >
        <div className="px-4 py-3 sm:px-6 border-b border-gray-100 dark:border-gray-700 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">
            Attention
          </h2>
          <Link
            href="/settings"
            className="text-xs font-medium text-blue-600 dark:text-blue-400"
          >
            Manage budgets
          </Link>
        </div>
        {attentionItems.length === 0 ? (
          <div className="px-4 py-4 sm:px-6 text-sm text-gray-500 dark:text-gray-400">
            No payment, budget, or limit alerts.
          </div>
        ) : (
          <div className="divide-y divide-gray-100 dark:divide-gray-700">
            {attentionItems.slice(0, 8).map(({ provider, alert }, index) => (
                <div
                  key={`${provider.id}-${index}-${alert.message.slice(0, 24)}`}
                  className="flex flex-wrap items-start justify-between gap-3 px-4 py-3 sm:px-6 hover:bg-gray-50 dark:hover:bg-gray-900/40"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                      {provider.displayName}
                      {provider.label ? ` - ${provider.label}` : ""}
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                      {alert.message}
                    </p>
                    <div className="mt-1.5 flex flex-wrap gap-2">
                      <Link
                        href={`/providers/${provider.id}`}
                        className="text-xs font-medium text-blue-600 dark:text-blue-400"
                      >
                        Open provider
                      </Link>
                      <Link
                        href={`/providers/${provider.id}`}
                        className="text-xs font-medium text-blue-600 dark:text-blue-400"
                      >
                        Edit budget
                      </Link>
                    </div>
                  </div>
                  <span
                    className={`text-xs font-medium px-2 py-1 rounded-full shrink-0 ${
                      alert.severity === "critical"
                        ? "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300"
                        : "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
                    }`}
                  >
                    {alert.severity}
                  </span>
                </div>
            ))}
            {attentionItems.length > 8 && (
              <div className="px-4 py-3 sm:px-6 text-xs text-gray-500 dark:text-gray-400">
                +{attentionItems.length - 8} more — open a provider or filter
                the workspace by Alerts only.
              </div>
            )}
          </div>
        )}
      </div>

      <CostCoverageLegend />

      <DashboardProviderWorkspace providers={providers} subscriptions={subscriptions} />

      <OperationsOverview />

      <details
        ref={portfolioDetailsRef}
        className="group"
        onToggle={(event) => {
          const open = event.currentTarget.open;
          setPortfolioOpen(open);
        }}
      >
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded-xl border border-gray-200 bg-white px-6 py-4 text-sm font-semibold text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-700/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:focus-visible:ring-blue-400 [&::-webkit-details-marker]:hidden">
          <ChevronRight className="h-4 w-4 shrink-0 text-gray-400 transition-transform group-open:rotate-90" aria-hidden="true" />
          Portfolio detail
          <span className="ml-1 min-w-0 truncate text-xs font-normal text-gray-500 dark:text-gray-400">
            {portfolioSummary}
          </span>
        </summary>
        {portfolioOpen && (
        <div className="mt-8 space-y-8">
          {portfolioLoading && !portfolioLoaded && (
            <div role="status" className="rounded-xl border border-gray-200 bg-white px-6 py-5 text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
              Loading portfolio detail…
            </div>
          )}
          {portfolioError && (
            <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
              <span>{portfolioError}</span>{" "}
              <button
                type="button"
                onClick={() => void fetchPortfolioData()}
                className="font-semibold underline underline-offset-2"
              >
                Retry
              </button>
            </div>
          )}
          <PaidServicesPanel
            providers={providers}
            subscriptions={subscriptions}
            variant="dashboard"
            maxItems={6}
          />

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            <div className="lg:col-span-2 space-y-8">
              {usageSummary && <ExternalTelemetryPanel usageSummary={usageSummary} />}

              {(projects.length > 0 || (projectSummary?.unassignedSpentUsd ?? 0) > 0) && (
                <ProjectsPanel projects={projects} summary={projectSummary} />
              )}
            </div>
            <div className="space-y-8">
              <DashboardCharts families={chartFamilies} />
              <SentryHealthCard />
            </div>
          </div>

        </div>
        )}
      </details>
    </div>
  );
}
