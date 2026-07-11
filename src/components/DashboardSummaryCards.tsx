import React from "react";

interface DashboardSummaryCardsProps {
  totalBalance: number;
  totalProjectedMonthlyCost: number;
  totalCost: number;
  attentionItemsCount: number;
  criticalCount: number;
  hasAnyCredits: boolean;
  totalCredits: number;
}

export default function DashboardSummaryCards({
  totalBalance,
  totalProjectedMonthlyCost,
  totalCost,
  attentionItemsCount,
  criticalCount,
  hasAnyCredits,
  totalCredits,
}: DashboardSummaryCardsProps) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <p className="text-sm text-gray-500 mb-1">Total Balance</p>
        <p className="text-3xl font-bold text-gray-900">
          {new Intl.NumberFormat("en-US", {
            style: "currency",
            currency: "USD",
          }).format(totalBalance)}
        </p>
      </div>
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <p className="text-sm text-gray-500 mb-1">Projected Monthly Spend</p>
        <p className="text-3xl font-bold text-gray-900">
          {new Intl.NumberFormat("en-US", {
            style: "currency",
            currency: "USD",
          }).format(totalProjectedMonthlyCost)}
        </p>
      </div>
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <p className="text-sm text-gray-500 mb-1">Tracked Spend This Month</p>
        <p className="text-3xl font-bold text-amber-600">
          {new Intl.NumberFormat("en-US", {
            style: "currency",
            currency: "USD",
          }).format(totalCost)}
        </p>
      </div>
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <p className="text-sm text-gray-500 mb-1">Open Alerts</p>
        <p
          className={`text-3xl font-bold ${
            criticalCount > 0 ? "text-red-600" : "text-amber-600"
          }`}
        >
          {attentionItemsCount}
        </p>
        {criticalCount > 0 && (
          <p className="text-xs text-red-500 mt-1">{criticalCount} critical</p>
        )}
      </div>
      {hasAnyCredits && (
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <p className="text-sm text-gray-500 mb-1">Total Credits</p>
          <p className="text-3xl font-bold text-purple-600">
            {new Intl.NumberFormat("en-US").format(totalCredits)}
          </p>
        </div>
      )}
    </div>
  );
}
