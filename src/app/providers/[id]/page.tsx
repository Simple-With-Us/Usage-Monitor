"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import UsageChart from "@/components/UsageChart";
import BalanceBadge from "@/components/BalanceBadge";
import ExternalBillingDetails, { type ExternalBillingRecord } from "@/components/ExternalBillingDetails";
import ProviderIntegrationInfo, { publicConfigFieldNames } from "@/components/ProviderIntegrationInfo";

interface Provider {
  id: string;
  name: string;
  displayName: string;
  type: string;
  config?: Record<string, unknown>;
  keyPreview?: string | null;
  secretConfigMeta?: { configured: boolean; fields: string[]; readable: boolean };
  refreshIntervalMin: number;
  isActive: boolean;
  label: string | null;
  billingMode: "actual" | "estimated" | "manual";
  estimatedMonthlyCostUsd: number;
  spentUsd?: number;
  projectedEomUsd?: number;
  externalBilling?: ExternalBillingRecord[];
  latestSnapshot?: { fetchedAt: string } | null;
  plan: {
    fixedMonthlyCostUsd: number | null;
    monthlyBudgetUsd: number | null;
    monthlyRequestLimit: number | null;
    lowBalanceUsd: number | null;
    lowCredits: number | null;
    renewalDate: string | null;
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
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [snapshotWarning, setSnapshotWarning] = useState("");
  const [rangeDays, setRangeDays] = useState(30);
  const [snapshotPage, setSnapshotPage] = useState(1);
  const loadedOnce = useRef(false);
  const hasProviderData = useRef(false);

  const fetchData = useCallback(async () => {
    if (loadedOnce.current && hasProviderData.current) setRefreshing(true);
    else setLoading(true);
    setError("");
    setSnapshotWarning("");
    try {
      const [providerResult, snapshotsResult] = await Promise.allSettled([
        fetchJson<Provider>(`/api/providers/${id}`, "provider"),
        fetchJson<Snapshot[]>(`/api/snapshots?providerId=${id}&days=${rangeDays}`, "snapshots"),
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
    } finally {
      loadedOnce.current = true;
      setLoading(false);
      setRefreshing(false);
    }
  }, [id, rangeDays]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetching on mount
    fetchData();
  }, [fetchData]);

  const hasCredits = snapshots.some((s) => s.credits != null);
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
            <div key={i} className="bg-gray-100 rounded-xl border border-gray-200 p-4 h-24"></div>
          ))}
        </div>
        <div className="bg-gray-100 rounded-xl border border-gray-200 p-4 h-32"></div>
        <div className="bg-gray-100 rounded-xl border border-gray-200 h-64"></div>
      </div>
    );
  }

  if (error || !provider) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4">
        <p role="alert" className="text-red-600">{error || "Not found"}</p>
        <Link
          href="/"
          className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700"
        >
          Back to Dashboard
        </Link>
      </div>
    );
  }

  const latest = snapshots[snapshots.length - 1];
  const newestSnapshots = [...snapshots].reverse();
  const totalSnapshotPages = Math.max(1, Math.ceil(newestSnapshots.length / SNAPSHOT_PAGE_SIZE));
  const currentSnapshotPage = Math.min(snapshotPage, totalSnapshotPages);
  const visibleSnapshots = newestSnapshots.slice(
    (currentSnapshotPage - 1) * SNAPSHOT_PAGE_SIZE,
    currentSnapshotPage * SNAPSHOT_PAGE_SIZE
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm text-gray-500">
        <Link href="/" className="hover:text-gray-900">
          Dashboard
        </Link>
        <span>/</span>
        <span className="text-gray-900">{provider.displayName}</span>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
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
              primaryCredentialConfigured: Boolean(provider.keyPreview),
              keyPreview: provider.keyPreview,
              publicConfigFields: publicConfigFieldNames(provider.config),
              protectedConfigFields: provider.secretConfigMeta?.fields ?? [],
              protectedConfigReadable: provider.secretConfigMeta?.readable,
              lastSnapshotAt: provider.latestSnapshot?.fetchedAt ?? latest?.fetchedAt ?? null,
              externalBillingRecordCount: provider.externalBilling?.length ?? 0,
              externalBillingSources: [...new Set((provider.externalBilling ?? []).map((record) => record.source))].sort(),
            }}
          />
        </div>
        <span className="px-2 py-1 text-xs font-medium text-gray-500 uppercase bg-gray-100 rounded">
          {provider.type}
        </span>
      </div>

      {snapshotWarning && (
        <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {snapshotWarning}
        </p>
      )}

      {openAlerts.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100">
            <h2 className="text-sm font-semibold text-gray-700">Alerts</h2>
          </div>
          <div className="divide-y divide-gray-100">
            {openAlerts.map((alert, index) => (
              <div key={index} className="px-6 py-4 flex items-start gap-3">
                <span
                  className={`mt-0.5 text-xs font-medium px-2 py-1 rounded-full ${
                    alert.severity === "critical"
                      ? "bg-red-50 text-red-700"
                      : "bg-amber-50 text-amber-700"
                  }`}
                >
                  {alert.severity}
                </span>
                <p className="text-sm text-gray-700">{alert.message}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      <ExternalBillingDetails
        records={provider.externalBilling ?? []}
        refreshIntervalMin={provider.refreshIntervalMin}
      />

      {/* Summary stats */}
      <div
        className={`grid grid-cols-1 sm:grid-cols-2 ${
          hasCredits ? "lg:grid-cols-5" : "lg:grid-cols-4"
        } gap-4`}
      >
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <p className="text-xs text-gray-500 mb-1">Balance</p>
          <BalanceBadge
            amount={latest?.balance ?? null}
            className="text-lg font-semibold"
          />
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <p className="text-xs text-gray-500 mb-1">Tracked spend this month</p>
          <p className="text-lg font-semibold text-amber-600">
            {formatUsd(provider.spentUsd ?? provider.estimatedMonthlyCostUsd)}
          </p>
          <p className="text-[10px] text-gray-500">
            {provider.spentUsd == null ? "provider-report fallback" : "poll + telemetry + subscriptions"}
          </p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <p className="text-xs text-gray-500 mb-1">Projected end of month</p>
          <p className="text-lg font-semibold text-gray-900">
            {formatUsd(provider.projectedEomUsd ?? provider.estimatedMonthlyCostUsd)}
          </p>
          <p className="text-[10px] uppercase text-gray-400">
            {provider.billingMode}
          </p>
        </div>
        {hasCredits && (
          <div className="bg-white rounded-xl border border-gray-200 p-4">
            <p className="text-xs text-gray-500 mb-1">Credits</p>
            <p className="text-lg font-semibold text-purple-600">
              {latest?.credits != null
                ? new Intl.NumberFormat("en-US").format(latest.credits)
                : "--"}
            </p>
          </div>
        )}
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <p className="text-xs text-gray-500 mb-1">Latest reported requests</p>
          <p className="text-lg font-semibold text-gray-900">
            {latest?.totalRequests != null
              ? new Intl.NumberFormat("en-US").format(latest.totalRequests)
              : "--"}
          </p>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <h2 className="text-sm font-semibold text-gray-700 mb-3">
          Billing Plan
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>
            <p className="text-xs text-gray-500 mb-1">Plan Price</p>
            <p className="font-medium text-gray-900">
              {formatUsd(provider.plan?.fixedMonthlyCostUsd)}
            </p>
          </div>
          <div>
            <p className="text-xs text-gray-500 mb-1">Monthly Budget</p>
            <p className="font-medium text-gray-900">
              {formatUsd(provider.plan?.monthlyBudgetUsd)}
            </p>
          </div>
          <div>
            <p className="text-xs text-gray-500 mb-1">Request Limit</p>
            <p className="font-medium text-gray-900">
              {provider.plan?.monthlyRequestLimit != null
                ? new Intl.NumberFormat("en-US").format(
                    provider.plan.monthlyRequestLimit
                  )
                : "--"}
            </p>
          </div>
          <div>
            <p className="text-xs text-gray-500 mb-1">Renewal</p>
            <p className="font-medium text-gray-900">
              {provider.plan?.renewalDate
                ? new Date(provider.plan.renewalDate).toLocaleDateString(undefined, {
                    timeZone: "UTC",
                  })
                : "--"}
            </p>
          </div>
        </div>
        {provider.plan?.notes && (
          <p className="text-xs text-gray-500 mt-4">{provider.plan.notes}</p>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-gray-500">Showing provider-reported snapshots from the selected window.</p>
        <label className="flex items-center gap-2 text-sm text-gray-700">
          Range
          <select
            aria-label="Snapshot history range"
            value={rangeDays}
            onChange={(event) => {
              setRangeDays(Number(event.target.value));
              setSnapshotPage(1);
            }}
            disabled={refreshing}
            className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
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
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-gray-700">Recent Snapshots</h3>
            <span className="text-xs text-gray-500">{snapshots.length} records · {rangeDays} days</span>
          </div>
        </div>
        {snapshots.length === 0 ? (
          <div className="px-6 py-8 text-center text-sm text-gray-400">
            No snapshots recorded yet
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="responsive-table w-full text-sm">
              <caption className="sr-only">Provider snapshot history</caption>
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  <th className="text-left px-6 py-3 font-medium text-gray-500">
                    Date
                  </th>
                  <th className="text-right px-6 py-3 font-medium text-gray-500">
                    Balance
                  </th>
                  <th className="text-right px-6 py-3 font-medium text-gray-500">
                    Reported Cost
                  </th>
                  {hasCredits && (
                    <th className="text-right px-6 py-3 font-medium text-gray-500">
                      Credits
                    </th>
                  )}
                  <th className="text-right px-6 py-3 font-medium text-gray-500">
                    Reported Requests
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibleSnapshots.map((s) => (
                  <tr
                    key={s.id}
                    className="border-b border-gray-50 hover:bg-gray-50"
                  >
                    <td data-label="Date" className="px-6 py-3 text-gray-600">
                      {new Date(s.fetchedAt).toLocaleString()}
                    </td>
                    <td data-label="Balance" className="px-6 py-3 text-right">
                      <BalanceBadge amount={s.balance} />
                    </td>
                    <td data-label="Reported cost" className="px-6 py-3 text-right text-amber-600">
                      {s.totalCost != null
                        ? new Intl.NumberFormat("en-US", {
                            style: "currency",
                            currency: "USD",
                          }).format(s.totalCost)
                        : "--"}
                    </td>
                    {hasCredits && (
                      <td data-label="Credits" className="px-6 py-3 text-right text-purple-600">
                        {s.credits != null
                          ? new Intl.NumberFormat("en-US").format(s.credits)
                          : "--"}
                      </td>
                    )}
                    <td data-label="Reported requests" className="px-6 py-3 text-right text-gray-600">
                      {s.totalRequests != null
                        ? new Intl.NumberFormat("en-US").format(s.totalRequests)
                        : "--"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {totalSnapshotPages > 1 && (
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 px-4 py-3 sm:px-6">
                <p className="text-xs text-gray-500">
                  Page {currentSnapshotPage} of {totalSnapshotPages}
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setSnapshotPage((page) => Math.max(1, page - 1))}
                    disabled={currentSnapshotPage === 1}
                    className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 disabled:opacity-40"
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    onClick={() => setSnapshotPage((page) => Math.min(totalSnapshotPages, page + 1))}
                    disabled={currentSnapshotPage === totalSnapshotPages}
                    className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 disabled:opacity-40"
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
