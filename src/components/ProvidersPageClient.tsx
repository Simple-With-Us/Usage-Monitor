"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import DashboardProviderWorkspace from "@/components/DashboardProviderWorkspace";
import EmptyState from "@/components/EmptyState";
import ListLoadErrorPanel from "@/components/ListLoadErrorPanel";
import type { SubscriptionRow } from "@/components/SubscriptionsPanel";
import type { ProviderBudgetIntel } from "@/lib/format";
import {
  COMMAND_PALETTE_PROVIDERS_EVENT,
  type CommandPaletteProviderItem,
} from "@/components/CommandPalette";

export default function ProvidersPageClient() {
  const [providers, setProviders] = useState<any[]>([]);
  const [subscriptions, setSubscriptions] = useState<SubscriptionRow[]>([]);
  const [budgetIntelByProviderId, setBudgetIntelByProviderId] = useState<
    Record<string, ProviderBudgetIntel>
  >({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setWarnings([]);
    const [providersResult, subscriptionsResult, budgetResult] = await Promise.allSettled([
      fetch("/api/providers?view=dashboard", { cache: "no-store" }).then(async (res) => {
        if (!res.ok) throw new Error("Failed to load providers");
        const data = await res.json();
        if (!Array.isArray(data)) throw new Error("Unexpected providers response");
        return data;
      }),
      fetch("/api/subscriptions", { cache: "no-store" }).then(async (res) => {
        if (!res.ok) throw new Error("Failed to load subscriptions");
        const data = await res.json();
        if (!Array.isArray(data)) throw new Error("Unexpected subscriptions response");
        return data as SubscriptionRow[];
      }),
      fetch("/api/budget-status", { cache: "no-store" }).then(async (res) =>
        res.ok ? res.json() : null
      ),
    ]);

    if (providersResult.status === "fulfilled") {
      setProviders(providersResult.value);
      const items: CommandPaletteProviderItem[] = providersResult.value.map((p: any) => ({
        id: p.id,
        label: p.displayName || p.name,
      }));
      window.dispatchEvent(
        new CustomEvent(COMMAND_PALETTE_PROVIDERS_EVENT, { detail: items })
      );
    } else {
      setError(
        providersResult.reason instanceof Error
          ? providersResult.reason.message
          : "Failed to load providers"
      );
    }

    if (subscriptionsResult.status === "fulfilled") {
      setSubscriptions(subscriptionsResult.value);
    } else {
      setWarnings((w) => [...w, "Tracked subscriptions are temporarily unavailable."]);
    }

    if (budgetResult.status === "fulfilled" && budgetResult.value?.providers) {
      const map: Record<string, ProviderBudgetIntel> = {};
      for (const row of budgetResult.value.providers) {
        if (!row || typeof row.id !== "string") continue;
        map[row.id] = {
          projectedStatus: row.projectedStatus ?? null,
          projectedRunoutDate: row.projectedRunoutDate ?? null,
          daysUntilBudgetExhausted: row.daysUntilBudgetExhausted ?? null,
        };
      }
      setBudgetIntelByProviderId(map);
    }

    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Providers</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Family workspace for spend, health, and sync — same table as Overview.
          </p>
        </div>
        <Link
          href="/settings?tab=connections"
          className="inline-flex min-h-11 items-center rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
        >
          Manage connections
        </Link>
      </div>

      {warnings.length > 0 && (
        <div
          role="status"
          className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200"
        >
          {warnings.join(" ")}
        </div>
      )}

      {loading && providers.length === 0 ? (
        <div className="animate-pulse rounded-2xl border border-gray-200 bg-white h-96 dark:border-gray-700 dark:bg-gray-800" />
      ) : error && providers.length === 0 ? (
        <ListLoadErrorPanel
          message="Providers couldn't be loaded."
          detail={error}
          onRetry={() => void load()}
        />
      ) : providers.length === 0 ? (
        <EmptyState
          title="No providers yet"
          message="Connect an API provider to track spend, budgets, and sync health."
          action={
            <Link
              href="/settings?tab=connections"
              className="inline-flex min-h-11 items-center rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90"
            >
              Add your first provider
            </Link>
          }
        />
      ) : (
        <DashboardProviderWorkspace
          providers={providers}
          subscriptions={subscriptions}
          initiallyExpanded
          budgetIntelByProviderId={budgetIntelByProviderId}
        />
      )}
    </div>
  );
}
