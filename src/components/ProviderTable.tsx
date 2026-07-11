import { useState } from "react";
import { type Provider } from "@/app/settings/page";
import { isExternalBillingStale } from "@/components/ExternalBillingDetails";
import ProviderIntegrationInfo, { publicConfigFieldNames } from "@/components/ProviderIntegrationInfo";
import { isManualProvider } from "@/lib/provider-polling";

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

type SortField = "name" | "type" | "status" | "spend" | "renewal" | "alerts" | "credits" | "lastFetched";
type SortDirection = "asc" | "desc";

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
  const [sortField, setSortField] = useState<SortField>("name");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDirection("asc");
    }
  };

  const renderSortIcon = (field: SortField) => {
    if (sortField !== field) {
      return <span className="ml-1 text-gray-300 opacity-0 group-hover:opacity-100">↕</span>;
    }
    return <span className="ml-1 text-gray-500">{sortDirection === "asc" ? "↑" : "↓"}</span>;
  };

  const sortableHeader = (
    field: SortField,
    label: string,
    className = "",
    align: "left" | "right" = "left"
  ) => (
    <th
      scope="col"
      aria-sort={
        sortField === field
          ? sortDirection === "asc"
            ? "ascending"
            : "descending"
          : "none"
      }
      className={`px-6 py-3 font-medium text-gray-500 ${className}`}
    >
      <button
        type="button"
        onClick={() => handleSort(field)}
        className={`group flex w-full items-center rounded-sm hover:text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 ${
          align === "right" ? "justify-end text-right" : "justify-start text-left"
        }`}
      >
        {label} {renderSortIcon(field)}
      </button>
    </th>
  );

  const formatDateObject = (dateStr: string | null) => {
    if (!dateStr) return null;
    return new Date(dateStr);
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

  const sortedProviders = [...providers].sort((a, b) => {
    let comparison = 0;
    switch (sortField) {
      case "name":
        comparison = a.displayName.localeCompare(b.displayName);
        break;
      case "type":
        comparison = a.type.localeCompare(b.type);
        break;
      case "status":
        comparison = (a.isActive ? 1 : 0) - (b.isActive ? 1 : 0);
        break;
      case "spend":
        comparison = (a.spentUsd ?? a.estimatedMonthlyCostUsd) - (b.spentUsd ?? b.estimatedMonthlyCostUsd);
        break;
      case "renewal": {
        const dateA = a.plan?.renewalDate ? new Date(a.plan.renewalDate).getTime() : 0;
        const dateB = b.plan?.renewalDate ? new Date(b.plan.renewalDate).getTime() : 0;
        comparison = dateA - dateB;
        break;
      }
      case "alerts":
        comparison = countProviderAlerts(a).open - countProviderAlerts(b).open;
        break;
      case "credits": {
        const valA = a.latestSnapshot?.credits ?? 0;
        const valB = b.latestSnapshot?.credits ?? 0;
        comparison = valA - valB;
        break;
      }
      case "lastFetched": {
        const dateA = a.latestSnapshot?.fetchedAt ? new Date(a.latestSnapshot.fetchedAt).getTime() : 0;
        const dateB = b.latestSnapshot?.fetchedAt ? new Date(b.latestSnapshot.fetchedAt).getTime() : 0;
        comparison = dateA - dateB;
        break;
      }
    }
    return sortDirection === "asc" ? comparison : -comparison;
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
            {sortableHeader("name", "Name")}
            <th scope="col" className="text-left px-6 py-3 font-medium text-gray-500 hidden md:table-cell">
              Label
            </th>
            {sortableHeader("type", "Type", "hidden sm:table-cell")}
            {sortableHeader("status", "Status", "hidden sm:table-cell")}
            {sortableHeader("spend", "Spend / Budget")}
            {sortableHeader("renewal", "Renewal", "hidden lg:table-cell")}
            {sortableHeader("alerts", "Alerts")}
            {hasAnyCredits && sortableHeader("credits", "Credits", "", "right")}
            {sortableHeader("lastFetched", "Last Fetched", "hidden xl:table-cell")}
            <th scope="col" className="text-right px-6 py-3 font-medium text-gray-500">
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {sortedProviders.map((provider) => {
            const alertCounts = countProviderAlerts(provider);
            const connectedBilling = provider.externalBilling?.[0];
            const fetchedDate = formatDateObject(provider.latestSnapshot?.fetchedAt ?? null);

            return (
              <tr
                key={provider.id}
                className="border-b border-gray-50 hover:bg-gray-50"
              >
                <td data-label="Name" className="px-6 py-4">
                  <div>
                    <ProviderIntegrationInfo
                      providerName={provider.name}
                      providerType={provider.type}
                      displayName={provider.displayName}
                      variant="name"
                      instanceState={{
                        isActive: provider.isActive,
                        primaryCredentialConfigured: Boolean(provider.keyPreview),
                        keyPreview: provider.keyPreview,
                        publicConfigFields: publicConfigFieldNames(provider.config),
                        protectedConfigFields: provider.secretConfigMeta?.fields ?? [],
                        protectedConfigReadable: provider.secretConfigMeta?.readable,
                        lastSnapshotAt: provider.latestSnapshot?.fetchedAt ?? null,
                        externalBillingRecordCount: provider.externalBilling?.length ?? 0,
                        externalBillingSources: [...new Set((provider.externalBilling ?? []).map((record) => record.source))].sort(),
                      }}
                    />
                    <p className="text-xs text-gray-400">{provider.name}</p>
                    {provider.groupId && (
                      <span className="inline-flex items-center gap-1 mt-1 px-1.5 py-0.5 text-[10px] font-medium rounded bg-amber-50 text-amber-700 border border-amber-200">
                        <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                        </svg>
                        Explicitly linked account
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
                        {isExternalBillingStale(
                          connectedBilling,
                          Math.min(24 * 60 * 60 * 1_000, Math.max(60 * 60 * 1_000, provider.refreshIntervalMin * 3 * 60 * 1_000))
                        ) ? " · stale" : ""}
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
                <td data-label="Last fetched" className="px-6 py-4 hidden xl:table-cell">
                  {fetchedDate ? (
                    <div className="flex flex-col">
                      <span className="text-sm text-gray-900">
                        {fetchedDate.toLocaleDateString()}
                      </span>
                      <span className="text-xs text-gray-500">
                        {fetchedDate.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                      </span>
                    </div>
                  ) : (
                    <span className="text-gray-500 text-xs">Never</span>
                  )}
                </td>
                <td data-label="Actions" className="px-6 py-4">
                  <div className="table-actions flex flex-wrap items-center justify-end gap-2">
                    {isManualProvider(provider) ? (
                      <span
                        className="rounded-md bg-gray-100 px-3 py-1.5 text-xs font-medium text-gray-500"
                        title="This provider uses pushed telemetry or manual plan data and has no polling endpoint."
                      >
                        Push / manual
                      </span>
                    ) : (
                      <button
                        type="button"
                        aria-label={`Fetch ${provider.displayName} now`}
                        onClick={() => onFetchNow(provider.id)}
                        disabled={actionLoading === provider.id}
                        className="px-3 py-1.5 text-xs font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-md transition-colors disabled:opacity-50"
                      >
                        {actionLoading === provider.id ? "..." : "Fetch Now"}
                      </button>
                    )}
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
