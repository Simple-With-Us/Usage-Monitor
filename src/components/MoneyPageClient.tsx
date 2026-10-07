"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import FleetBudgetCard from "@/components/FleetBudgetCard";
import PaidServicesPanel from "@/components/PaidServicesPanel";
import ListLoadErrorPanel from "@/components/ListLoadErrorPanel";
import type { SubscriptionRow } from "@/components/SubscriptionsPanel";
import type { BillingInventoryProvider } from "@/lib/billing-inventory";

export default function MoneyPageClient() {
  const [providers, setProviders] = useState<BillingInventoryProvider[]>([]);
  const [subscriptions, setSubscriptions] = useState<SubscriptionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [subscriptionsError, setSubscriptionsError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setProvidersError(null);
    setSubscriptionsError(null);
    const [providersResult, subscriptionsResult] = await Promise.allSettled([
      fetch("/api/providers", { cache: "no-store" }).then(async (res) => {
        if (!res.ok) throw new Error("Failed to load providers");
        const data = await res.json();
        if (!Array.isArray(data)) throw new Error("Unexpected providers response");
        return data as BillingInventoryProvider[];
      }),
      fetch("/api/subscriptions", { cache: "no-store" }).then(async (res) => {
        if (!res.ok) throw new Error("Failed to load subscriptions");
        const data = await res.json();
        if (!Array.isArray(data)) throw new Error("Unexpected subscriptions response");
        return data as SubscriptionRow[];
      }),
    ]);

    if (providersResult.status === "fulfilled") {
      setProviders(providersResult.value);
    } else {
      setProvidersError(
        providersResult.reason instanceof Error
          ? providersResult.reason.message
          : "Failed to load providers"
      );
    }
    if (subscriptionsResult.status === "fulfilled") {
      setSubscriptions(subscriptionsResult.value);
    } else {
      setSubscriptionsError(
        subscriptionsResult.reason instanceof Error
          ? subscriptionsResult.reason.message
          : "Failed to load subscriptions"
      );
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const hardFail =
    Boolean(providersError) &&
    Boolean(subscriptionsError) &&
    providers.length === 0 &&
    subscriptions.length === 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Money</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Paid services and recurring costs. Edit terms and links in Settings.
          </p>
        </div>
        <Link
          href="/settings?tab=services"
          className="inline-flex min-h-11 items-center rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90"
        >
          Manage subscriptions
        </Link>
      </div>

      <FleetBudgetCard />

      {loading && providers.length === 0 && subscriptions.length === 0 ? (
        <div className="animate-pulse rounded-2xl border border-gray-200 bg-white h-64 dark:border-gray-700 dark:bg-gray-800" />
      ) : hardFail ? (
        <ListLoadErrorPanel
          message="Paid services couldn't be loaded."
          detail={[providersError, subscriptionsError].filter(Boolean).join(" ")}
          onRetry={() => void load()}
        />
      ) : (
        <>
          {(providersError || subscriptionsError) && (
            <div
              role="status"
              className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200"
            >
              {[providersError, subscriptionsError].filter(Boolean).join(" ")}{" "}
              <button
                type="button"
                onClick={() => void load()}
                className="font-semibold underline underline-offset-2"
              >
                Retry
              </button>
            </div>
          )}
          <PaidServicesPanel
            providers={providers}
            subscriptions={subscriptions}
            variant="dashboard"
            showCoverage
          />
        </>
      )}
    </div>
  );
}
