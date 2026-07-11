"use client";

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
  notes: string | null;
  // Effective knobEnv (this subscription's own override if set, else the
  // provider's free-tier ProviderPlan.knobEnv) and the provider's free-tier
  // map on its own (always present when the provider has one, regardless of
  // this subscription's override). Not yet rendered in this table — phase 1
  // is data model + API only (see docs/rollouts/2026-07-10-subscription-knob-linkage.md).
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
}

const STATUS_STYLES: Record<string, string> = {
  active: "bg-emerald-50 text-emerald-700",
  paused: "bg-amber-50 text-amber-700",
  canceled: "bg-gray-100 text-gray-400",
  considering: "bg-indigo-50 text-indigo-700",
};
const STATUS_ORDER: Record<string, number> = {
  active: 0,
  considering: 1,
  paused: 2,
  canceled: 3,
};

function formatUsd(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
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
}: SubscriptionsPanelProps) {
  if (subscriptions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-4 text-center bg-white rounded-xl border border-gray-200">
        <p className="text-gray-500">No subscriptions tracked yet.</p>
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

  const orderedSubscriptions = [...subscriptions].sort((left, right) => {
    const statusDifference = (STATUS_ORDER[left.status] ?? 99) - (STATUS_ORDER[right.status] ?? 99);
    return statusDifference || left.nextRenewalAt.localeCompare(right.nextRenewalAt) || left.name.localeCompare(right.name);
  });

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
      <table className="responsive-table w-full text-sm">
        <caption className="sr-only">Tracked subscriptions</caption>
        <thead>
          <tr className="border-b border-gray-100 bg-gray-50">
            <th className="text-left px-6 py-3 font-medium text-gray-500">Name</th>
            <th className="text-left px-6 py-3 font-medium text-gray-500 hidden sm:table-cell">Provider</th>
            <th className="text-left px-6 py-3 font-medium text-gray-500 hidden md:table-cell">Project</th>
            <th className="text-left px-6 py-3 font-medium text-gray-500">Cost</th>
            <th className="text-left px-6 py-3 font-medium text-gray-500 hidden lg:table-cell">~ / mo</th>
            <th className="text-left px-6 py-3 font-medium text-gray-500 hidden lg:table-cell">Next renewal</th>
            <th className="text-left px-6 py-3 font-medium text-gray-500">Status</th>
            <th className="text-right px-6 py-3 font-medium text-gray-500">Actions</th>
          </tr>
        </thead>
        <tbody>
          {orderedSubscriptions.map((sub) => (
            <tr key={sub.id} className="border-b border-gray-50 hover:bg-gray-50">
              <td data-label="Name" className="px-6 py-4">
                <p className="font-medium text-gray-900">{sub.name}</p>
                {sub.description && <p className="mt-0.5 max-w-xs text-xs text-gray-500">{sub.description}</p>}
                {!sub.autoRenew && <p className="text-[10px] text-gray-400">does not auto-renew</p>}
              </td>
              <td data-label="Provider" className="px-6 py-4 text-gray-500 hidden sm:table-cell">{sub.provider.displayName}</td>
              <td data-label="Project" className="px-6 py-4 hidden md:table-cell">
                {sub.project ? (
                  <span className="inline-flex px-2 py-0.5 text-xs rounded bg-blue-50 text-blue-700">
                    {sub.project.name}
                  </span>
                ) : (
                  <span className="text-xs text-gray-400">Unattributed</span>
                )}
              </td>
              <td data-label="Cost" className="px-6 py-4">
                <p className="font-medium text-gray-900">{formatUsd(sub.costUsd, sub.currency)}</p>
                <p className="text-xs text-gray-400">{formatCadence(sub.intervalCount, sub.interval)}</p>
                {sub.currency !== "USD" && (
                  <p className="mt-1 text-[10px] font-medium text-red-600">Convert to USD before activation</p>
                )}
              </td>
              <td data-label="Monthly equivalent" className="px-6 py-4 text-gray-500 hidden lg:table-cell">
                {formatUsd(sub.monthlyEquivalentUsd, sub.currency)}
              </td>
              <td data-label="Next renewal" className="px-6 py-4 text-gray-500 text-xs hidden lg:table-cell">
                {sub.status === "active" && sub.autoRenew
                  ? new Date(sub.nextRenewalAt).toLocaleDateString()
                  : "Not scheduled"}
              </td>
              <td data-label="Status" className="px-6 py-4">
                <span
                  className={`inline-flex px-2 py-1 rounded-full text-xs font-medium ${
                    STATUS_STYLES[sub.status] ?? "bg-gray-100 text-gray-500"
                  }`}
                >
                  {sub.status}
                </span>
              </td>
              <td data-label="Actions" className="px-6 py-4">
                <div className="table-actions flex flex-wrap items-center justify-end gap-2">
                  <button
                    type="button"
                    aria-label={`Edit ${sub.name}`}
                    onClick={() => onEdit(sub)}
                    className="px-3 py-1.5 text-xs font-medium text-gray-600 bg-gray-50 hover:bg-gray-100 rounded-md transition-colors"
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
                        className="px-3 py-1.5 text-xs font-medium text-white bg-red-600 hover:bg-red-700 rounded-md transition-colors disabled:opacity-50"
                      >
                        Confirm
                      </button>
                      <button
                        type="button"
                        aria-label={`Cancel deletion of ${sub.name}`}
                        onClick={() => setDeleteConfirm(null)}
                        className="px-2 py-1.5 text-xs text-gray-400 hover:text-gray-600"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      aria-label={`Delete ${sub.name}`}
                      onClick={() => setDeleteConfirm(sub.id)}
                      className="px-3 py-1.5 text-xs font-medium text-red-600 bg-red-50 hover:bg-red-100 rounded-md transition-colors"
                    >
                      Delete
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
