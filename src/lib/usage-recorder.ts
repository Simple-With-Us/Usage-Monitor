import { adapterHttpAbortStorage } from "@/lib/adapters/helpers";
import { appSettings } from "@/lib/app-settings";
import { prisma } from "@/lib/prisma";
import { fetchProviderUsage } from "@/lib/adapters";
import { AdapterError, type AdapterErrorCode } from "@/lib/adapters/helpers";
import {
  isUsageMaintenanceHealthy,
  runUsageMaintenance,
} from "@/lib/usage-maintenance";
import { ensureAgentSyncProviderSeeded } from "@/lib/ensure-agent-sync-provider";
import { ensureCloudflareFleetProvidersSeeded } from "@/lib/ensure-cloudflare-fleet-providers";
import { ensureRoicProviderSeeded } from "@/lib/ensure-roic-provider";
import { ensureFleetProjectsSeeded } from "@/lib/ensure-fleet-projects";
import {
  effectivePollDueIntervalMs,
  resolveProviderSyncMode,
} from "@/lib/provider-sync-mode";
import { listStalePollableProviderIds } from "@/lib/refresh-stale-providers";
import { providerPollSnapshotExpected } from "@/lib/anthropic-credentials";
import {
  bootstrapStGeminiCredentialToInfisical,
  syncProviderCredentialsFromInfisical,
  type InfisicalCredentialSyncResult,
  type StGeminiInfisicalBootstrapResult,
} from "@/lib/infisical-provider-sync";
import {
  markSchedulerStarted,
  markSchedulerTickCompleted,
  markSchedulerTickStarted,
} from "@/lib/runtime-health";
import { reconcileProviderExternalBilling } from "@/lib/provider-external-billing";
import { Prisma, type Provider, type UsageSnapshot } from "@prisma/client";
import {
  isRetryablePartialSnapshot,
  withCostCoverageCaveat,
  withSnapshotSyncFailure,
} from "@/lib/snapshot-sync-status";
import { withInternalUsageWriteAdmission } from "@/lib/ingest-admission";
import { redactProviderRawData } from "@/lib/data-privacy";
import { budgetPollingPaused } from "@/lib/budget-controls";
import { isDecommissionedProviderName } from "@/lib/provider-definitions";
import {
  logSchedulerDegraded,
  logSchedulerOutcome,
  recordSentryCronHeartbeat,
  recordSchedulerDuration,
} from "@/lib/sentry-ops";
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
  const raw = appSettings.get("ADAPTER_PROVIDER_TIMEOUT_MS");
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
    const usage = signal
      ? await adapterHttpAbortStorage.run(signal, () => fetchProviderUsage(provider))
      : await fetchProviderUsage(provider);
    assertProviderAttemptCurrent(provider.id, attemptToken, signal);

    const snapshot = await withInternalUsageWriteAdmission(async () => {
      assertProviderAttemptCurrent(provider.id, attemptToken, signal);
      return prisma.$transaction(async (tx) => {
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
            rawData:
              withCostCoverageCaveat(
                withSnapshotSyncFailure(
                  redactProviderRawData(provider.type, provider.name, usage.rawData),
                  usage.postPersistError
                ),
                usage.costCoverageCaveat
              ) ?? undefined,
          },
        });
        // A newer attempt may have started while SQLite was awaiting the INSERT.
        // Throwing here rolls the whole transaction back, including billing syncs.
        assertProviderAttemptCurrent(provider.id, attemptToken, signal);
        return snapshot;
      });
    });
    if (usage.postPersistError) throw usage.postPersistError;
    return snapshot;
  } finally {
    if (providerAttemptTokens.get(provider.id) === attemptToken) {
      providerAttemptTokens.delete(provider.id);
    }
  }
}

// Process-local failure backoff after poll errors (15m → 30m → … cap 2h).
// Prevents a permanently 429/5xx provider from being re-hit every tick.
const providerPollFailureBackoff = new Map<
  string,
  { failures: number; nextAttemptAtMs: number }
>();
const POLL_FAILURE_BACKOFF_CAP_MS = 2 * 60 * 60 * 1000;

function noteProviderPollFailure(providerId: string, nowMs: number): void {
  const prev = providerPollFailureBackoff.get(providerId);
  const failures = (prev?.failures ?? 0) + 1;
  const delayMs = Math.min(
    POLL_FAILURE_BACKOFF_CAP_MS,
    15 * 60 * 1000 * 2 ** Math.min(failures - 1, 4)
  );
  providerPollFailureBackoff.set(providerId, {
    failures,
    nextAttemptAtMs: nowMs + delayMs,
  });
}

function clearProviderPollFailure(providerId: string): void {
  providerPollFailureBackoff.delete(providerId);
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
  // E5: why a skip happened, when the reason matters operationally. Only set
  // for total-tick-budget skips today (other skips are interval/backoff/pause
  // gates whose meaning is already implied by cadence).
  skipReason?: "tick_budget" | "manual_no_poll";
}

export interface FetchAllProvidersResult {
  total: number;
  successes: number;
  failures: number;
  skipped: number;
  errors: ProviderFetchError[];
  outcomes: ProviderFetchOutcome[];
  // E5: true when the total-tick time budget stopped new provider fetches
  // before the poll set was exhausted. Surfaced through the existing
  // providerFetchDegraded scheduler signal in runUsagePollingSchedulerTick.
  tickBudgetExceeded: boolean;
  // Safe status/code only. The one-time bootstrap never returns credential
  // material or an upstream response body.
  credentialBootstrap?: StGeminiInfisicalBootstrapResult;
  // Safe counts/status codes only; no Infisical names, tokens, or values.
  credentialSync?: InfisicalCredentialSyncResult;
}

// A scheduler tick's provider-fetch phase is a distinct health signal from
// per-provider budget/balance alerts: it answers "is polling itself working"
// (credential rotation, egress/DNS breakage, an adapter regression) rather
// than "did a provider's usage cross a threshold". Skipped providers are
// interval-gated and were never attempted, so they are excluded from the
// ratio below - only providers this tick actually tried to poll count.
const DEFAULT_PROVIDER_FETCH_DEGRADED_FAILURE_RATIO = 0.5;

function resolveProviderFetchDegradedFailureRatio(): number {
  const raw = process.env.PROVIDER_FETCH_DEGRADED_FAILURE_RATIO;
  if (raw == null || raw.trim() === "") {
    return DEFAULT_PROVIDER_FETCH_DEGRADED_FAILURE_RATIO;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    return DEFAULT_PROVIDER_FETCH_DEGRADED_FAILURE_RATIO;
  }
  return parsed;
}

export function isProviderFetchTickDegraded(
  result: Pick<FetchAllProvidersResult, "successes" | "failures">
): boolean {
  const attempted = result.successes + result.failures;
  if (attempted === 0) return false; // nothing attempted (all skipped) - no signal either way
  // Total-outage fast path: everything attempted failed. Kept as an explicit
  // check (not just relying on the ratio below) so a complete outage is
  // always caught even if PROVIDER_FETCH_DEGRADED_FAILURE_RATIO is ever
  // misconfigured above its intended 0-1 range.
  if (result.successes === 0 && result.failures > 0) return true;
  return result.failures / attempted >= resolveProviderFetchDegradedFailureRatio();
}

// E5: total-tick time budget for the provider-fetch phase. Worst case the
// sequential loop used to be ~39 providers x the 90s per-provider timeout,
// far past the 15-minute cadence, so one slow-tick pileup could starve
// maintenance and the next tick. Past this budget the loop stops STARTING
// new provider fetches; remaining providers are marked skipped
// (skipReason "tick_budget") and the tick is flagged providerFetchDegraded.
const DEFAULT_PROVIDER_FETCH_TICK_BUDGET_MS = 10 * 60 * 1000;

function resolveProviderFetchTickBudgetMs(): number {
  const raw = process.env.PROVIDER_FETCH_TICK_BUDGET_MS;
  if (raw == null || raw.trim() === "") return DEFAULT_PROVIDER_FETCH_TICK_BUDGET_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PROVIDER_FETCH_TICK_BUDGET_MS;
  return parsed;
}

interface LatestPollSnapshotMarker {
  fetchedAt: Date;
  retryable: boolean;
}

/**
 * E4: per-provider latest poll snapshot (fetchedAt + retryable-partial
 * marker) WITHOUT selecting rawData blobs. Re-selecting every provider's
 * rawData (a full adapter raw-API-response payload) every 15 minutes was the
 * pattern removed elsewhere after the #392 OOM. The only consumer is the
 * retry gate below, so this pulls just the tiny __apiUsageMonitor
 * partialFailure sub-object via SQLite json_extract - the same pattern as
 * api/providers/route.ts's batchSnapshotCostCoverageCaveats.
 *
 * "Latest poll snapshot" means the latest snapshot with a non-null rawData
 * (pushed quota/credit events intentionally write rawData-less rows). That
 * is exactly what the old two-step logic resolved to: snapshots[0] when it
 * had rawData is trivially the latest non-null-rawData row, and the fallback
 * findFirst asked for the same thing when it didn't.
 */
async function loadLatestPollSnapshotMarkers(
  providerIds: string[]
): Promise<Map<string, LatestPollSnapshotMarker>> {
  const result = new Map<string, LatestPollSnapshotMarker>();
  if (providerIds.length === 0) return result;

  const latestByProvider = await prisma.usageSnapshot.groupBy({
    by: ["providerId"],
    where: {
      providerId: { in: providerIds },
      rawData: { not: Prisma.DbNull },
    },
    _max: { fetchedAt: true },
  });
  const pairs = latestByProvider.filter(
    (row): row is typeof row & { _max: { fetchedAt: Date } } =>
      row._max.fetchedAt != null
  );
  if (pairs.length === 0) return result;

  // Resolve (providerId, maxFetchedAt) pairs to concrete snapshot ids. Rows
  // carry only scalars - never the rawData blob. A fetchedAt tie can return
  // more than one row per provider; keep the first, matching the old
  // orderBy(fetchedAt desc), take-1 semantics' arbitrary tie-break.
  const rows = await prisma.usageSnapshot.findMany({
    where: {
      OR: pairs.map((row) => ({
        providerId: row.providerId,
        fetchedAt: row._max.fetchedAt,
      })),
    },
    select: { id: true, providerId: true, fetchedAt: true },
  });
  const rowByProviderId = new Map<string, { id: string; fetchedAt: Date }>();
  for (const row of rows) {
    if (!rowByProviderId.has(row.providerId)) {
      rowByProviderId.set(row.providerId, row);
    }
  }
  if (rowByProviderId.size === 0) return result;

  const markers = await prisma.$queryRaw<
    Array<{
      id: string;
      version: unknown;
      code: unknown;
      status: unknown;
      retryable: unknown;
    }>
  >(Prisma.sql`
    SELECT
      "id" AS "id",
      json_extract("rawData", '$.__apiUsageMonitor.version') AS "version",
      json_extract("rawData", '$.__apiUsageMonitor.partialFailure.code') AS "code",
      json_extract("rawData", '$.__apiUsageMonitor.partialFailure.status') AS "status",
      json_extract("rawData", '$.__apiUsageMonitor.partialFailure.retryable') AS "retryable"
    FROM "UsageSnapshot"
    WHERE "id" IN (${Prisma.join(
      Array.from(rowByProviderId.values(), (row) => row.id)
    )})
  `);
  const markerBySnapshotId = new Map(markers.map((marker) => [marker.id, marker]));

  for (const [providerId, row] of rowByProviderId) {
    const marker = markerBySnapshotId.get(row.id);
    // json_extract surfaces JSON integers/booleans as SQL values that Prisma
    // returns as BigInt; coerce them back, rebuild the tiny metadata bag, and
    // run it through the SAME validator the rawData path used
    // (snapshot-sync-status.ts) so malformed markers fail closed identically.
    const hasPartialFailure =
      marker != null &&
      (marker.code != null || marker.status != null || marker.retryable != null);
    const syntheticRawData = {
      __apiUsageMonitor: {
        version: marker?.version == null ? null : Number(marker.version),
        ...(hasPartialFailure
          ? {
              partialFailure: {
                code: marker.code ?? undefined,
                status: marker.status == null ? null : Number(marker.status),
                retryable:
                  marker.retryable == null
                    ? undefined
                    : Number(marker.retryable) === 1,
              },
            }
          : {}),
      },
    };
    result.set(providerId, {
      fetchedAt: row.fetchedAt,
      retryable: isRetryablePartialSnapshot(syntheticRawData),
    });
  }
  return result;
}

let fetchAllInFlight: Promise<FetchAllProvidersResult> | null = null;

export async function fetchAllDueProviders(): Promise<FetchAllProvidersResult> {
  // If a run is already in progress, wait for it and return its result
  // instead of starting a second, overlapping pass over the same providers.
  if (fetchAllInFlight) {
    return fetchAllInFlight;
  }

  const run = (async () => {
    await withInternalUsageWriteAdmission(() => ensureAgentSyncProviderSeeded());
    await withInternalUsageWriteAdmission(() => ensureRoicProviderSeeded());
    await withInternalUsageWriteAdmission(() =>
      ensureCloudflareFleetProvidersSeeded()
    );
    try {
      await withInternalUsageWriteAdmission(() => ensureFleetProjectsSeeded());
    } catch {
      // Poll tests mock a provider-only Prisma surface. Missing Project
      // must not block usage snapshots.
    }
    // The default-off, exact ST Gemini bootstrap must run before the normal
    // one-way Infisical pull so a successful create can be adopted and bound
    // in this same provider-maintenance pass.
    const credentialBootstrap =
      await bootstrapStGeminiCredentialToInfisical();
    const suppressStGeminiPull =
      credentialBootstrap.enabled &&
      credentialBootstrap.status !== "created" &&
      credentialBootstrap.status !== "already_present_same";
    let credentialSync: InfisicalCredentialSyncResult;
    try {
      // Network reads happen before the sync helper takes the internal SQLite
      // writer lease, so Infisical latency never blocks usage ingest. Any
      // failure keeps encrypted last-known-good credentials in place.
      credentialSync = await syncProviderCredentialsFromInfisical({
        suppressStGemini: suppressStGeminiPull,
      });
      if (credentialSync.failed > 0) {
        console.warn(
          `[infisical-provider-sync] retained last-known-good credentials for ${credentialSync.failed} failed mapping(s)`
        );
      }
    } catch {
      console.error(
        "[infisical-provider-sync] unexpected failure; retained existing provider credentials"
      );
      credentialSync = {
        enabled: true,
        configured: true,
        sources: [],
        created: 0,
        updated: 0,
        unchanged: 0,
        missing: 0,
        failed: 1,
      };
    }
    const storedProviders = await prisma.provider.findMany({
      where: { isActive: true },
      // E4: the snapshots include (latest row's rawData blob per provider) is
      // gone - the retry marker it fed is loaded below via
      // loadLatestPollSnapshotMarkers, which never touches rawData.
    });

    // A startup failure or a row created by an older client must not turn a
    // retired service into a provider call. Startup normally deactivates
    // these rows; this filter is the fail-closed boundary.
    const providers = storedProviders.filter(
      (provider) => !isDecommissionedProviderName(provider.name)
    );

    const latestPollByProviderId = await loadLatestPollSnapshotMarkers(
      providers.map((provider) => provider.id)
    );

    let successes = 0;
    let failures = 0;
    let skipped = 0;
    const errors: ProviderFetchError[] = [];
    const outcomes: ProviderFetchOutcome[] = [];
    const now = Date.now();
    let staleDueIds = new Set<string>();
    try {
      staleDueIds = new Set(await listStalePollableProviderIds(now, 50));
    } catch {
      staleDueIds = new Set();
    }
    const providerTimeoutMs = resolveProviderTimeoutMs();
    const tickStartedAtMs = now;
    const tickBudgetMs = resolveProviderFetchTickBudgetMs();
    let tickBudgetExceeded = false;

    for (const provider of providers) {
      const startedAt = Date.now();
      // Budget-breach control: a provider paused by the (default-off) automated
      // control layer is cleanly skipped here, exactly like an interval-gated
      // skip, so no further usage is incurred/observed. With
      // BUDGET_AUTO_CONTROLS_ENABLED unset this is always false and the poll set
      // is byte-identical to the notify-only path.
      if (budgetPollingPaused(provider)) {
        skipped++;
        outcomes.push({
          providerId: provider.id,
          name: provider.name,
          status: "skipped",
          durationMs: Date.now() - startedAt,
        });
        continue;
      }
      // Never-pollable (voyage, ROIC, push/generic, …): skip quietly. They are
      // Manually only — not "stale" and not missing a snapshot we can fetch.
      const syncMode = resolveProviderSyncMode(provider);
      const snapshotExpected = providerPollSnapshotExpected(provider);
      if (syncMode === "manual" || !snapshotExpected) {
        skipped++;
        outcomes.push({
          providerId: provider.id,
          name: provider.name,
          status: "skipped",
          durationMs: Date.now() - startedAt,
          skipReason: "manual_no_poll",
        });
        continue;
      }
      // Cap due interval at 60m so pollable providers refresh at least hourly
      // (scheduler ticks every 15m; configured interval still wins when shorter).
      const intervalMs = effectivePollDueIntervalMs(provider.refreshIntervalMin);
      // Pushed quota/credit events intentionally create rawData-less
      // snapshots. They may be newer than the last poll snapshot, but must not
      // hide its retry marker or make an old/missing poll look fresh. The
      // marker here comes from the json_extract batch above (E4), not from a
      // re-selected rawData blob.
      const latestPoll = latestPollByProviderId.get(provider.id);
      const latestPollFetchedAt = latestPoll?.fetchedAt.getTime();
      const forceDueForStale = staleDueIds.has(provider.id);
      if (
        latestPollFetchedAt &&
        !latestPoll?.retryable &&
        !forceDueForStale &&
        now - latestPollFetchedAt < intervalMs
      ) {
        skipped++;
        outcomes.push({
          providerId: provider.id,
          name: provider.name,
          status: "skipped",
          durationMs: Date.now() - startedAt,
        });
        continue;
      }

      // Cross-tick failure backoff (Wave C): after consecutive poll failures,
      // skip until exponential backoff elapses (cap 2h). Success clears state.
      const failureState = providerPollFailureBackoff.get(provider.id);
      if (
        failureState &&
        now < failureState.nextAttemptAtMs
      ) {
        skipped++;
        outcomes.push({
          providerId: provider.id,
          name: provider.name,
          status: "skipped",
          durationMs: Date.now() - startedAt,
        });
        continue;
      }

      // E5: total-tick budget. Stop STARTING new provider fetches once the
      // tick has consumed its budget; remaining providers are marked as
      // budget-skipped (they stay "due" and are picked up on the next tick).
      if (Date.now() - tickStartedAtMs >= tickBudgetMs) {
        tickBudgetExceeded = true;
        skipped++;
        outcomes.push({
          providerId: provider.id,
          name: provider.name,
          status: "skipped",
          durationMs: Date.now() - startedAt,
          skipReason: "tick_budget",
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
        clearProviderPollFailure(provider.id);
        outcomes.push({
          providerId: provider.id,
          name: provider.name,
          status: "success",
          durationMs: Date.now() - startedAt,
        });
      } catch (error) {
        const typed = error instanceof AdapterError ? error : null;
        // Push/manual-only adapters intentionally report UNSUPPORTED because
        // there is no safe provider API to poll. That is a capability state,
        // not a failed scheduler operation; counting it as a failure makes a
        // healthy tick look broken even though no provider request was made.
        if (typed?.code === "UNSUPPORTED") {
          skipped++;
          clearProviderPollFailure(provider.id);
          outcomes.push({
            providerId: provider.id,
            name: provider.name,
            status: "skipped",
            durationMs: Date.now() - startedAt,
            errorCode: typed.code,
          });
          continue;
        }

        failures++;
        noteProviderPollFailure(provider.id, Date.now());
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
      tickBudgetExceeded,
      credentialBootstrap,
      credentialSync,
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

export const POLL_INTERVAL_MS = 15 * 60 * 1000; // matches the old external cron's */15 schedule exactly - don't change the cadence, only where it runs. Sentry cron monitor config in sentry-ops.ts must stay in lockstep.
let schedulerStarted = false;

// The first tick does real work immediately (provider polling + retention
// pruning/rollups + subscription/alert maintenance - see runUsageMaintenance)
// and previously fired synchronously from register(), racing the boot-time
// pre-migration backup, an optional concurrent Litestream replicate process,
// and Next.js's own first-request compilation for native (non-heap) memory
// on a 512MB container. Delaying it lets the HTTP server finish starting and
// that boot-time I/O settle before the heaviest in-process pass begins.
// Recurring ticks are unaffected - only this first one is delayed, and never
// beyond the regular cadence.
const DEFAULT_SCHEDULER_BOOT_DELAY_MS = 30_000;

export function resolveSchedulerBootDelayMs(): number {
  const raw = process.env.USAGE_SCHEDULER_BOOT_DELAY_MS;
  if (raw == null || raw.trim() === "") return DEFAULT_SCHEDULER_BOOT_DELAY_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_SCHEDULER_BOOT_DELAY_MS;
  return Math.min(parsed, POLL_INTERVAL_MS);
}

export interface UsagePollingSchedulerTickDependencies {
  fetchProviders?: typeof fetchAllDueProviders;
  runMaintenance?: typeof runUsageMaintenance;
  markTickStarted?: typeof markSchedulerTickStarted;
  markTickCompleted?: typeof markSchedulerTickCompleted;
}

export async function runUsagePollingSchedulerTick(
  dependencies: UsagePollingSchedulerTickDependencies = {}
): Promise<void> {
  const markTickStarted = dependencies.markTickStarted ?? markSchedulerTickStarted;
  const markTickCompleted = dependencies.markTickCompleted ?? markSchedulerTickCompleted;
  markTickStarted();
  const tickStartedAt = Date.now();
  try {
    const result = await (dependencies.fetchProviders ?? fetchAllDueProviders)();
    const maintenance = await (dependencies.runMaintenance ?? runUsageMaintenance)();
    const tickDurationMs = Date.now() - tickStartedAt;
    const maintenanceHealthy = isUsageMaintenanceHealthy(maintenance);
    // Deliberately NOT folded into `succeeded` (maintenanceHealthy) below: a
    // provider-fetch outage is upstream (third-party credentials/network/API),
    // not this app failing. Folding it in would flip lastTickSucceeded/
    // consecutiveFailures and could eventually flip /api/ready's `ok` to
    // false for a problem this service isn't causing and can't fix by
    // restarting. It is tracked as its own consecutive-tick streak in
    // runtime-health so a single flaky provider can't flap readiness, and
    // surfaced as a distinct scheduler.providerFetchDegraded signal instead.
    const providerFetchDegraded =
      isProviderFetchTickDegraded(result) || result.tickBudgetExceeded === true;
    markTickCompleted(maintenanceHealthy, {
      total: result.total,
      successes: result.successes,
      failures: result.failures,
      skipped: result.skipped,
      maintenanceHealthy,
      providerFetchDegraded,
      cloudflareLegacyHandoff:
        maintenance.subscriptionAdoption.cloudflareLegacyHandoff,
    });
    void recordSentryCronHeartbeat("ok");
    void logSchedulerOutcome("ok", {
      total: result.total,
      successes: result.successes,
      failures: result.failures,
      skipped: result.skipped,
      providerFetchDegraded,
    });
    void recordSchedulerDuration(tickDurationMs, {
      outcome: "ok",
      total: result.total,
      providerFetchDegraded,
    });
    if (providerFetchDegraded) {
      // Sentry log only — never exposed on unauthenticated /api/ready.
      const failingNames = result.errors
        .slice(0, 5)
        .map((entry) => `${entry.name}:${entry.code}`)
        .join(",");
      void logSchedulerDegraded({
        total: result.total,
        successes: result.successes,
        failures: result.failures,
        skipped: result.skipped,
        tickBudgetExceeded: result.tickBudgetExceeded === true,
        failingProviders: failingNames || undefined,
      });
    }
  } catch (error) {
    const tickDurationMs = Date.now() - tickStartedAt;
    markTickCompleted(false, null);
    void recordSentryCronHeartbeat("error");
    void logSchedulerOutcome("error", {
      reason: error instanceof Error ? error.name : "unknown",
    });
    void recordSchedulerDuration(tickDurationMs, {
      outcome: "error",
      reason: error instanceof Error ? error.name : "unknown",
    });
    console.error("[usage-scheduler] tick failed", error);
  }
}

export function startUsagePollingScheduler(
  tick: () => Promise<void> = runUsagePollingSchedulerTick
): void {
  if (schedulerStarted) return; // instrumentation.register() can fire more than once in some Next.js scenarios - guard against double-scheduling
  schedulerStarted = true;
  markSchedulerStarted();
  setInterval(() => void tick(), POLL_INTERVAL_MS);
  // First tick still runs well before the next regular interval, just not
  // synchronously at boot - see DEFAULT_SCHEDULER_BOOT_DELAY_MS above.
  const bootDelayMs = resolveSchedulerBootDelayMs();
  const bootTimer = setTimeout(() => void tick(), bootDelayMs);
  // Don't let a still-pending boot-delay timer keep a one-shot/test process
  // alive on its own - mirrors the existing per-provider timeout's unref().
  bootTimer.unref?.();
}
