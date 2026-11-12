import React from "react";
import { formatCurrency } from "@/lib/format";
import {
  spendAmountClass,
  type OverallAccountStatus,
} from "@/lib/ui-status";

interface DashboardSummaryCardsProps {
  totalProviderFunds: number;
  totalProjectedMonthlyCost: number;
  totalCost: number;
  incompleteCostProviderCount: number;
  ambiguousCostFamilyCount: number;
  attentionItemsCount: number;
  criticalCount: number;
  /** Period name shown in the spend card header, e.g. "August 2026" or "Past 30 Days". */
  spendPeriodLabel: string;
  onAlertsNavigate?: () => void;
  /** When provided, spend amount uses status-based color (not always amber). */
  accountStatus?: OverallAccountStatus;
}

export default function DashboardSummaryCards({
  totalProviderFunds,
  totalProjectedMonthlyCost,
  totalCost,
  incompleteCostProviderCount,
  ambiguousCostFamilyCount,
  attentionItemsCount,
  criticalCount,
  spendPeriodLabel,
  onAlertsNavigate,
  accountStatus = "ok",
}: DashboardSummaryCardsProps) {
  // Money-first KPI order (Wave D / D2): spend → projection → funds → alerts.
  // Zero open alerts use neutral gray so "0" is not amber-alarm coloring.
  const alertsTone =
    criticalCount > 0
      ? "text-red-600 dark:text-red-400"
      : attentionItemsCount > 0
        ? "text-amber-600 dark:text-amber-400"
        : "text-gray-900 dark:text-gray-100";

  const incomplete = incompleteCostProviderCount > 0 || ambiguousCostFamilyCount > 0;
  const spendTone = spendAmountClass(accountStatus, incomplete);

  return (
    <div
      className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-gray-200 bg-gray-100 sm:grid-cols-4 dark:border-gray-700 dark:bg-gray-700"
    >
      <div className="bg-white p-4 dark:bg-gray-800">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          {incomplete
            ? `Known ${spendPeriodLabel} Spend`
            : `${spendPeriodLabel} Spend`}
        </p>
        <p className={`mt-1 text-lg font-semibold tabular-nums ${spendTone}`}>
          {formatCurrency(totalCost)}
        </p>
        {incompleteCostProviderCount > 0 && (
          <p className="mt-0.5 text-xs text-amber-600 dark:text-amber-300">
            {incompleteCostProviderCount} provider cost{incompleteCostProviderCount === 1 ? "" : "s"} incomplete
          </p>
        )}
        {ambiguousCostFamilyCount > 0 && (
          <p className="mt-0.5 text-xs text-amber-600 dark:text-amber-300">
            {ambiguousCostFamilyCount} multi-key famil{ambiguousCostFamilyCount === 1 ? "y" : "ies"} excluded
          </p>
        )}
      </div>
      <div className="bg-white p-4 dark:bg-gray-800">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          {incomplete
            ? "Known-Cost Projection"
            : "Projected Monthly Spend"}
        </p>
        <p className="mt-1 text-lg font-semibold tabular-nums text-gray-900 dark:text-gray-100">
          {formatCurrency(totalProjectedMonthlyCost)}
        </p>
        {incomplete && (
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            Excludes unreported or ambiguous provider costs
          </p>
        )}
      </div>
      <div className="bg-white p-4 dark:bg-gray-800">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          Known Provider Funds
        </p>
        <p className="mt-1 text-lg font-semibold tabular-nums text-gray-900 dark:text-gray-100">
          {formatCurrency(totalProviderFunds)}
        </p>
        <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
          Excludes ambiguous, brokerage, and merchant assets
        </p>
      </div>
      <div className="bg-white p-4 dark:bg-gray-800">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          Open Alerts
        </p>
        <a
          href="#attention"
          onClick={onAlertsNavigate}
          className="block hover:opacity-80 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:focus-visible:ring-blue-400"
        >
          <p className={`mt-1 text-lg font-semibold tabular-nums ${alertsTone}`}>
            {attentionItemsCount}
          </p>
          {criticalCount > 0 && (
            <p className="mt-0.5 text-xs text-red-500 dark:text-red-400">{criticalCount} critical &rarr;</p>
          )}
          {criticalCount === 0 && attentionItemsCount > 0 && (
            <p className="mt-0.5 text-xs text-amber-500 dark:text-amber-400">View details &rarr;</p>
          )}
          {attentionItemsCount === 0 && (
            <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">All clear</p>
          )}
        </a>
      </div>
    </div>
  );
}
