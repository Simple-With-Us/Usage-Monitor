"use client";

import Link from "next/link";
import { useState } from "react";
import StatusBadge from "@/components/StatusBadge";
import {
  formatBudgetRunout,
  type ProviderBudgetIntel,
} from "@/lib/format";

interface AttentionItem {
  provider: { id: string; displayName: string; label: string | null };
  alert: { severity: "critical" | "warning" | "info"; message: string; code?: string };
}

/**
 * Distinct chips for the newer scoped alert codes (project budgets, spend
 * anomalies, subscription insights) so they don't read as generic provider
 * alerts. Codes without an entry render no chip — the message already speaks.
 */
const ALERT_CODE_CHIPS: Record<string, string> = {
  project_budget_exceeded: "Project budget",
  project_budget_warning: "Project budget",
  project_spend_anomaly: "Project anomaly",
  unassigned_spend: "Unassigned spend",
  unused_subscription: "Unused subscription",
  possible_duplicate_subscription: "Possible duplicate",
  price_change_detected: "Price change",
  budget_control_paused: "Budget control",
  key_disable_recommended: "Key action",
};

/** Rows rendered before the list collapses behind the "Show all" toggle. */
const ATTENTION_PREVIEW_LIMIT = 8;

function primaryAction(code?: string): { href: string; label: string } {
  if (code?.startsWith("project_")) {
    return { href: "/settings?tab=projects", label: "Edit project budget" };
  }
  if (
    code === "unused_subscription" ||
    code === "possible_duplicate_subscription" ||
    code === "price_change_detected"
  ) {
    return { href: "/settings?tab=services", label: "Review subscriptions" };
  }
  return { href: "/settings?tab=connections", label: "Edit budget" };
}

export default function DashboardAttentionPanel({
  attentionItems,
  budgetIntelByProviderId,
}: {
  attentionItems: AttentionItem[];
  /** S9: optional runout intelligence keyed by provider id (from /api/budget-status). */
  budgetIntelByProviderId?: Record<string, ProviderBudgetIntel>;
}) {
  const [showAll, setShowAll] = useState(false);
  const visibleItems = showAll
    ? attentionItems
    : attentionItems.slice(0, ATTENTION_PREVIEW_LIMIT);

  return (
    <div
      id="attention"
      className="scroll-mt-20 bg-white dark:bg-gray-800 rounded-2xl border border-gray-200 dark:border-gray-700 overflow-hidden"
    >
      <div className="px-4 py-3 sm:px-6 border-b border-gray-100 dark:border-gray-700 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">
          Attention
        </h2>
        <Link
          href="/settings?tab=connections"
          className="text-xs font-medium text-accent"
        >
          Manage budgets
        </Link>
      </div>
      {attentionItems.length === 0 ? (
        <div className="px-4 py-4 sm:px-6 text-sm text-gray-500 dark:text-gray-400">
          All clear — no payment, budget, or limit alerts.
        </div>
      ) : (
        <div className="divide-y divide-gray-100 dark:divide-gray-700">
          {visibleItems.map(({ provider, alert }, index) => {
            const codeChip = alert.code ? ALERT_CODE_CHIPS[alert.code] : undefined;
            const runoutLabel = budgetIntelByProviderId
              ? formatBudgetRunout(budgetIntelByProviderId[provider.id] ?? {})
              : null;
            const action = primaryAction(alert.code);
            const editBudgetHref = `/settings?tab=connections&edit=${encodeURIComponent(provider.id)}`;
            return (
              <div
                key={`${provider.id}-${index}-${alert.message.slice(0, 24)}`}
                className="flex flex-wrap items-start justify-between gap-3 px-4 py-3 sm:px-6 hover:bg-gray-50 dark:hover:bg-gray-900/40"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    {provider.displayName}
                    {provider.label ? ` - ${provider.label}` : ""}
                    {codeChip && (
                      <span className="ml-2 inline-flex rounded bg-accent-soft px-1.5 py-0.5 align-middle text-[10px] font-medium text-gray-800 dark:text-gray-200">
                        {codeChip}
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    {alert.message}
                  </p>
                  {runoutLabel && (
                    <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                      {runoutLabel}
                    </p>
                  )}
                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                    <Link
                      href={`/providers/${provider.id}`}
                      className="text-xs font-semibold text-accent"
                    >
                      Open provider
                    </Link>
                    <Link
                      href={
                        action.href.includes("connections")
                          ? editBudgetHref
                          : action.href
                      }
                      className="text-xs font-semibold text-accent"
                    >
                      {action.label}
                    </Link>
                    <Link
                      href="/settings?tab=notifications"
                      className="text-xs font-medium text-gray-500 dark:text-gray-400"
                    >
                      Alert settings
                    </Link>
                  </div>
                </div>
                <StatusBadge
                  label={alert.severity}
                  status={alert.severity === "critical" ? "danger" : "warning"}
                />
              </div>
            );
          })}
          {attentionItems.length > ATTENTION_PREVIEW_LIMIT && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-3 sm:px-6 text-xs text-gray-500 dark:text-gray-400">
              <button
                type="button"
                onClick={() => setShowAll((expanded) => !expanded)}
                aria-expanded={showAll}
                className="min-h-11 text-xs font-medium text-accent hover:opacity-90"
              >
                {showAll
                  ? "Show fewer alerts"
                  : `Show all ${attentionItems.length} alerts`}
              </button>
              <span>
                Or open a provider or filter the workspace by Alerts only.
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
