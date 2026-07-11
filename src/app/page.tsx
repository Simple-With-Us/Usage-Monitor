"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import ProviderCard from "@/components/ProviderCard";
import SentryHealthCard from "@/components/SentryHealthCard";
import DashboardSummaryCards from "@/components/DashboardSummaryCards";
import ExternalTelemetryPanel, { type ExternalUsageSummary } from "@/components/ExternalTelemetryPanel";
import ProjectsPanel, { type ProjectBudgetStatus } from "@/components/ProjectsPanel";
import type { ExternalBillingRecord } from "@/components/ExternalBillingDetails";

interface Provider {
  id: string;
  name: string;
  displayName: string;
  type: string;
  isActive: boolean;
  groupId: string | null;
  label: string | null;
  keyPreview?: string | null;
  estimatedMonthlyCostUsd: number;
  projectedEomUsd: number;
  spentUsd?: number;
  externalBilling?: ExternalBillingRecord[];
  billingMode: "actual" | "estimated" | "manual";
  alerts: {
    severity: "critical" | "warning" | "info";
    message: string;
  }[];
  latestSnapshot: {
    balance: number | null;
    totalCost: number | null;
    totalRequests: number | null;
    credits: number | null;
    fetchedAt: string;
  } | null;
}

async function fetchJson<T>(url: string, label: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Failed to fetch ${label}`);
  }
  return response.json() as Promise<T>;
}

export default function DashboardPage() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [usageSummary, setUsageSummary] = useState<ExternalUsageSummary | null>(null);
  const [projects, setProjects] = useState<ProjectBudgetStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const loadedOnce = useRef(false);
  const hasProviderData = useRef(false);

  const fetchProviders = useCallback(async () => {
    if (loadedOnce.current && hasProviderData.current) setRefreshing(true);
    else setLoading(true);
    setError("");
    setWarnings([]);

    try {
      const [providersResult, usageResult, projectsResult] = await Promise.allSettled([
        fetchJson<Provider[]>("/api/providers", "providers"),
        fetchJson<ExternalUsageSummary>("/api/usage-events?days=30", "app telemetry"),
        fetchJson<ProjectBudgetStatus[]>("/api/projects", "projects"),
      ]);

      const nextWarnings: string[] = [];
      if (providersResult.status === "fulfilled") {
        setProviders(providersResult.value);
        hasProviderData.current = true;
      } else if (!hasProviderData.current) {
        setError(providersResult.reason instanceof Error ? providersResult.reason.message : "Failed to load providers");
      } else {
        nextWarnings.push("Provider data could not be refreshed; showing the last successful result.");
      }

      if (usageResult.status === "fulfilled") {
        setUsageSummary(usageResult.value);
      } else {
        nextWarnings.push("External app telemetry is temporarily unavailable.");
      }

      if (projectsResult.status === "fulfilled") {
        setProjects(projectsResult.value);
      } else {
        nextWarnings.push("Project budgets are temporarily unavailable.");
      }

      setWarnings(nextWarnings);
      if (providersResult.status === "fulfilled") setLastUpdatedAt(new Date().toISOString());
    } finally {
      loadedOnce.current = true;
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetching on mount
    fetchProviders();
  }, [fetchProviders]);

  // Deduplicate balance by groupId: only count each group's balance once
  const seenGroups = new Set<string | null>();
  const totalBalance = providers.reduce((sum, p) => {
    const balance = p.latestSnapshot?.balance || 0;
    if (!p.groupId) {
      return sum + balance;
    }
    if (seenGroups.has(p.groupId)) {
      return sum;
    }
    seenGroups.add(p.groupId);
    // Use the first non-null balance in the group
    const groupProviders = providers.filter((x) => x.groupId === p.groupId);
    const groupBalance = groupProviders.find((x) => x.latestSnapshot?.balance != null)?.latestSnapshot?.balance;
    return sum + (groupBalance ?? 0);
  }, 0);
  const totalCost = providers.reduce(
    (sum, p) => sum + (p.spentUsd ?? p.latestSnapshot?.totalCost ?? 0),
    0
  );
  const totalProjectedMonthlyCost = providers.reduce(
    (sum, p) => sum + (p.projectedEomUsd || 0),
    0
  );
  const totalCredits = providers.reduce(
    (sum, p) => sum + (p.latestSnapshot?.credits || 0),
    0
  );
  const hasAnyCredits = providers.some(
    (p) => p.latestSnapshot?.credits != null
  );
  const attentionItems = providers.flatMap((provider) =>
    provider.alerts
      .filter((alert) => alert.severity !== "info")
      .map((alert) => ({ provider, alert }))
  ).sort((left, right) => {
    const severityRank = { critical: 0, warning: 1, info: 2 } as const;
    return (
      severityRank[left.alert.severity] - severityRank[right.alert.severity] ||
      left.provider.displayName.localeCompare(right.provider.displayName) ||
      left.alert.message.localeCompare(right.alert.message)
    );
  });
  const criticalCount = attentionItems.filter(
    (item) => item.alert.severity === "critical"
  ).length;

  if (loading) {
    return (
      <div className="space-y-8 animate-pulse">
        <div className="h-8 w-48 bg-gray-200 rounded"></div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="bg-gray-100 rounded-xl border border-gray-200 p-6 h-28"></div>
          ))}
        </div>
        <div className="bg-gray-100 rounded-xl border border-gray-200 h-48"></div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="bg-gray-100 rounded-xl border border-gray-200 p-6 h-40"></div>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4">
        <p role="alert" className="text-red-600">{error}</p>
        <button
          type="button"
          onClick={fetchProviders}
          className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
        <div className="flex items-center gap-3">
          {lastUpdatedAt && (
            <span className="hidden text-xs text-gray-500 sm:inline">
              Updated {new Date(lastUpdatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
            </span>
          )}
          <button
            type="button"
            onClick={fetchProviders}
            disabled={refreshing}
            className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {warnings.length > 0 && (
        <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {warnings.join(" ")}
        </div>
      )}

      <DashboardSummaryCards
        totalBalance={totalBalance}
        totalProjectedMonthlyCost={totalProjectedMonthlyCost}
        totalCost={totalCost}
        attentionItemsCount={attentionItems.length}
        criticalCount={criticalCount}
        hasAnyCredits={hasAnyCredits}
        totalCredits={totalCredits}
      />

      {usageSummary && <ExternalTelemetryPanel usageSummary={usageSummary} />}

      <SentryHealthCard />

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-800">Attention</h2>
          <Link href="/settings" className="text-xs font-medium text-blue-600">
            Manage budgets
          </Link>
        </div>
        {attentionItems.length === 0 ? (
          <div className="px-6 py-5 text-sm text-gray-500">
            No payment, budget, or limit alerts.
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {attentionItems.slice(0, 8).map(({ provider, alert }, index) => (
              <Link
                key={`${provider.id}-${index}`}
                href={`/providers/${provider.id}`}
                className="flex items-start justify-between gap-4 px-6 py-4 hover:bg-gray-50"
              >
                <div>
                  <p className="text-sm font-medium text-gray-900">
                    {provider.displayName}
                    {provider.label ? ` - ${provider.label}` : ""}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">{alert.message}</p>
                </div>
                <span
                  className={`text-xs font-medium px-2 py-1 rounded-full ${
                    alert.severity === "critical"
                      ? "bg-red-50 text-red-700"
                      : "bg-amber-50 text-amber-700"
                  }`}
                >
                  {alert.severity}
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>

      {projects.length > 0 && <ProjectsPanel projects={projects} />}

      {/* Provider Grid */}
      {providers.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-4">
          <svg
            aria-hidden="true"
            className="w-16 h-16 text-gray-300"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
               strokeLinecap="round"
               strokeLinejoin="round"
               strokeWidth={1.5}
               d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
            />
          </svg>
          <p className="text-gray-500 text-lg">No providers configured yet</p>
          <Link
            href="/settings"
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
          >
            Add your first provider
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {providers.map((provider) => (
            <ProviderCard
              key={provider.id}
              id={provider.id}
              name={provider.name}
              displayName={provider.displayName}
              type={provider.type}
              label={provider.label}
              keyPreview={provider.keyPreview}
              estimatedMonthlyCostUsd={provider.estimatedMonthlyCostUsd}
              projectedEomUsd={provider.projectedEomUsd}
              spentUsd={provider.spentUsd}
              externalBilling={provider.externalBilling}
              billingMode={provider.billingMode}
              alerts={provider.alerts}
              latestSnapshot={provider.latestSnapshot}
            />
          ))}
        </div>
      )}
    </div>
  );
}
