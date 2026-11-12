"use client";

import { useState } from "react";
import { costCoverageHelpText } from "@/lib/cost-coverage-help";
import { formatCurrency, formatNumber } from "@/lib/format";

export type ExternalCostCoverage = "complete" | "partial" | "unknown" | "legacy_unknown";

export interface ExternalUsageGroup {
  sourceApp: string;
  environment: string | null;
  provider: string;
  canonicalProvider: string;
  service: string | null;
  projectId: string | null;
  metricType: string;
  unit: string | null;
  projectName?: string | null;
  matchedProvider?: {
    id: string;
    name: string;
    displayName: string;
  } | null;
  eventCount: number;
  pricedEventCount: number;
  unpricedEventCount: number;
  unclassifiedCostEventCount: number;
  costCoverage: ExternalCostCoverage;
  totalCostUsd: number;
  receiptCashPaidUsd?: number;
  estimatedApiEquivalentUsd: number;
  totalRequests: number;
  totalQuantity: number;
  limit: number | null;
  limitWindow: string | null;
  latestAt: string;
}

export interface DailySpendSeriesPoint {
  /** UTC calendar day, YYYY-MM-DD. */
  day: string;
  totalCostUsd: number;
}

export interface ExternalUsageSummary {
  days: number;
  totalCostUsd: number;
  receiptCashPaidUsd?: number;
  estimatedApiEquivalentUsd: number;
  /** Monitor-computed token x LiteLLM estimates (metadata-only stamps). Never
   * cash, never counted as priced — visibility into unpriced coverage gaps. */
  derivedCostEstimateUsd?: number;
  derivedCostEstimateEventCount?: number;
  pricedEventCount: number;
  unpricedEventCount: number;
  unclassifiedCostEventCount: number;
  costCoverage: ExternalCostCoverage;
  totalRequests: number;
  eventCount: number;
  groups: ExternalUsageGroup[];
  /** Per-day cost series over the same requested window — powers the
   * chart-range burn chart. Optional: absent on older cached responses. */
  dailySeries?: DailySpendSeriesPoint[];
}

interface ExternalTelemetryPanelProps {
  usageSummary: ExternalUsageSummary;
}

const usd = (amount: number) => formatCurrency(amount);

function costLabel(
  totalCostUsd: number,
  coverage: ExternalCostCoverage,
  unpricedEventCount: number,
  unclassifiedCostEventCount: number
): string {
  if (coverage === "complete") return usd(totalCostUsd);
  if (coverage === "partial") {
    const unknownEvents = unpricedEventCount + unclassifiedCostEventCount;
    return `${usd(totalCostUsd)} known · ${unknownEvents} unpriced`;
  }
  if (coverage === "legacy_unknown") {
    return totalCostUsd !== 0
      ? `${usd(totalCostUsd)} recorded · historical coverage unknown`
      : "Historical cost unknown";
  }
  return "Cost not reported";
}

function identityToken(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export default function ExternalTelemetryPanel({ usageSummary }: ExternalTelemetryPanelProps) {
  const [showAll, setShowAll] = useState(false);
  const externalCost = usageSummary.totalCostUsd;
  const receiptCashPaid = usageSummary.receiptCashPaidUsd ?? 0;
  const estimatedApiEquivalent = usageSummary.estimatedApiEquivalentUsd;
  const externalRequests = usageSummary.totalRequests;
  const visibleGroups = showAll ? usageSummary.groups : usageSummary.groups.slice(0, 8);

  return (
    <div data-testid="external-telemetry-panel" className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">
            External App Telemetry
          </h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            {usageSummary.days >= 3650
              ? "All time from sibling app reports"
              : `Last ${usageSummary.days} ${usageSummary.days === 1 ? "day" : "days"} from sibling app reports`}
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className="text-[10px] font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
            Tracked cash spend
          </p>
          <p
            className="text-sm font-semibold text-gray-900 dark:text-gray-100"
            title={
              usageSummary.costCoverage === "complete"
                ? undefined
                : costCoverageHelpText(usageSummary.costCoverage)
            }
          >
            {costLabel(
              externalCost,
              usageSummary.costCoverage,
              usageSummary.unpricedEventCount,
              usageSummary.unclassifiedCostEventCount
            )}
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {formatNumber(externalRequests)} requests
          </p>
          {estimatedApiEquivalent > 0 && (
            <p className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-300">
              API-equivalent estimate: {usd(estimatedApiEquivalent)}
              <span className="block text-[10px] font-normal">
                Excluded from cash spend · verify provider billing
              </span>
            </p>
          )}
          {receiptCashPaid > 0 && (
            <p className="mt-1 text-xs font-medium text-emerald-700 dark:text-emerald-300">
              Receipt cash paid: {usd(receiptCashPaid)}
              <span className="block text-[10px] font-normal">
                Reconciled with observed usage by max, not added twice
              </span>
            </p>
          )}
          {(usageSummary.derivedCostEstimateUsd ?? 0) > 0 && (
            <p className="mt-1 text-xs font-medium text-sky-700 dark:text-sky-300">
              Monitor-estimated: {usd(usageSummary.derivedCostEstimateUsd ?? 0)}
              {usageSummary.derivedCostEstimateEventCount
                ? ` · ${formatNumber(usageSummary.derivedCostEstimateEventCount)} events`
                : ""}
              <span className="block text-[10px] font-normal">
                Token × LiteLLM pricing · not cash, not counted as priced
              </span>
            </p>
          )}
        </div>
      </div>
      {usageSummary.groups.length === 0 ? (
        <div className="px-6 py-5 text-sm text-gray-500 dark:text-gray-400">
          No app telemetry received yet.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse responsive-table">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900">
                <th className="px-6 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  Source
                </th>
                <th className="px-6 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  Provider
                </th>
                <th className="px-6 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider text-right">
                  Usage
                </th>
                <th className="px-6 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  Quota
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {visibleGroups.map((group) => {
                const normalizedUnit = group.unit?.trim().toLowerCase();
                const requestBased =
                  normalizedUnit === "request" ||
                  normalizedUnit === "requests" ||
                  (group.totalQuantity === 0 && group.totalRequests !== 0);
                const displayedUsage =
                  requestBased
                    ? group.totalRequests
                    : group.totalQuantity;
                const displayedUnit =
                  group.unit || (requestBased ? "requests" : group.metricType);
                const hasEstimatedApiEquivalent =
                  group.estimatedApiEquivalentUsd > 0;
                const tokenUsageWithEstimate =
                  hasEstimatedApiEquivalent &&
                  group.metricType === "usage" &&
                  normalizedUnit === "token";
                const groupReceiptCash = group.receiptCashPaidUsd ?? 0;
                const hasReceiptCash = groupReceiptCash > 0;
                const usagePercent =
                  group.limit != null && group.limit > 0
                    ? Math.min((displayedUsage / group.limit) * 100, 999)
                    : null;
                return (
                  <tr
                    key={`${group.sourceApp}-${group.environment ?? ""}-${group.provider}-${group.service ?? ""}-${group.projectId ?? ""}-${group.metricType}-${group.unit ?? ""}`}
                    className="hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                  >
                    <td className="px-6 py-4" data-label="Source">
                      <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                        {group.sourceApp}
                        {group.environment ? ` / ${group.environment}` : ""}
                      </p>
                      {group.projectName && (
                        <span className="inline-flex mt-1 px-2 py-0.5 text-[10px] font-medium rounded-full bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 border border-blue-100 dark:border-blue-800">
                          {group.projectName}
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-4" data-label="Provider">
                      <p className="text-sm text-gray-900 dark:text-gray-100">
                        {group.provider}
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                        {group.service || "API"} · {displayedUnit}
                      </p>
                      {group.matchedProvider &&
                        identityToken(group.matchedProvider.name) !==
                          identityToken(group.provider) && (
                        <p className="text-[10px] text-blue-600 dark:text-blue-400 mt-1">
                          Matched to {group.matchedProvider.displayName}
                        </p>
                      )}
                    </td>
                    <td className="px-6 py-4 text-right" data-label="Usage">
                      <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                        {hasReceiptCash
                          ? usd(groupReceiptCash)
                          : hasEstimatedApiEquivalent && !tokenUsageWithEstimate
                          ? usd(group.estimatedApiEquivalentUsd)
                          : formatNumber(displayedUsage)}
                      </p>
                      <p
                        className="text-xs text-gray-500 dark:text-gray-400"
                        title={
                          !hasReceiptCash && !hasEstimatedApiEquivalent && group.costCoverage !== "complete"
                            ? costCoverageHelpText(group.costCoverage)
                            : undefined
                        }
                      >
                        {hasReceiptCash
                          ? "Receipt cash paid · max-reconciled with observed usage"
                          : tokenUsageWithEstimate
                          ? `API-equivalent estimate: ${usd(group.estimatedApiEquivalentUsd)} · excluded from cash spend`
                          : hasEstimatedApiEquivalent
                          ? "API-equivalent estimate · excluded from cash spend"
                          : costLabel(
                              group.totalCostUsd,
                              group.costCoverage,
                              group.unpricedEventCount,
                              group.unclassifiedCostEventCount
                            )}
                      </p>
                    </td>
                    <td className="px-6 py-4" data-label="Quota">
                      {usagePercent != null ? (
                        <div className="w-32">
                          <div
                            role="progressbar"
                            aria-label={`${group.provider} quota usage`}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={Math.min(usagePercent, 100)}
                            className="h-2 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden"
                          >
                            <div
                              className={`h-full ${
                                usagePercent >= 90
                                  ? "bg-red-500 dark:bg-red-600"
                                  : usagePercent >= 70
                                    ? "bg-amber-500 dark:bg-amber-600"
                                    : "bg-emerald-500 dark:bg-emerald-600"
                              }`}
                              style={{ width: `${Math.min(usagePercent, 100)}%` }}
                            />
                          </div>
                          <p className="text-[10px] text-gray-500 dark:text-gray-400 mt-1">
                            {usagePercent.toFixed(1)}% of{" "}
                            {formatNumber(group.limit ?? 0)}
                            {group.limitWindow ? `/${group.limitWindow}` : ""}
                          </p>
                        </div>
                      ) : (
                        <span className="text-xs text-gray-500 dark:text-gray-400">-</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {usageSummary.groups.length > 8 && (
            <div className="px-6 py-3 border-t border-gray-100 dark:border-gray-700">
              <button
                type="button"
                onClick={() => setShowAll((expanded) => !expanded)}
                className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300"
              >
                {showAll ? "Show fewer groups" : `Show all ${usageSummary.groups.length} groups`}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
