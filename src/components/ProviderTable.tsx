import { type Provider } from "@/app/settings/page";

interface ProviderTableProps {
  providers: Provider[];
  actionLoading: string | null;
  deleteConfirm: string | null;
  onEdit: (provider: Provider) => void;
  onDeleteConfirmStart: (id: string) => void;
  onDeleteConfirmCancel: () => void;
  onDelete: (id: string) => void;
  onAddProvider: () => void;
  onToggleActive: (provider: Provider) => void;
  onFetchNow: (id: string) => void;
}

export default function ProviderTable({
  providers,
  actionLoading,
  deleteConfirm,
  onEdit,
  onDeleteConfirmStart,
  onDeleteConfirmCancel,
  onDelete,
  onAddProvider,
  onToggleActive,
  onFetchNow,
}: ProviderTableProps) {
  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return "Never";
    return new Date(dateStr).toLocaleString();
  };

  const formatUsd = (amount: number | null | undefined) => {
    if (amount == null) return "--";
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 2,
    }).format(amount);
  };

  const formatDateOnly = (dateStr: string | null | undefined) => {
    if (!dateStr) return "--";
    return new Date(dateStr).toLocaleDateString();
  };

  const hasAnyCredits = providers.some(
    (p) => p.latestSnapshot?.credits != null
  );

  const countProviderAlerts = (provider: Provider) => ({
    open: provider.alerts.filter((a) => a.severity !== "info").length,
    info: provider.alerts.filter((a) => a.severity === "info").length,
    critical: provider.alerts.filter((a) => a.severity === "critical").length,
  });

  const orderedProviders = [...providers].sort((left, right) => {
    const severity = (provider: Provider) =>
      provider.alerts.some((alert) => alert.severity === "critical")
        ? 0
        : provider.alerts.some((alert) => alert.severity === "warning")
          ? 1
          : 2;
    return severity(left) - severity(right) || left.displayName.localeCompare(right.displayName);
  });

  if (providers.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-4 text-center bg-white rounded-xl border border-gray-200">
        <p className="text-gray-500">No providers configured yet.</p>
        <button
          type="button"
          onClick={onAddProvider}
          className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700"
        >
          Add your first provider
        </button>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
      <table className="responsive-table w-full text-sm">
        <caption className="sr-only">Configured API providers</caption>
        <thead>
          <tr className="border-b border-gray-100 bg-gray-50">
            <th className="text-left px-6 py-3 font-medium text-gray-500">
              Name
            </th>
            <th className="text-left px-6 py-3 font-medium text-gray-500 hidden md:table-cell">
              Label
            </th>
            <th className="text-left px-6 py-3 font-medium text-gray-500 hidden sm:table-cell">
              Type
            </th>
            <th className="text-left px-6 py-3 font-medium text-gray-500 hidden sm:table-cell">
              Status
            </th>
            <th className="text-left px-6 py-3 font-medium text-gray-500">
              Spend / Budget
            </th>
            <th className="text-left px-6 py-3 font-medium text-gray-500 hidden lg:table-cell">
              Renewal
            </th>
            <th className="text-left px-6 py-3 font-medium text-gray-500">
              Alerts
            </th>
            {hasAnyCredits && (
              <th className="text-right px-6 py-3 font-medium text-gray-500">
                Credits
              </th>
            )}
            <th className="text-left px-6 py-3 font-medium text-gray-500 hidden xl:table-cell">
              Last Fetched
            </th>
            <th className="text-right px-6 py-3 font-medium text-gray-500">
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {orderedProviders.map((provider) => {
            const alertCounts = countProviderAlerts(provider);
            const connectedBilling = provider.externalBilling?.[0];

            return (
              <tr
                key={provider.id}
                className="border-b border-gray-50 hover:bg-gray-50"
              >
                <td data-label="Name" className="px-6 py-4">
                  <div>
                    <p className="font-medium text-gray-900">
                      {provider.displayName}
                    </p>
                    <p className="text-xs text-gray-400">{provider.name}</p>
                    {provider.groupId && (
                      <span className="inline-flex items-center gap-1 mt-1 px-1.5 py-0.5 text-[10px] font-medium rounded bg-amber-50 text-amber-700 border border-amber-200">
                        <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                        </svg>
                        Shared balance
                      </span>
                    )}
                  </div>
                </td>
                <td data-label="Label" className="px-6 py-4 hidden md:table-cell">
                  <span className="text-xs text-gray-400">
                    {provider.label || "--"}
                  </span>
                </td>
                <td data-label="Type" className="px-6 py-4 hidden sm:table-cell">
                  <span className="inline-flex px-2 py-0.5 text-xs font-medium uppercase rounded bg-gray-100 text-gray-500">
                    {provider.type}
                  </span>
                </td>
                <td data-label="Status" className="px-6 py-4 hidden sm:table-cell">
                  <button
                    type="button"
                    aria-label={`${provider.isActive ? "Deactivate" : "Activate"} ${provider.displayName}`}
                    onClick={() => onToggleActive(provider)}
                    disabled={actionLoading === provider.id}
                    className={`inline-flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded-full transition-colors ${
                      provider.isActive
                        ? "bg-emerald-50 text-emerald-700"
                        : "bg-gray-100 text-gray-400"
                    }`}
                  >
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${
                        provider.isActive ? "bg-emerald-500" : "bg-gray-300"
                      }`}
                    />
                    {provider.isActive ? "Active" : "Inactive"}
                  </button>
                </td>
                <td data-label="Spend / Budget" className="px-6 py-4">
                  <div className="text-xs">
                    <p className="font-medium text-gray-900">
                      {formatUsd(provider.spentUsd ?? provider.estimatedMonthlyCostUsd)} MTD
                    </p>
                    {provider.projectedEomUsd != null && (
                      <p className="text-gray-400">Projected {formatUsd(provider.projectedEomUsd)}</p>
                    )}
                    <p className="text-gray-400">
                      Budget {formatUsd(provider.plan?.monthlyBudgetUsd)}
                    </p>
                    <span className="inline-flex mt-1 px-1.5 py-0.5 rounded bg-gray-100 text-[10px] font-medium uppercase text-gray-500">
                      {provider.billingMode}
                    </span>
                    {connectedBilling && (
                      <p className="mt-1 text-[10px] font-medium text-blue-700">
                        Connected: {connectedBilling.planName || connectedBilling.kind}
                        {connectedBilling.status ? ` · ${connectedBilling.status}` : ""}
                      </p>
                    )}
                  </div>
                </td>
                <td data-label="Renewal" className="px-6 py-4 text-xs text-gray-500 hidden lg:table-cell">
                  {formatDateOnly(provider.plan?.renewalDate)}
                </td>
                <td data-label="Alerts" className="px-6 py-4">
                  {alertCounts.open > 0 ? (
                    <span
                      className={`inline-flex px-2 py-1 rounded-full text-xs font-medium ${
                        alertCounts.critical > 0
                          ? "bg-red-50 text-red-700"
                          : "bg-amber-50 text-amber-700"
                      }`}
                    >
                      {alertCounts.open}{" "}
                      open
                    </span>
                  ) : alertCounts.info > 0 ? (
                    <span className="inline-flex px-2 py-1 rounded-full bg-blue-50 text-blue-700 text-xs font-medium">
                      Needs setup
                    </span>
                  ) : (
                    <span className="inline-flex px-2 py-1 rounded-full bg-emerald-50 text-emerald-700 text-xs font-medium">
                      OK
                    </span>
                  )}
                </td>
                {hasAnyCredits && (
                  <td data-label="Credits" className="px-6 py-4 text-right text-purple-600 text-xs">
                    {provider.latestSnapshot?.credits != null
                      ? new Intl.NumberFormat("en-US").format(
                          provider.latestSnapshot.credits
                        )
                      : "--"}
                  </td>
                )}
                <td data-label="Last fetched" className="px-6 py-4 text-gray-500 text-xs hidden xl:table-cell">
                  {formatDate(provider.latestSnapshot?.fetchedAt ?? null)}
                </td>
                <td data-label="Actions" className="px-6 py-4">
                  <div className="table-actions flex flex-wrap items-center justify-end gap-2">
                    <button
                      type="button"
                      aria-label={`Fetch ${provider.displayName} now`}
                      onClick={() => onFetchNow(provider.id)}
                      disabled={actionLoading === provider.id}
                      className="px-3 py-1.5 text-xs font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-md transition-colors disabled:opacity-50"
                    >
                      {actionLoading === provider.id ? "..." : "Fetch Now"}
                    </button>
                    <button
                      type="button"
                      aria-label={`Edit ${provider.displayName}`}
                      onClick={() => onEdit(provider)}
                      className="px-3 py-1.5 text-xs font-medium text-gray-600 bg-gray-50 hover:bg-gray-100 rounded-md transition-colors"
                    >
                      Edit
                    </button>
                    {deleteConfirm === provider.id ? (
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          aria-label={`Confirm deletion of ${provider.displayName}`}
                          onClick={() => onDelete(provider.id)}
                          disabled={actionLoading === provider.id}
                          className="px-3 py-1.5 text-xs font-medium text-white bg-red-600 hover:bg-red-700 rounded-md transition-colors disabled:opacity-50"
                        >
                          Confirm
                        </button>
                        <button
                          type="button"
                          aria-label={`Cancel deletion of ${provider.displayName}`}
                          onClick={() => onDeleteConfirmCancel()}
                          className="px-2 py-1.5 text-xs text-gray-400 hover:text-gray-600"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        aria-label={`Delete ${provider.displayName}`}
                        onClick={() => onDeleteConfirmStart(provider.id)}
                        className="px-3 py-1.5 text-xs font-medium text-red-600 bg-red-50 hover:bg-red-100 rounded-md transition-colors"
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
  );
}
