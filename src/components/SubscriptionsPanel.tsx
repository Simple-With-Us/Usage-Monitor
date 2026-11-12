"use client";

import { useState } from "react";
import ListLoadErrorPanel from "@/components/ListLoadErrorPanel";
import { formatCurrency } from "@/lib/format";
import { STATUS_SORT_ORDER, statusBadgeStyle } from "@/lib/status-vocab";

export interface SubscriptionRow {
  id: string;
  name: string;
  description: string | null;
  costUsd: number;
  currency: string;
  interval: string;
  intervalCount: number;
  monthlyEquivalentUsd: number;
  anchorDay: number | null;
  startDate: string;
  currentPeriodStart: string;
  nextRenewalAt: string;
  autoRenew: boolean;
  status: string;
  effectiveStatus?: string;
  notes: string | null;
  externalBillingSource: string | null;
  externalBillingId: string | null;
  externalBillingManaged?: boolean | null;
  // Effective knobEnv (this subscription's own override if set, else the
  // provider's free-tier ProviderPlan.knobEnv) and the provider's free-tier
  // map on its own (always present when the provider has one, regardless of
  // this subscription's override). PaidServicesPanel renders the diff so the
  // operational capacity gained by a paid tier is visible beside its cost.
  knobEnv: Record<string, string> | null;
  freeTierKnobEnv: Record<string, string> | null;
  provider: { id: string; name: string; displayName: string };
  project: { id: string; name: string } | null;
}

interface SubscriptionsPanelProps {
  subscriptions: SubscriptionRow[];
  onAdd: () => void;
  onEdit: (subscription: SubscriptionRow) => void;
  onDelete: (id: string) => void;
  deleteConfirm: string | null;
  setDeleteConfirm: (id: string | null) => void;
  actionLoading: string | null;
  /** Message from a failed subscription load; suppresses the empty-state CTA. */
  loadError?: string | null;
  onRetryLoad?: () => void;
}

function displayStatus(subscription: SubscriptionRow): string {
  return subscription.effectiveStatus ?? subscription.status;
}

function formatUsd(amount: number, currency: string): string {
  return formatCurrency(amount, { currency });
}

function formatCadence(intervalCount: number, interval: string): string {
  return intervalCount === 1 ? interval : `every ${intervalCount} ${interval}`;
}

export default function SubscriptionsPanel({
  subscriptions,
  onAdd,
  onEdit,
  onDelete,
  deleteConfirm,
  setDeleteConfirm,
  actionLoading,
  loadError,
  onRetryLoad,
}: SubscriptionsPanelProps) {
  const [searchQuery, setSearchQuery] = useState("");

  if (subscriptions.length === 0) {
    if (loadError) {
      return (
        <ListLoadErrorPanel
          message="Subscriptions couldn't be loaded."
          detail={loadError}
          onRetry={onRetryLoad}
        />
      );
    }
    return (
      <div className="flex flex-col items-center justify-center gap-4 rounded-xl border border-gray-200 bg-white py-16 text-center dark:border-gray-700 dark:bg-gray-800">
        <p className="text-gray-500 dark:text-gray-400">No subscriptions tracked yet.</p>
        <button
          type="button"
          onClick={onAdd}
          className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700"
        >
          Add your first subscription
        </button>
      </div>
    );
  }

  const filteredSubscriptions = subscriptions.filter((sub) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      sub.name.toLowerCase().includes(q) ||
      (sub.description && sub.description.toLowerCase().includes(q)) ||
      sub.provider.displayName.toLowerCase().includes(q) ||
      (sub.project && sub.project.name.toLowerCase().includes(q)) ||
      (sub.externalBillingSource && sub.externalBillingSource.toLowerCase().includes(q))
    );
  });

  const orderedSubscriptions = [...filteredSubscriptions].sort((left, right) => {
    const statusDifference =
      (STATUS_SORT_ORDER[displayStatus(left)] ?? 99) -
      (STATUS_SORT_ORDER[displayStatus(right)] ?? 99);
    return statusDifference || left.nextRenewalAt.localeCompare(right.nextRenewalAt) || left.name.localeCompare(right.name);
  });

  return (
    <div className="space-y-3">
      <div className="relative">
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Filter subscriptions by name, provider, or project..."
          className="w-full rounded-lg border border-gray-200 bg-white px-4 py-2 text-base sm:text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 dark:placeholder-gray-500"
        />
        {searchQuery && (
          <button
            type="button"
            onClick={() => setSearchQuery("")}
            className="absolute right-3 top-2.5 text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
          >
            Clear
          </button>
        )}
      </div>

      <div className="overflow-x-clip rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
      <table className="responsive-table w-full text-sm">
        <caption className="sr-only">Tracked subscriptions</caption>
        <thead>
          <tr className="border-b border-gray-100 bg-gray-50 dark:border-gray-700 dark:bg-gray-900/60 [&>th]:sticky [&>th]:top-28 [&>th]:z-20 [&>th]:bg-gray-50 dark:[&>th]:bg-gray-900">
            <th className="px-6 py-3 text-left font-medium text-gray-500 dark:text-gray-400">Name</th>
            <th className="hidden px-6 py-3 text-left font-medium text-gray-500 dark:text-gray-400 sm:table-cell">Provider</th>
            <th className="hidden px-6 py-3 text-left font-medium text-gray-500 dark:text-gray-400 md:table-cell">Project</th>
            <th className="px-6 py-3 text-left font-medium text-gray-500 dark:text-gray-400">Cost</th>
            <th className="hidden px-6 py-3 text-left font-medium text-gray-500 dark:text-gray-400 lg:table-cell">~ / mo</th>
            <th className="hidden px-6 py-3 text-left font-medium text-gray-500 dark:text-gray-400 lg:table-cell">Renewal / term</th>
            <th className="px-6 py-3 text-left font-medium text-gray-500 dark:text-gray-400">Status</th>
            <th className="px-6 py-3 text-right font-medium text-gray-500 dark:text-gray-400">Actions</th>
          </tr>
        </thead>
        <tbody>
          {orderedSubscriptions.map((sub) => {
            const effectiveStatus = displayStatus(sub);
            return (
              <tr key={sub.id} className="border-b border-gray-50 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-700/40">
              <td data-label="Name" className="px-6 py-4">
                <p className="font-medium text-gray-900 dark:text-gray-100">{sub.name}</p>
                {sub.description && <p className="mt-0.5 max-w-xs text-xs text-gray-500 dark:text-gray-400">{sub.description}</p>}
                {!sub.autoRenew && <p className="text-[10px] text-gray-500 dark:text-gray-400">does not auto-renew</p>}
                {sub.externalBillingSource && sub.externalBillingId && (
                  <p className="mt-1 text-[10px] font-medium text-blue-700 dark:text-blue-300">
                    Linked to {sub.externalBillingSource}
                  </p>
                )}
              </td>
              <td data-label="Provider" className="hidden px-6 py-4 text-gray-500 dark:text-gray-400 sm:table-cell">{sub.provider.displayName}</td>
              <td data-label="Project" className="px-6 py-4 hidden md:table-cell">
                {sub.project ? (
                  <span className="inline-flex rounded bg-blue-50 px-2 py-0.5 text-xs text-blue-700 dark:bg-blue-950/60 dark:text-blue-300">
                    {sub.project.name}
                  </span>
                ) : (
                  <span className="text-xs text-gray-500 dark:text-gray-400">Unattributed</span>
                )}
              </td>
              <td data-label="Cost" className="px-6 py-4">
                <p className="font-medium text-gray-900 dark:text-gray-100">{formatUsd(sub.costUsd, sub.currency)}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400">{formatCadence(sub.intervalCount, sub.interval)}</p>
                {sub.currency !== "USD" && (
                  <p className="mt-1 text-[10px] font-medium text-red-600">Convert to USD before activation</p>
                )}
              </td>
              <td data-label="Monthly equivalent" className="hidden px-6 py-4 text-gray-500 dark:text-gray-400 lg:table-cell">
                {formatUsd(sub.monthlyEquivalentUsd, sub.currency)}
              </td>
              <td data-label="Renewal / term" className="hidden px-6 py-4 text-xs text-gray-500 dark:text-gray-400 lg:table-cell">
                {effectiveStatus === "active" && sub.autoRenew
                  ? new Date(sub.nextRenewalAt).toLocaleDateString(undefined, {
                      timeZone: "UTC",
                    })
                  : !sub.autoRenew && ["active", "expired"].includes(effectiveStatus)
                    ? `${new Date(sub.nextRenewalAt).toLocaleDateString(undefined, {
                        timeZone: "UTC",
                      })} ${effectiveStatus === "expired" ? "ended" : "term end"}`
                    : "Not scheduled"}
              </td>
              <td data-label="Status" className="px-6 py-4">
                <span
                  className={`inline-flex px-2 py-1 rounded-full text-xs font-medium ${statusBadgeStyle(effectiveStatus)}`}
                >
                  {effectiveStatus}
                </span>
              </td>
              <td data-label="Actions" className="px-6 py-4">
                <div className="table-actions flex flex-wrap items-center justify-end gap-2">
                  <button
                    type="button"
                    aria-label={`Edit ${sub.name}`}
                    onClick={() => onEdit(sub)}
                    className="inline-flex min-h-11 items-center rounded-md bg-gray-50 px-3 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-100 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
                  >
                    Edit
                  </button>
                  {deleteConfirm === sub.id ? (
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        aria-label={`Confirm deletion of ${sub.name}`}
                        onClick={() => onDelete(sub.id)}
                        disabled={actionLoading === sub.id}
                        className="inline-flex min-h-11 items-center rounded-md bg-red-600 px-3 text-xs font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
                      >
                        Confirm
                      </button>
                      <button
                        type="button"
                        aria-label={`Cancel deletion of ${sub.name}`}
                        onClick={() => setDeleteConfirm(null)}
                        className="inline-flex min-h-11 items-center px-2 text-xs text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      aria-label={`Delete ${sub.name}`}
                      onClick={() => setDeleteConfirm(sub.id)}
                      className="inline-flex min-h-11 items-center rounded-md bg-red-50 px-3 text-xs font-medium text-red-600 transition-colors hover:bg-red-100 dark:bg-red-950/60 dark:text-red-300 dark:hover:bg-red-900/60"
                    >
                      Delete
                    </button>
                  )}
                </div>
              </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
    </div>
  );
}
