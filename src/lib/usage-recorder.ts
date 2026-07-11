import { prisma } from "@/lib/prisma";
import { fetchProviderUsage } from "@/lib/adapters";
import { AdapterError, type AdapterErrorCode } from "@/lib/adapters/helpers";
import { runUsageMaintenance } from "@/lib/usage-maintenance";
import { ensureAgentSyncProviderSeeded } from "@/lib/ensure-agent-sync-provider";
import {
  markSchedulerStarted,
  markSchedulerTickCompleted,
  markSchedulerTickStarted,
} from "@/lib/runtime-health";
import { reconcileProviderExternalBilling } from "@/lib/provider-external-billing";
import { isManualProvider } from "@/lib/provider-polling";
import type { Provider, UsageSnapshot } from "@prisma/client";

const DEFAULT_PROVIDER_TIMEOUT_MS = 90_000;
const providerAttemptTokens = new Map<string, symbol>();

function assertProviderAttemptCurrent(
  providerId: string,
  token: symbol,
  signal?: AbortSignal
): void {
  if (signal?.aborted || providerAttemptTokens.get(providerId) !== token) {
    throw new AdapterError("Provider fetch was superseded before it could commit", {
      code: "SUPERSEDED",
      retryable: true,
    });
  }
}

function resolveProviderTimeoutMs(): number {
  const raw = process.env.ADAPTER_PROVIDER_TIMEOUT_MS;
  if (raw == null || raw.trim() === "") return DEFAULT_PROVIDER_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PROVIDER_TIMEOUT_MS;
  return parsed;
}

export async function recordProviderUsage(
  provider: Provider,
  signal?: AbortSignal
): Promise<UsageSnapshot> {
  const attemptToken = Symbol(provider.id);
  providerAttemptTokens.set(provider.id, attemptToken);
  try {
    const usage = await fetchProviderUsage(provider);
    assertProviderAttemptCurrent(provider.id, attemptToken, signal);

    return await prisma.$transaction(async (tx) => {
      const billingSyncs = [
        ...(usage.externalBilling ? [usage.externalBilling] : []),
        ...(usage.externalBillingSyncs ?? []),
      ];
      for (const sync of billingSyncs) {
        assertProviderAttemptCurrent(provider.id, attemptToken, signal);
        await reconcileProviderExternalBilling(provider.id, sync, tx);
      }

      assertProviderAttemptCurrent(provider.id, attemptToken, signal);
      const snapshot = await tx.usageSnapshot.create({
        data: {
          providerId: provider.id,
          fetchedAt: new Date(),
          balance: usage.balance,
          totalCost: usage.totalCost,
          fixedCostIncludedUsd: usage.fixedCostIncludedUsd,
          costWindowStart: usage.costWindowStart
            ? new Date(usage.costWindowStart)
            : null,
          costWindowEnd: usage.costWindowEnd
            ? new Date(usage.costWindowEnd)
            : null,
          costScope: usage.costScope,
          costIncludesUnknownFixed: usage.costIncludesUnknownFixed ?? false,
          totalRequests: usage.totalRequests,
          credits: usage.credits,
          rawData: usage.rawData ?? undefined,
        },
      });
      // A newer attempt may have started while SQLite was awaiting the INSERT.
      // Throwing here rolls the whole transaction back, including billing syncs.
      assertProviderAttemptCurrent(provider.id, attemptToken, signal);
      return snapshot;
    });
  } finally {
    if (providerAttemptTokens.get(provider.id) === attemptToken) {
      providerAttemptTokens.delete(provider.id);
    }
  }
}

// Guards fetchAllDueProviders against concurrent callers (scheduler tick vs a
// manual /api/cron/fetch-all trigger, or two overlapping manual triggers)
// both treating the same provider as "due" and firing duplicate fetches.
// This app runs as a single Node process against a local SQLite file, so a
// simple in-process mutex is sufficient - there is no multi-instance/
// multi-process deployment for this service to coordinate across.
export interface ProviderFetchError {
  providerId: string;
  name: string;
  error: string;
  code: AdapterErrorCode | "UNKNOWN";
  status: number | null;
  retryable: boolean;
}

export interface ProviderFetchOutcome {
  providerId: string;
  name: string;
  status: "success" | "failure" | "skipped";
  durationMs: number;
  errorCode?: AdapterErrorCode | "UNKNOWN";
  skipReason?: "manual_provider" | "not_due";
}

export interface FetchAllProvidersResult {
  total: number;
  successes: number;
  failures: number;
  skipped: number;
  errors: ProviderFetchError[];
  outcomes: ProviderFetchOutcome[];
}

let fetchAllInFlight: Promise<FetchAllProvidersResult> | null = null;

export async function fetchAllDueProviders(): Promise<FetchAllProvidersResult> {
  // If a run is already in progress, wait for it and return its result
  // instead of starting a second, overlapping pass over the same providers.
  if (fetchAllInFlight) {
    return fetchAllInFlight;
  }

  const run = (async () => {
    await ensureAgentSyncProviderSeeded();
    const providers = await prisma.provider.findMany({
      where: { isActive: true },
      include: {
        snapshots: {
          orderBy: { fetchedAt: "desc" },
          take: 1,
          select: { fetchedAt: true },
        },
      },
    });

    let successes = 0;
    let failures = 0;
    let skipped = 0;
    const errors: ProviderFetchError[] = [];
    const outcomes: ProviderFetchOutcome[] = [];
    const now = Date.now();
    const providerTimeoutMs = resolveProviderTimeoutMs();

    for (const { snapshots, ...provider } of providers) {
      const startedAt = Date.now();
      if (isManualProvider(provider)) {
        skipped++;
        outcomes.push({
          providerId: provider.id,
          name: provider.name,
          status: "skipped",
          durationMs: Date.now() - startedAt,
          skipReason: "manual_provider",
        });
        continue;
      }
      const latestFetchedAt = snapshots[0]?.fetchedAt.getTime();
      const intervalMs = provider.refreshIntervalMin * 60 * 1000;
      if (latestFetchedAt && now - latestFetchedAt < intervalMs) {
        skipped++;
        outcomes.push({
          providerId: provider.id,
          name: provider.name,
          status: "skipped",
          durationMs: Date.now() - startedAt,
          skipReason: "not_due",
        });
        continue;
      }

      try {
        // Outer per-provider time budget: a single pathological adapter
        // (hung DNS, a fetchJson call whose own timeout got bypassed via a
        // caller-supplied signal, etc.) must not stall the rest of the
        // sequential loop. If the budget is exhausted we record it as a
        // failure and move on. The adapter request may still finish in the
        // background, but the abort/generation guard prevents it from writing
        // stale snapshot or billing state after the timeout.
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const attemptController = new AbortController();
        try {
          await Promise.race([
            recordProviderUsage(provider, attemptController.signal),
            new Promise<never>((_, reject) => {
              timeoutHandle = setTimeout(
                () => {
                  attemptController.abort();
                  reject(
                    new AdapterError(
                      `Provider ${provider.name} timed out after ${providerTimeoutMs}ms`,
                      { code: "TIMEOUT", retryable: true }
                    )
                  );
                },
                providerTimeoutMs
              );
              // Don't let a still-pending timeout keep the event loop (and the
              // Node process) alive on its own in one-shot/test contexts.
              timeoutHandle.unref?.();
            }),
          ]);
        } finally {
          // Always clear the timer - whether the provider succeeded, threw, or
          // the timeout won the race - so a winning provider doesn't leave a
          // stray timer lingering for up to the full budget every poll pass.
          if (timeoutHandle) clearTimeout(timeoutHandle);
        }
        successes++;
        outcomes.push({
          providerId: provider.id,
          name: provider.name,
          status: "success",
          durationMs: Date.now() - startedAt,
        });
      } catch (error) {
        failures++;
        const typed = error instanceof AdapterError ? error : null;
        errors.push({
          providerId: provider.id,
          name: provider.name,
          error: error instanceof Error ? error.message : "Failed to fetch",
          code: typed?.code ?? "UNKNOWN",
          status: typed?.status ?? null,
          retryable: typed?.retryable ?? false,
        });
        outcomes.push({
          providerId: provider.id,
          name: provider.name,
          status: "failure",
          durationMs: Date.now() - startedAt,
          errorCode: typed?.code ?? "UNKNOWN",
        });
      }
    }

    return {
      total: providers.length,
      successes,
      failures,
      skipped,
      errors,
      outcomes,
    };
  })();

  fetchAllInFlight = run;
  try {
    return await run;
  } finally {
    // Only clear the in-flight marker if it's still our own run - avoids a
    // pathological case where a later run somehow got assigned first.
    if (fetchAllInFlight === run) {
      fetchAllInFlight = null;
    }
  }
}

const POLL_INTERVAL_MS = 15 * 60 * 1000; // matches the old external cron's */15 schedule exactly - don't change the cadence, only where it runs
let schedulerStarted = false;

export function startUsagePollingScheduler(): void {
  if (schedulerStarted) return; // instrumentation.register() can fire more than once in some Next.js scenarios - guard against double-scheduling
  schedulerStarted = true;
  markSchedulerStarted();
  const tick = async () => {
    markSchedulerTickStarted();
    try {
      const result = await fetchAllDueProviders();
      await runUsageMaintenance();
      markSchedulerTickCompleted(true, {
        total: result.total,
        successes: result.successes,
        failures: result.failures,
        skipped: result.skipped,
      });
    } catch (error) {
      markSchedulerTickCompleted(false, null);
      console.error("[usage-scheduler] tick failed", error);
    }
  };
  setInterval(tick, POLL_INTERVAL_MS);
  void tick(); // also run once immediately on boot, don't wait a full interval
}
