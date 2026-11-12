import { prisma } from "@/lib/prisma";
import { providerPollSnapshotExpected } from "@/lib/anthropic-credentials";
import {
  MAX_POLL_FRESHNESS_MS,
  resolveProviderSyncMode,
} from "@/lib/provider-sync-mode";
import { isDecommissionedProviderName } from "@/lib/provider-definitions";
import { budgetPollingPaused } from "@/lib/budget-controls";

const DEFAULT_REFRESH_CAP = 12;

export interface StaleRefreshResult {
  considered: number;
  refreshed: number;
  failed: number;
  skipped: number;
  providerIds: string[];
}

/**
 * Providers the poll loop should treat as due even if their configured
 * interval has not elapsed: pollable, active, and either missing a recent
 * usage snapshot or carrying an old ProviderExternalBilling confirmation.
 */
export async function listStalePollableProviderIds(
  nowMs: number = Date.now(),
  cap: number = DEFAULT_REFRESH_CAP
): Promise<string[]> {
  if (
    typeof prisma.provider?.findMany !== "function" ||
    typeof prisma.usageSnapshot?.groupBy !== "function" ||
    typeof prisma.providerExternalBilling?.findMany !== "function"
  ) {
    return [];
  }
  const cutoff = new Date(nowMs - MAX_POLL_FRESHNESS_MS);
  const providers = await prisma.provider.findMany({
    where: { isActive: true },
    select: {
      id: true,
      name: true,
      type: true,
      apiKey: true,
      config: true,
      secretConfig: true,
      budgetControlsEnabled: true,
      budgetBreachState: true,
      budgetPausedAt: true,
    },
  });

  const pollable = providers.filter((provider) => {
    if (isDecommissionedProviderName(provider.name)) return false;
    if (budgetPollingPaused(provider)) return false;
    if (resolveProviderSyncMode(provider) !== "poll") return false;
    return providerPollSnapshotExpected(provider);
  });
  if (pollable.length === 0) return [];

  const ids = pollable.map((provider) => provider.id);
  const [latestSnapshots, staleBilling] = await Promise.all([
    prisma.usageSnapshot.groupBy({
      by: ["providerId"],
      where: { providerId: { in: ids } },
      _max: { fetchedAt: true },
    }),
    prisma.providerExternalBilling.findMany({
      where: {
        providerId: { in: ids },
        syncedAt: { lt: cutoff },
      },
      select: { providerId: true },
      distinct: ["providerId"],
    }),
  ]);

  const latestById = new Map(
    latestSnapshots.map((row) => [row.providerId, row._max.fetchedAt])
  );
  const staleBillingIds = new Set(staleBilling.map((row) => row.providerId));

  const due: string[] = [];
  for (const provider of pollable) {
    const latest = latestById.get(provider.id);
    const snapshotStale = !latest || latest.getTime() < cutoff.getTime();
    if (snapshotStale || staleBillingIds.has(provider.id)) {
      due.push(provider.id);
    }
    if (due.length >= cap) break;
  }
  return due;
}

export async function refreshStalePollableProviders(
  nowMs: number = Date.now()
): Promise<StaleRefreshResult> {
  const ids = await listStalePollableProviderIds(nowMs);
  if (ids.length === 0) {
    return {
      considered: 0,
      refreshed: 0,
      failed: 0,
      skipped: 0,
      providerIds: [],
    };
  }

  const { recordProviderUsage } = await import("@/lib/usage-recorder");
  const providers = await prisma.provider.findMany({
    where: { id: { in: ids } },
  });
  const byId = new Map(providers.map((provider) => [provider.id, provider]));

  let refreshed = 0;
  let failed = 0;
  let skipped = 0;
  for (const id of ids) {
    const provider = byId.get(id);
    if (!provider) {
      skipped += 1;
      continue;
    }
    try {
      await recordProviderUsage(provider);
      refreshed += 1;
    } catch {
      failed += 1;
    }
  }

  return {
    considered: ids.length,
    refreshed,
    failed,
    skipped,
    providerIds: ids,
  };
}

/** True when a pollable snapshot/billing confirmation is older than the hourly cap. */
export function isPollableRecordStale(
  fetchedAtMs: number | null,
  nowMs: number
): boolean {
  if (fetchedAtMs == null) return true;
  return nowMs - fetchedAtMs >= MAX_POLL_FRESHNESS_MS;
}
