"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import UsageChart from "@/components/UsageChart";
import BalanceBadge from "@/components/BalanceBadge";
import type { ExternalBillingRecord } from "@/components/ExternalBillingDetails";
import ProviderIntegrationInfo, { publicConfigFieldNames } from "@/components/ProviderIntegrationInfo";
import PaidServicesPanel from "@/components/PaidServicesPanel";
import type { SubscriptionRow } from "@/components/SubscriptionsPanel";
import type {
  ProviderCostCoverage,
  ProviderCostCoverageCaveat,
} from "@/components/ProviderCard";
import { usageUnitLabelForProvider } from "@/lib/provider-definitions";
import { useDisplayDensity } from "@/lib/display-density";
import { costCoverageHelpText } from "@/lib/cost-coverage-help";
import { CostCoverageCaveatBanner, spendCoverageNoteText } from "./cost-coverage-caveat";
import ProviderConnectionChecklist, {
  buildProviderConnectionChecklist,
} from "@/components/ProviderConnectionChecklist";

/** Short display label for the raw pushed-cost-coverage enum, paired with
 * `costCoverageHelpText` as a title tooltip - same "Complete"/"Partial"/
 * "Unknown" convention used elsewhere on this page and in
 * DashboardProviderWorkspace, so a bare enum value never reaches the UI. */
function pushedCostCoverageLabel(coverage: ProviderCostCoverage | null | undefined): string {
  switch (coverage) {
    case "complete":
      return "Complete";
    case "partial":
      return "Partial";
    case "legacy_unknown":
      return "Unknown (legacy)";
    case "unknown":
    default:
      return "Unknown";
  }
}
import {
  ComplianceSummaryPanel,
  type ProviderComplianceSummaryView,
} from "./compliance-summary";

interface Provider {
  id: string;
  name: string;
  displayName: string;
  type: string;
  config?: Record<string, unknown>;
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
  secretConfigMeta?: { configured: boolean; fields: string[]; readable: boolean };
  refreshIntervalMin: number;
  isActive: boolean;
  label: string | null;
  billingMode: "actual" | "estimated" | "manual";
  estimatedMonthlyCostUsd: number;
  spentUsd?: number;
  projectedEomUsd?: number;
  snapshotCostUsd?: number | null;
  snapshotCostFetchedAt?: string | null;
  pushedMonthToDateUsd?: number;
  receiptCashPaidUsd?: number;
  receiptCashEventCount?: number;
  observedVariableUsageUsd?: number;
  estimatedApiEquivalentUsd?: number;
  pushedCostCoverage: ProviderCostCoverage;
  pushedPricedEventCount: number;
  pushedUnpricedEventCount: number;
  pushedUnclassifiedCostEventCount: number;
  spendCoverage: ProviderCostCoverage;
  costCoverageCaveat?: ProviderCostCoverageCaveat | null;
  compliance?: ProviderComplianceSummaryView | null;
  subscriptionMonthToDateUsd?: number;
  fixedAccruedUsd?: number;
  linkedFixedDedupeUsd?: number;
  fixedCostConflict?: boolean;
  externalBilling?: ExternalBillingRecord[];
  latestSnapshot?: {
    balance: number | null;
    totalCost: number | null;
    totalRequests: number | null;
    credits: number | null;
    fetchedAt: string;
  } | null;
  plan: {
    fixedMonthlyCostUsd: number | null;
    monthlyBudgetUsd: number | null;
    monthlyRequestLimit: number | null;
    lowBalanceUsd: number | null;
    lowCredits: number | null;
    renewalDate: string | null;
    billingInterval: string | null;
    mustKeepFunded: boolean;
    notes: string | null;
  } | null;
  alerts: {
    severity: "critical" | "warning" | "info";
    message: string;
  }[];
}

const SNAPSHOT_PAGE_SIZE = 25;

async function fetchJson<T>(url: string, label: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Failed to fetch ${label}`);
  }
  return response.json() as Promise<T>;
}

interface Snapshot {
  id: string;
  fetchedAt: string;
  balance: number | null;
  totalCost: number | null;
  totalRequests: number | null;
  credits: number | null;
}

export default function ProviderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [provider, setProvider] = useState<Provider | null>(null);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [subscriptions, setSubscriptions] = useState<SubscriptionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [snapshotWarning, setSnapshotWarning] = useState("");
  const [rangeDays, setRangeDays] = useState(30);
  const [snapshotPage, setSnapshotPage] = useState(1);
  const loadedOnce = useRef(false);
  const hasProviderData = useRef(false);
  const density = useDisplayDensity();

  const fetchData = useCallback(async () => {
    if (loadedOnce.current && hasProviderData.current) setRefreshing(true);
    else setLoading(true);
    setError("");
    setSnapshotWarning("");
    try {
      const [providerResult, snapshotsResult, subscriptionsResult] = await Promise.allSettled([
        fetchJson<Provider>(`/api/providers/${id}`, "provider"),
        fetchJson<Snapshot[]>(`/api/snapshots?providerId=${id}&days=${rangeDays}`, "snapshots"),
        fetchJson<SubscriptionRow[]>("/api/subscriptions", "paid services"),
      ]);

      if (providerResult.status === "fulfilled") {
        setProvider(providerResult.value);
        hasProviderData.current = true;
      } else if (!hasProviderData.current) {
        setError(providerResult.reason instanceof Error ? providerResult.reason.message : "Provider not found");
      } else {
        setSnapshotWarning("Provider details could not be refreshed; showing the last successful result.");
      }

      if (snapshotsResult.status === "fulfilled") {
        setSnapshots(snapshotsResult.value);
      } else {
        setSnapshotWarning((current) =>
          [current, "Snapshot history is temporarily unavailable."].filter(Boolean).join(" ")
        );
      }

      if (subscriptionsResult.status === "fulfilled") {
        setSubscriptions(
          subscriptionsResult.value.filter((subscription) => subscription.provider.id === id)
        );
      } else {
        setSnapshotWarning((current) =>
          [current, "Tracked subscriptions are temporarily unavailable."].filter(Boolean).join(" ")
        );
      }
    } finally {
      loadedOnce.current = true;
      setLoading(false);
      setRefreshing(false);
    }
  }, [id, rangeDays]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/exhaustive-deps -- data fetching on mount
    fetchData();
  }, [fetchData]);

  const hasCredits =
    provider?.latestSnapshot?.credits != null || snapshots.some((s) => s.credits != null);
  const openAlerts = (provider?.alerts.filter((a) => a.severity !== "info") ?? []).sort((left, right) => {
    const severityRank = { critical: 0, warning: 1, info: 2 } as const;
    return severityRank[left.severity] - severityRank[right.severity] || left.message.localeCompare(right.message);
  });

  const formatUsd = (amount: number | null | undefined) => {
    if (amount == null) return "--";
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(amount);
  };

  if (loading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="flex items-center justify-between">
          <div className="h-8 w-48 bg-gray-200 rounded"></div>
          <div className="h-6 w-24 bg-gray-200 rounded"></div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-24 rounded-xl border border-gray-200 bg-gray-100 p-4 dark:border-gray-700 dark:bg-gray-800"></div>
          ))}
        </div>
        <div className="h-32 rounded-xl border border-gray-200 bg-gray-100 p-4 dark:border-gray-700 dark:bg-gray-800"></div>
        <div className="h-64 rounded-xl border border-gray-200 bg-gray-100 dark:border-gray-700 dark:bg-gray-800"></div>
      </div>
    );
  }

  if (error || !provider) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4">
        <p role="alert" className="text-red-600 dark:text-red-300">{error || "Not found"}</p>
        <div className="flex flex-wrap justify-center gap-3">
          <button
            type="button"
            onClick={() => void fetchData()}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-900"
          >
            Retry
          </button>
          <Link
            href="/"
            className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            Back to dashboard
          </Link>
        </div>
      </div>
    );
  }

  const latest = snapshots[snapshots.length - 1];
  const latestReading = latest ?? provider.latestSnapshot ?? null;
  const usageUnitLabel = usageUnitLabelForProvider(provider.name, provider.type);
  const newestSnapshots = [...snapshots].reverse();
  const totalSnapshotPages = Math.max(1, Math.ceil(newestSnapshots.length / SNAPSHOT_PAGE_SIZE));
  const currentSnapshotPage = Math.min(snapshotPage, totalSnapshotPages);
  const visibleSnapshots = newestSnapshots.slice(
    (currentSnapshotPage - 1) * SNAPSHOT_PAGE_SIZE,
    currentSnapshotPage * SNAPSHOT_PAGE_SIZE
  );
  const canonicalSpendUsd =
    provider.spentUsd ?? provider.estimatedMonthlyCostUsd;
  const spendCoverage: ProviderCostCoverage =
    provider.spendCoverage ??
    (provider.spentUsd != null || provider.latestSnapshot?.totalCost != null
      ? "complete"
      : "unknown");
  const hasKnownSpend =
    spendCoverage === "complete" || spendCoverage === "partial";
  const unpricedEventCount =
    (provider.pushedUnpricedEventCount ?? 0) +
    (provider.pushedUnclassifiedCostEventCount ?? 0);
  const reconciledFixedUsd = provider.fixedAccruedUsd ?? 0;
  const reconciledMeteredUsd = Math.max(
    0,
    canonicalSpendUsd - reconciledFixedUsd
  );

  return (
    <div className="provider-details space-y-6">
      <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
        <Link href="/" className="hover:text-gray-900 dark:hover:text-gray-100">
          Dashboard
        </Link>
        <span>/</span>
        <span className="text-gray-900 dark:text-gray-100">{provider.displayName}</span>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            {provider.displayName}
          </h1>
          <ProviderIntegrationInfo
            providerName={provider.name}
            providerType={provider.type}
            displayName={provider.displayName}
            variant="button"
            className="mt-2"
            instanceState={{
              isActive: provider.isActive,
              primaryCredentialConfigured:
                Boolean(provider.keyPreview) ||
                (provider.geminiKeyStatus != null &&
                  provider.geminiKeyStatus.state !== "not_configured"),
              keyPreview: provider.keyPreview,
              anthropicAdminApiConfigured:
                provider.anthropicAdminApiConfigured,
              publicConfigFields: publicConfigFieldNames(provider.config),
              protectedConfigFields: provider.secretConfigMeta?.fields ?? [],
              protectedConfigReadable: provider.secretConfigMeta?.readable,
              lastSnapshotAt: provider.latestSnapshot?.fetchedAt ?? latest?.fetchedAt ?? null,
              externalBillingRecordCount: provider.externalBilling?.length ?? 0,
              externalBillingSources: [...new Set((provider.externalBilling ?? []).map((record) => record.source))].sort(),
              geminiKeyStatus: provider.geminiKeyStatus,
              geminiBillingStatus: provider.geminiBillingStatus,
              geminiMonitoringStatus: provider.geminiMonitoringStatus,
            }}
          />
        </div>
        <span className="rounded bg-gray-100 px-2 py-1 text-xs font-medium uppercase text-gray-500 dark:bg-gray-800 dark:text-gray-400">
          {provider.type}
        </span>
      </div>

      <CostCoverageCaveatBanner caveat={provider.costCoverageCaveat} />

      <ProviderConnectionChecklist
        items={buildProviderConnectionChecklist({
          providerId: provider.id,
          hasSnapshot: Boolean(latestReading),
          hasBudget:
            provider.plan?.monthlyBudgetUsd != null &&
            provider.plan.monthlyBudgetUsd > 0,
          spendCoverage,
          isBlindOrPushOnly: /anthropic|voyage|robinhood/i.test(provider.name),
          lastFetchedAt: latestReading?.fetchedAt ?? null,
        })}
        pushOnlyHint={/anthropic|voyage|robinhood/i.test(provider.name)}
      />

      {snapshotWarning && (
        <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          {snapshotWarning}
        </p>
      )}

      {openAlerts.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
          <div className="border-b border-gray-100 px-6 py-4 dark:border-gray-700">
            <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Alerts</h2>
          </div>
          <div className="divide-y divide-gray-100 dark:divide-gray-700">
            {openAlerts.map((alert, index) => (
              <div key={index} className="px-6 py-4 flex items-start gap-3">
                <span
                  className={`mt-0.5 text-xs font-medium px-2 py-1 rounded-full ${
                    alert.severity === "critical"
                      ? "bg-red-50 text-red-700 dark:bg-red-950/60 dark:text-red-300"
                      : "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300"
                  }`}
                >
                  {alert.severity}
                </span>
                <p className="text-sm text-gray-700 dark:text-gray-200">{alert.message}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      <PaidServicesPanel
        providers={[provider]}
        subscriptions={subscriptions}
        variant="provider"
      />

      {/* Summary stats */}
      <div
        className={`grid grid-cols-1 sm:grid-cols-2 ${
          hasCredits ? "lg:grid-cols-5" : "lg:grid-cols-4"
        } gap-4`}
      >
        <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <p className="mb-1 text-xs text-gray-500 dark:text-gray-400">Balance</p>
          <BalanceBadge
            amount={latestReading?.balance ?? null}
            className="text-lg font-semibold"
          />
        </div>
        <div
          className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800"
          title={
            density === "compact"
              ? [
                  provider.snapshotCostFetchedAt
                    ? `Cost snapshot fetched ${new Date(provider.snapshotCostFetchedAt).toLocaleString()}`
                    : null,
                  spendCoverage === "partial" && unpricedEventCount > 0
                    ? `${unpricedEventCount} unpriced event${unpricedEventCount === 1 ? "" : "s"}`
                    : !hasKnownSpend && unpricedEventCount > 0
                      ? `${unpricedEventCount} usage event${unpricedEventCount === 1 ? "" : "s"} without cost`
                      : spendCoverageNoteText(spendCoverage, provider.costCoverageCaveat),
                ]
                  .filter(Boolean)
                  .join(" · ")
              : undefined
          }
        >
          <p
            className="mb-1 text-xs text-gray-500 dark:text-gray-400"
            title={
              spendCoverage === "complete"
                ? undefined
                : costCoverageHelpText(spendCoverage)
            }
          >
            {spendCoverage === "partial"
              ? "Known spend this month"
              : "Tracked spend this month"}
          </p>
          <p className="text-lg font-semibold text-amber-600 dark:text-amber-300">
            {hasKnownSpend ? formatUsd(canonicalSpendUsd) : "Cost not reported"}
          </p>
          {density === "comfortable" && (
            <>
              {provider.snapshotCostFetchedAt && (
                <p className="text-[10px] text-gray-500 dark:text-gray-400">
                  Cost snapshot fetched {new Date(provider.snapshotCostFetchedAt).toLocaleString()}
                </p>
              )}
              {spendCoverage === "partial" && unpricedEventCount > 0 ? (
                <p className="text-[10px] text-amber-600 dark:text-amber-300">
                  {unpricedEventCount} unpriced event{unpricedEventCount === 1 ? "" : "s"}
                </p>
              ) : !hasKnownSpend && unpricedEventCount > 0 ? (
                <p className="text-[10px] text-amber-600 dark:text-amber-300">
                  {unpricedEventCount} usage event{unpricedEventCount === 1 ? "" : "s"} without cost
                </p>
              ) : (
                <p
                  className={`text-[10px] ${
                    provider.costCoverageCaveat
                      ? "text-orange-600 dark:text-orange-300"
                      : "text-gray-500 dark:text-gray-400"
                  }`}
                >
                  {spendCoverageNoteText(spendCoverage, provider.costCoverageCaveat)}
                </p>
              )}
            </>
          )}
        </div>
        <div
          className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800"
          title={
            density === "compact"
              ? spendCoverage === "partial"
                ? "excludes unpriced usage"
                : provider.billingMode
              : undefined
          }
        >
          <p className="mb-1 text-xs text-gray-500 dark:text-gray-400">
            {spendCoverage === "partial"
              ? "Known-cost projection"
              : "Projected end of month"}
          </p>
          <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {hasKnownSpend
              ? formatUsd(provider.projectedEomUsd ?? provider.estimatedMonthlyCostUsd)
              : "Unavailable"}
          </p>
          {density === "comfortable" && (
            <p className="text-[10px] uppercase text-gray-400 dark:text-gray-500">
              {spendCoverage === "partial" ? "excludes unpriced usage" : provider.billingMode}
            </p>
          )}
        </div>
        {hasCredits && (
          <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
            <p className="mb-1 text-xs text-gray-500 dark:text-gray-400">Credits</p>
            <p className="text-lg font-semibold text-purple-600 dark:text-purple-300">
              {latestReading?.credits != null
                ? new Intl.NumberFormat("en-US").format(latestReading.credits)
                : "--"}
            </p>
          </div>
        )}
        <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <p className="mb-1 text-xs text-gray-500 dark:text-gray-400">Latest reported {usageUnitLabel}</p>
          <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {latestReading?.totalRequests != null
              ? new Intl.NumberFormat("en-US").format(latestReading.totalRequests)
              : "--"}
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Budget & alert policy</h2>
            <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">Owner-defined guardrails; these are not provider-reported plan terms.</p>
          </div>
          <Link href="/settings?tab=connections" className="text-xs font-semibold text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300">
            Edit connection
          </Link>
        </div>
        <div className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
          <div>
            <p className="mb-1 text-xs text-gray-500 dark:text-gray-400">Monthly Budget</p>
            <p className="font-medium text-gray-900 dark:text-gray-100">
              {formatUsd(provider.plan?.monthlyBudgetUsd)}
            </p>
          </div>
          <div>
            <p className="mb-1 text-xs text-gray-500 dark:text-gray-400">Request alert</p>
            <p className="font-medium text-gray-900 dark:text-gray-100">
              {provider.plan?.monthlyRequestLimit != null
                ? new Intl.NumberFormat("en-US").format(
                    provider.plan.monthlyRequestLimit
                  )
                : "--"}
            </p>
          </div>
          <div>
            <p className="mb-1 text-xs text-gray-500 dark:text-gray-400">Low balance alert</p>
            <p className="font-medium text-gray-900 dark:text-gray-100">{formatUsd(provider.plan?.lowBalanceUsd)}</p>
          </div>
          <div>
            <p className="mb-1 text-xs text-gray-500 dark:text-gray-400">Low credits alert</p>
            <p className="font-medium text-gray-900 dark:text-gray-100">
              {provider.plan?.lowCredits != null
                ? new Intl.NumberFormat("en-US").format(provider.plan.lowCredits)
                : "--"}
            </p>
          </div>
        </div>
        {provider.plan?.notes && (
          <p className="mt-4 text-xs text-gray-500 dark:text-gray-400">{provider.plan.notes}</p>
        )}
      </div>

      <ComplianceSummaryPanel compliance={provider.compliance ?? null} />

      <details className="rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
        <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-gray-700 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-700/40">
          Spend reconciliation
        </summary>
        <dl className="grid grid-cols-2 gap-4 border-t border-gray-100 px-4 py-4 text-sm dark:border-gray-700 sm:grid-cols-3 lg:grid-cols-5">
          <div>
            <dt className="text-xs text-gray-500 dark:text-gray-400">
              {spendCoverage === "partial" ? "Canonical known MTD" : "Canonical tracked MTD"}
            </dt>
            <dd className="mt-1 font-medium text-gray-900 dark:text-gray-100">
              {hasKnownSpend ? formatUsd(canonicalSpendUsd) : "Cost not reported"}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500 dark:text-gray-400">Metered after max-dedupe</dt>
            <dd className="mt-1 font-medium text-gray-900 dark:text-gray-100">
              {hasKnownSpend ? formatUsd(reconciledMeteredUsd) : "Unknown"}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500 dark:text-gray-400">Observed variable usage</dt>
            <dd className="mt-1 font-medium text-gray-900 dark:text-gray-100">
              {formatUsd(provider.observedVariableUsageUsd ?? 0)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500 dark:text-gray-400">Receipt cash paid</dt>
            <dd className="mt-1 font-medium text-emerald-700 dark:text-emerald-300">
              {formatUsd(provider.receiptCashPaidUsd ?? 0)}
            </dd>
            <dd className="mt-0.5 text-[10px] text-gray-500 dark:text-gray-400">
              {provider.receiptCashEventCount ?? 0} exact receipt{provider.receiptCashEventCount === 1 ? "" : "s"}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500 dark:text-gray-400">Claude API-equivalent</dt>
            <dd className="mt-1 font-medium text-amber-700 dark:text-amber-300">
              {formatUsd(provider.estimatedApiEquivalentUsd ?? 0)}
            </dd>
            <dd className="mt-0.5 text-[10px] text-gray-500 dark:text-gray-400">
              Estimate only · excluded from cash spend
            </dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500 dark:text-gray-400">Fixed after link-dedupe</dt>
            <dd className="mt-1 font-medium text-gray-900 dark:text-gray-100">{formatUsd(reconciledFixedUsd)}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500 dark:text-gray-400">Raw provider report</dt>
            <dd className="mt-1 font-medium text-gray-900 dark:text-gray-100">{formatUsd(provider.snapshotCostUsd)}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500 dark:text-gray-400">Removed linked overlap</dt>
            <dd className="mt-1 font-medium text-gray-900 dark:text-gray-100">
              {(provider.linkedFixedDedupeUsd ?? 0) > 0
                ? `−${formatUsd(provider.linkedFixedDedupeUsd)}`
                : formatUsd(0)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500 dark:text-gray-400">Pushed cost coverage</dt>
            <dd
              className="mt-1 font-medium text-gray-900 dark:text-gray-100"
              title={costCoverageHelpText(provider.pushedCostCoverage ?? "unknown")}
            >
              {pushedCostCoverageLabel(provider.pushedCostCoverage)}
            </dd>
            <dd className="mt-0.5 text-[10px] text-gray-500 dark:text-gray-400">
              {provider.pushedPricedEventCount ?? 0} priced · {provider.pushedUnpricedEventCount ?? 0} unpriced · {provider.pushedUnclassifiedCostEventCount ?? 0} unclassified
            </dd>
          </div>
        </dl>
        <p className="border-t border-gray-100 px-4 py-3 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
          {hasKnownSpend
            ? "Canonical spend equals max(receipt cash, observed variable usage) plus deduplicated fixed charges. Claude API-equivalent estimates and the overlapping raw provider report are not added again."
            : "Usage is present without authoritative cost, so no zero-dollar spend or projection is asserted."}
          {provider.fixedCostConflict ? " Review the active fixed-cost conflict alert." : ""}
        </p>
      </details>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-gray-500 dark:text-gray-400">Showing provider-reported snapshots from the selected window.</p>
        <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200">
          Range
          <select
            aria-label="Snapshot history range"
            value={rangeDays}
            onChange={(event) => {
              setRangeDays(Number(event.target.value));
              setSnapshotPage(1);
            }}
            disabled={refreshing}
            className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
          >
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
            <option value={365}>1 year</option>
          </select>
        </label>
      </div>

      <UsageChart snapshots={snapshots} />

      {/* Snapshots Table */}
      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
        <div className="border-b border-gray-100 px-6 py-4 dark:border-gray-700">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Recent Snapshots</h3>
            <span className="text-xs text-gray-500 dark:text-gray-400">{snapshots.length} records · {rangeDays} days</span>
          </div>
        </div>
        {snapshots.length === 0 ? (
          <div className="px-6 py-8 text-center text-sm text-gray-400 dark:text-gray-500">
            No snapshots recorded yet
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="responsive-table w-full text-sm">
              <caption className="sr-only">Provider snapshot history</caption>
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50 dark:border-gray-700 dark:bg-gray-900/60">
                  <th className="px-6 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                    Date
                  </th>
                  <th className="px-6 py-3 text-right font-medium text-gray-500 dark:text-gray-400">
                    Balance
                  </th>
                  <th className="px-6 py-3 text-right font-medium text-gray-500 dark:text-gray-400">
                    Reported Cost
                  </th>
                  {hasCredits && (
                    <th className="px-6 py-3 text-right font-medium text-gray-500 dark:text-gray-400">
                      Credits
                    </th>
                  )}
                  <th className="px-6 py-3 text-right font-medium text-gray-500 dark:text-gray-400">
                    Reported {usageUnitLabel}
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibleSnapshots.map((s) => (
                  <tr
                    key={s.id}
                    className="border-b border-gray-50 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-700/40"
                  >
                    <td data-label="Date" className="px-6 py-3 text-gray-600 dark:text-gray-300">
                      {new Date(s.fetchedAt).toLocaleString()}
                    </td>
                    <td data-label="Balance" className="px-6 py-3 text-right">
                      <BalanceBadge amount={s.balance} />
                    </td>
                    <td data-label="Reported cost" className="px-6 py-3 text-right text-amber-600 dark:text-amber-300">
                      {s.totalCost != null
                        ? new Intl.NumberFormat("en-US", {
                            style: "currency",
                            currency: "USD",
                          }).format(s.totalCost)
                        : "--"}
                    </td>
                    {hasCredits && (
                      <td data-label="Credits" className="px-6 py-3 text-right text-purple-600 dark:text-purple-300">
                        {s.credits != null
                          ? new Intl.NumberFormat("en-US").format(s.credits)
                          : "--"}
                      </td>
                    )}
                    <td data-label={`Reported ${usageUnitLabel}`} className="px-6 py-3 text-right text-gray-600 dark:text-gray-300">
                      {s.totalRequests != null
                        ? new Intl.NumberFormat("en-US").format(s.totalRequests)
                        : "--"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {totalSnapshotPages > 1 && (
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 px-4 py-3 dark:border-gray-700 sm:px-6">
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Page {currentSnapshotPage} of {totalSnapshotPages}
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setSnapshotPage((page) => Math.max(1, page - 1))}
                    disabled={currentSnapshotPage === 1}
                    className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 disabled:opacity-40 dark:border-gray-600 dark:text-gray-200"
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    onClick={() => setSnapshotPage((page) => Math.min(totalSnapshotPages, page + 1))}
                    disabled={currentSnapshotPage === totalSnapshotPages}
                    className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 disabled:opacity-40 dark:border-gray-600 dark:text-gray-200"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
