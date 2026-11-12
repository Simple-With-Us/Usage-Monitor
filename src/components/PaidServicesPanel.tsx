"use client";

import { useState } from "react";
import Link from "next/link";
import ProviderIntegrationInfo from "@/components/ProviderIntegrationInfo";
import {
  buildBillingInventory,
  isBillingInventoryItemActive,
  type BillingCoverageStatus,
  type BillingInventoryItem,
  type BillingInventoryProvider,
  type BillingInventorySubscription,
} from "@/lib/billing-inventory";
import {
  formatCompactNumber,
  formatCurrency,
  formatDate,
  formatNumber,
  NOT_REPORTED,
} from "@/lib/format";
import {
  BILLING_PROVENANCE_DESCRIPTIONS,
  BILLING_PROVENANCE_LABELS,
  BILLING_PROVENANCE_STYLES,
  formatStatusLabel,
  statusBadgeStyle,
} from "@/lib/status-vocab";

interface PaidServicesPanelProps {
  providers: BillingInventoryProvider[];
  subscriptions: BillingInventorySubscription[];
  variant?: "dashboard" | "settings" | "provider";
  maxItems?: number;
  showCoverage?: boolean;
}

const COVERAGE_LABELS: Record<BillingCoverageStatus, string> = {
  automatic: "Syncing",
  stale: "Old snapshot",
  tracked: "Tracked",
  available: "Waiting for first fetch",
  manual: "Manually only",
  "not-applicable": "Not applicable",
};

const COVERAGE_STYLES: Record<BillingCoverageStatus, string> = {
  automatic: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  stale: "bg-amber-50 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
  tracked: "bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300",
  available: "bg-amber-50 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
  manual: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  "not-applicable": "bg-gray-50 text-gray-600 dark:bg-gray-900 dark:text-gray-400",
};

function formatMoney(amount: number, currency = "USD"): string {
  return formatCurrency(amount, { currency });
}

function formatServiceDate(value: string | null): string {
  return formatDate(value, { nullState: NOT_REPORTED, invalidState: "Invalid date" });
}

function formatCompact(value: number): string {
  return Math.abs(value) >= 10_000
    ? formatCompactNumber(value)
    : formatNumber(value, { maximumFractionDigits: 1 });
}

function costDescription(item: BillingInventoryItem): { primary: string; secondary: string } {
  if (item.amount == null) {
    return {
      primary: NOT_REPORTED,
      secondary:
        item.costKind === "current-period" ? "current-period spend" : "price unavailable",
    };
  }
  if (item.costKind === "current-period") {
    return {
      primary: formatMoney(item.amount, item.currency),
      secondary:
        item.rollupRole === "component"
          ? "service breakdown · excluded from summaries"
          : "current period",
    };
  }
  return {
    primary: formatMoney(item.amount, item.currency),
    secondary: item.cadence ? `/ ${item.cadence}` : "recurring price",
  };
}

function quotaDescription(item: BillingInventoryItem): { primary: string; secondary: string } {
  if (item.usageQuantity != null || item.remainingQuantity != null) {
    const unit = item.usageUnit || "units";
    const secondaryParts: string[] = [];
    if (item.usageQuantity != null) {
      secondaryParts.push(`${formatCompact(item.usageQuantity)} ${unit} used`);
    }
    if (item.requestLimit != null) {
      secondaryParts.push(
        `${formatCompact(item.requestLimit)}${
          item.requestLimitWindow ? ` / ${item.requestLimitWindow}` : ""
        } limit`
      );
    }
    return {
      primary:
        item.remainingQuantity == null
          ? `${formatCompact(item.usageQuantity ?? 0)} used`
          : `${formatCompact(item.remainingQuantity)} remaining`,
      secondary: secondaryParts.length > 0 ? secondaryParts.join(" · ") : unit,
    };
  }
  if (item.requestLimit != null) {
    const unit = item.usageUnit || "requests";
    return {
      primary:
        item.requestUsage == null
          ? `${formatCompact(item.requestLimit)} limit`
          : `${formatCompact(item.requestUsage)} / ${formatCompact(item.requestLimit)}`,
      secondary: item.requestLimitWindow
        ? `${unit} / ${item.requestLimitWindow}`
        : unit,
    };
  }
  if (item.spendLimitUsd != null) {
    return {
      primary:
        item.spendMonthToDateUsd == null
          ? `${formatMoney(item.spendLimitUsd)} limit`
          : `${formatMoney(item.spendMonthToDateUsd)} / ${formatMoney(item.spendLimitUsd)}`,
      secondary: item.spendLimitWindow
        ? `spend / ${item.spendLimitWindow}`
        : "spend limit",
    };
  }
  if (item.creditsRemaining != null) {
    return {
      primary: `${formatCompact(item.creditsRemaining)} remaining`,
      secondary: "credits",
    };
  }
  return { primary: NOT_REPORTED, secondary: "usage / quota" };
}

function relativeSync(value: string | null): string {
  if (!value) return "Local value";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "Unknown sync time";
  return `Synced ${new Date(time).toLocaleString()}`;
}

function SummaryStat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="min-w-0 px-4 py-3 sm:px-5">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{label}</p>
      <p className="mt-1 truncate text-lg font-semibold text-gray-900 dark:text-gray-100">{value}</p>
      <p className="mt-0.5 truncate text-[11px] text-gray-500 dark:text-gray-400">{detail}</p>
    </div>
  );
}

export default function PaidServicesPanel({
  providers,
  subscriptions,
  variant = "dashboard",
  maxItems,
  showCoverage = false,
}: PaidServicesPanelProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const inventory = buildBillingInventory(providers, subscriptions);
  const rawItems = maxItems ? inventory.items.slice(0, maxItems) : inventory.items;
  const visibleItems = rawItems.filter((item) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      item.serviceName.toLowerCase().includes(q) ||
      item.providerDisplayName.toLowerCase().includes(q) ||
      (item.providerLabel && item.providerLabel.toLowerCase().includes(q)) ||
      (item.projectName && item.projectName.toLowerCase().includes(q)) ||
      (item.tierName && item.tierName.toLowerCase().includes(q)) ||
      (item.source && item.source.toLowerCase().includes(q))
    );
  });
  const hiddenItemCount = inventory.items.length - rawItems.length;
  const nonUsdRecurringCount = inventory.items.filter(
    (item) =>
      item.costKind === "recurring" &&
      item.currency !== "USD" &&
      item.rollupRole === "canonical" &&
      isBillingInventoryItemActive(item)
  ).length;
  const titleId = `paid-services-${variant}-heading`;
  const coverageCounts = inventory.coverage.reduce(
    (counts, entry) => {
      counts[entry.status] += 1;
      return counts;
    },
    {
      automatic: 0,
      stale: 0,
      tracked: 0,
      available: 0,
      manual: 0,
      "not-applicable": 0,
    } satisfies Record<BillingCoverageStatus, number>
  );

  return (
    <section className="overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800" aria-labelledby={titleId}>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-gray-100 px-4 py-4 dark:border-gray-700 sm:px-6">
        <div>
          <h2 id={titleId} className="text-base font-semibold text-gray-900 dark:text-gray-100">
            Paid Services, Plans & Quotas
          </h2>
          <p className="mt-1 max-w-3xl text-xs text-gray-500 dark:text-gray-400">
            Provider-reported billing, quotas, and locally tracked subscriptions in one deduplicated inventory.
          </p>
          <details className="mt-1 max-w-3xl text-xs text-gray-500 dark:text-gray-400">
            <summary className="cursor-pointer font-medium text-gray-600 hover:text-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-300 dark:hover:text-gray-100">
              What the source labels mean
            </summary>
            <ul className="mt-2 space-y-1.5">
              {(
                Object.keys(BILLING_PROVENANCE_LABELS) as Array<
                  keyof typeof BILLING_PROVENANCE_LABELS
                >
              ).map((key) => (
                <li key={key} className="flex flex-wrap items-baseline gap-1.5">
                  <span
                    className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${BILLING_PROVENANCE_STYLES[key]}`}
                  >
                    {BILLING_PROVENANCE_LABELS[key]}
                  </span>
                  <span>{BILLING_PROVENANCE_DESCRIPTIONS[key]}</span>
                </li>
              ))}
            </ul>
          </details>
        </div>
        <div className="flex items-center gap-3">
          {variant !== "dashboard" && inventory.items.length > 5 && (
            <div className="relative">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Filter services..."
                className="w-48 sm:w-64 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 dark:placeholder-gray-500"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  className="absolute right-2.5 top-2 text-[10px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
                >
                  Clear
                </button>
              )}
            </div>
          )}
          {variant === "dashboard" && (
            <Link href="/settings?tab=services" className="text-xs font-semibold text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300">
              Manage services
            </Link>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 divide-x divide-y divide-gray-100 border-b border-gray-100 dark:divide-gray-700 dark:border-gray-700 sm:grid-cols-4 sm:divide-y-0">
        <SummaryStat
          label="Active"
          value={String(inventory.summary.activeServices)}
          detail="service records"
        />
        <SummaryStat
          label="Auto-detected"
          value={String(inventory.summary.automaticRecords)}
          detail="provider-confirmed"
        />
        <SummaryStat
          label="Recurring"
          value={formatMoney(inventory.summary.monthlyRecurringUsd)}
          detail={
            nonUsdRecurringCount > 0
              ? `USD only · ${nonUsdRecurringCount} non-USD excluded`
              : "USD monthly equivalent"
          }
        />
        <SummaryStat
          label="Next renewal"
          value={formatServiceDate(inventory.summary.nextRenewalAt)}
          detail={inventory.summary.nextRenewalAt ? "active services" : "none reported"}
        />
      </div>

      {visibleItems.length === 0 ? (
        <div className="px-4 py-10 text-center sm:px-6">
          <p className="text-sm font-medium text-gray-700 dark:text-gray-200">No paid service records yet.</p>
          <p className="mx-auto mt-1 max-w-xl text-xs leading-5 text-gray-500 dark:text-gray-400">
            Supported provider APIs will appear after a successful sync. Track dashboard-only plans manually so renewal dates and recurring cost are still visible.
          </p>
          {variant !== "provider" && (
            <Link
              href="/settings?tab=services"
              className="mt-4 inline-flex rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white hover:bg-blue-700"
            >
              Track a paid service
            </Link>
          )}
        </div>
      ) : (
        <div className="overflow-x-clip">
          <table className="responsive-table w-full text-sm">
            <caption className="sr-only">Paid services, subscription tiers, usage, quota, renewal, and billing sources</caption>
            <thead>
              <tr className={`border-b border-gray-100 bg-gray-50 dark:border-gray-700 dark:bg-gray-900/60 [&>th]:sticky [&>th]:z-20 [&>th]:bg-gray-50 dark:[&>th]:bg-gray-900 ${variant === "settings" ? "[&>th]:top-28" : "[&>th]:top-16"}`}>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 sm:px-6">Service</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Plan / tier</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Cost</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Usage / quota</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Renewal / period</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 sm:px-6">Source</th>
              </tr>
            </thead>
            <tbody>
              {visibleItems.map((item) => {
                const cost = costDescription(item);
                const quota = quotaDescription(item);
                return (
                  <tr key={item.id} className="border-b border-gray-50 align-top last:border-b-0 hover:bg-gray-50/70 dark:border-gray-700 dark:hover:bg-gray-700/40">
                    <td data-label="Service" className="px-4 py-4 sm:px-6">
                      <Link href={`/providers/${item.providerId}`} className="font-semibold text-gray-900 hover:text-blue-700 dark:text-gray-100 dark:hover:text-blue-300">
                        {item.serviceName}
                      </Link>
                      <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                        {item.providerDisplayName}{item.providerLabel ? ` · ${item.providerLabel}` : ""}
                      </p>
                      {item.rollupRole !== "canonical" && (
                        <span className="mt-1 inline-flex rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                          {item.rollupRole === "component" ? "Breakdown" : "Account metadata"}
                        </span>
                      )}
                      {item.projectName && (
                        <span className="mt-1 inline-flex rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:bg-blue-950/60 dark:text-blue-300">
                          {item.projectName}
                        </span>
                      )}
                      {item.capacityChanges.length > 0 && (
                        <details className="relative z-10 mt-2 text-xs">
                          <summary className="cursor-pointer font-medium text-violet-700 dark:text-violet-300">
                            {item.capacityChanges.length} paid-tier limit{item.capacityChanges.length === 1 ? "" : "s"}
                          </summary>
                          <dl className="mt-2 space-y-1 rounded-lg border border-violet-100 bg-violet-50 p-2 text-[11px] dark:border-violet-900 dark:bg-violet-950/40">
                            {item.capacityChanges.slice(0, 6).map((change) => (
                              <div key={change.key}>
                                <dt className="font-medium text-violet-900 dark:text-violet-200">{change.label}</dt>
                                <dd className="text-violet-700 dark:text-violet-300">
                                  {change.freeTierValue ?? "unset"} → {change.paidTierValue ?? "unset"}
                                </dd>
                              </div>
                            ))}
                          </dl>
                        </details>
                      )}
                    </td>
                    <td data-label="Plan / tier" className="px-4 py-4">
                      <p className="font-medium text-gray-800 dark:text-gray-200">{item.tierName || "Tier not reported"}</p>
                      <span className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${statusBadgeStyle(item.status)}`}>
                        {formatStatusLabel(item.status)}
                      </span>
                    </td>
                    <td data-label="Cost" className="px-4 py-4">
                      <p className="font-semibold text-gray-900 dark:text-gray-100">{cost.primary}</p>
                      <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{cost.secondary}</p>
                      {item.monthlyEquivalentUsd != null && item.cadence && !["month", "monthly"].includes(item.cadence.toLowerCase()) && (
                        <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">≈ {formatMoney(item.monthlyEquivalentUsd)} / month</p>
                      )}
                    </td>
                    <td data-label="Usage / quota" className="px-4 py-4">
                      <p className="font-medium text-gray-800 dark:text-gray-200">{quota.primary}</p>
                      <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{quota.secondary}</p>
                    </td>
                    <td data-label="Renewal / period" className="px-4 py-4">
                      <p className="font-medium text-gray-800 dark:text-gray-200">
                        {item.nextRenewalAt
                          ? formatServiceDate(item.nextRenewalAt)
                          : item.currentPeriodEnd
                            ? formatServiceDate(item.currentPeriodEnd)
                            : NOT_REPORTED}
                      </p>
                      <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                        {item.nextRenewalAt
                          ? item.dateKind === "period_end"
                            ? "billing period ends"
                            : item.dateKind === "quota_reset"
                              ? "quota resets"
                              : item.dateKind === "contract_end"
                                ? "contract ends"
                                : item.dateKind === "report_through"
                                  ? "reported through"
                                : "next renewal"
                          : item.currentPeriodEnd
                            ? item.dateKind === "quota_reset"
                              ? "quota resets"
                              : item.dateKind === "contract_end"
                                ? "contract ends"
                                : item.dateKind === "report_through"
                                  ? "reported through"
                                  : "billing period ends"
                            : "provider unavailable"}
                      </p>
                    </td>
                    <td data-label="Source" className="px-4 py-4 sm:px-6">
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${BILLING_PROVENANCE_STYLES[item.provenance]}`}>
                        {BILLING_PROVENANCE_LABELS[item.provenance]}
                      </span>
                      <p className="mt-1 break-words text-[11px] text-gray-500 dark:text-gray-400">{item.source || "local"}</p>
                      <p className={`mt-1 text-[11px] ${item.stale ? "font-medium text-amber-700 dark:text-amber-300" : "text-gray-500 dark:text-gray-400"}`}>
                        {item.stale ? "Sync is stale" : relativeSync(item.syncedAt)}
                      </p>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {hiddenItemCount > 0 && (
        <div className="border-t border-gray-100 px-4 py-3 text-center dark:border-gray-700 sm:px-6">
          <Link href="/settings?tab=services" className="text-xs font-semibold text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300">
            View {hiddenItemCount} more service{hiddenItemCount === 1 ? "" : "s"}
          </Link>
        </div>
      )}

      {showCoverage && (
        <details className="border-t border-gray-100 dark:border-gray-700">
          <summary className="cursor-pointer px-4 py-4 text-sm font-semibold text-gray-800 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-700/40 sm:px-6">
            Provider billing coverage
            <span className="ml-2 font-normal text-gray-500 dark:text-gray-400">
              {coverageCounts.automatic} syncing · {coverageCounts.stale} old snapshots · {coverageCounts.tracked} tracked · {coverageCounts.available} waiting for first fetch · {coverageCounts.manual} manually only · {coverageCounts["not-applicable"]} not applicable
            </span>
          </summary>
          <div className="border-t border-gray-100 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-900/50 sm:p-4">
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {inventory.coverage.map((entry) => (
                <article key={entry.providerId} className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">{entry.providerDisplayName}</p>
                      <p className="text-[11px] text-gray-500 dark:text-gray-400">{entry.category}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${COVERAGE_STYLES[entry.status]}`}>
                        {COVERAGE_LABELS[entry.status]}
                      </span>
                      <ProviderIntegrationInfo
                        providerName={entry.providerName}
                        displayName={entry.providerDisplayName}
                        variant="button"
                      />
                    </div>
                  </div>
                  <p className="mt-2 line-clamp-3 text-xs leading-5 text-gray-600 dark:text-gray-300">{entry.summary}</p>
                </article>
              ))}
            </div>
          </div>
        </details>
      )}
    </section>
  );
}
