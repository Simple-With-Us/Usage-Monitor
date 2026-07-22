import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { clearMtdScanMemo } from "@/lib/mtd-scan-memo";
import {
  classifyCostCoverage,
  sumMonthToDateExternalCostByProvider,
  sumMonthToDateExternalCostAttribution,
  sumMonthToDateReceiptCashByProviderId,
  type CostCoverage,
  type ProviderPushedCost,
} from "@/lib/external-usage-events";
import {
  canonicalProviderKey,
  canonicalProjectKey,
  resolveProviderIdentity,
} from "@/lib/provider-identity";
import { buildCanonicalProjectIdMap } from "@/lib/project-resolver";
import { buildProviderAlertState, type ProviderAlert } from "@/lib/provider-alerts";
import { getExternalEventRawCutoff } from "@/lib/data-retention";
import { calculateEomForecast } from "@/lib/forecasting";
import { resolveAnomalyConfig, type AnomalyResult } from "@/lib/anomaly-detection";
import { loadSpendAnomaliesByProviderId } from "@/lib/anomaly-loader";
import { advancePeriod, isSubscriptionInterval } from "@/lib/subscriptions";
import {
  canLinkSubscriptionToExternalBilling,
  externalBillingFreshnessWindowMs,
  isExternalBillingLinkCandidate,
  resolveExternalBillingPeriod,
} from "@/lib/external-billing-link";
import { deriveGeminiBillingStatus } from "@/lib/gemini-key-status";
import { providerConfigForServer } from "@/lib/provider-secret-config";
import { subscriptionChargeIdempotencyKey } from "@/lib/subscription-charge-identity";
import { isLegacyMistralSpendLimitCostSnapshot } from "@/lib/mistral-snapshot-quarantine";
// Type-only import — erased at compile time, so it introduces NO runtime import
// cycle with budget-controls.ts (which imports computeBudgetStatus from here).
import type { BudgetBreachState } from "@/lib/budget-controls";

// Budget-status computation for the read endpoint (GET /api/budget-status).
//
// Consuming apps (e.g. Socratic Trade's cost-aware feedback loop) poll this to decide whether to
// throttle spend. Spend is combined across BOTH channels the monitor tracks:
//   - poll snapshots  (UsageSnapshot.totalCost — cumulative cost the poll adapter reported)
//   - pushed telemetry (ExternalUsageEvent.costUsd — month-to-date, the ONLY signal for providers
//     the poll adapters are blind to: Anthropic, Voyage, Robinhood)
// Exact Claude Code OTLP rows are analytics-only API-equivalent estimates and
// are excluded before this cash-spend calculation.
// To avoid double-counting a provider that reports through both channels, per-provider spend uses
// max(snapshotCost, pushedMonthToDate) + fixedMonthlyCost — matching the existing alert convention
// in provider-alerts.ts (which treats fixedMonthlyCost + snapshot.totalCost as the monthly figure).

const WARNING_RATIO = 0.8;

// Local, dependency-free reader of the budget-controls master flag. Inlined
// (rather than imported from budget-controls.ts) purely to avoid any runtime
// import cycle on this money-path module; it must stay in sync with
// budgetAutoControlsEnabled() in budget-controls.ts (asserted by a test).
function budgetAutoControlsEnabledForStatus(): boolean {
  const raw = process.env.BUDGET_AUTO_CONTROLS_ENABLED?.trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

function normalizeBudgetBreachState(value: string): BudgetBreachState {
  return value === "breached" || value === "paused" ? value : "ok";
}

export type BudgetStatusLevel = "ok" | "warning" | "exceeded" | "unconfigured";

export interface ProviderBudgetStatus {
  id: string;
  name: string;
  displayName: string;
  monthlyBudgetUsd: number | null;
  fixedMonthlyCostUsd: number;
  snapshotCostUsd: number | null;
  snapshotCostFetchedAt: string | null;
  snapshotCostWindowStart: string | null;
  snapshotCostWindowEnd: string | null;
  snapshotCostScope: string | null;
  snapshotFixedCostIncludedUsd: number;
  snapshotCostIncludesUnknownFixed: boolean;
  pushedMonthToDateUsd: number;
  /** Exact provider-receipt cash paid this UTC month. */
  receiptCashPaidUsd: number;
  receiptCashEventCount: number;
  /** Provider snapshot/pushed variable cost before receipt max-reconciliation. */
  observedVariableUsageUsd: number;
  /** Claude Code's analytics-only API-equivalent estimate; never cash spend. */
  estimatedApiEquivalentUsd: number;
  pushedCostCoverage: CostCoverage;
  pushedPricedEventCount: number;
  pushedUnpricedEventCount: number;
  pushedUnclassifiedCostEventCount: number;
  spendCoverage: CostCoverage;
  subscriptionMonthToDateUsd: number;
  fixedAccruedUsd: number;
  linkedFixedDedupeUsd: number;
  fixedCostConflict: boolean;
  forecastedSubscriptionRenewalsUsd: number;
  spentUsd: number;
  projectedEomUsd: number;
  remainingUsd: number | null;
  percentUsed: number | null;
  /** MTD spend vs budget (lagging). */
  status: BudgetStatusLevel;
  /**
   * Runway status using projectedEomUsd — throttle consumers should prefer this
   * over `status` so early-month burn that would breach EOM is visible.
   */
  projectedStatus: BudgetStatusLevel;
  alerts: ProviderAlert[];
  // Budget-breach automated-control observability (default-off). These reflect
  // the durable state written by src/lib/budget-controls.ts. keyDisableRecommended
  // is advisory only and never reflects a credential mutation.
  budgetControls: {
    enabled: boolean;
    breachState: BudgetBreachState;
    pausedAt: string | null;
    pauseReason: string | null;
    pauseThresholdUsd: number | null;
    pauseObservedSpendUsd: number | null;
    keyDisableRecommended: boolean;
  };
}

export interface BudgetStatusResponse {
  ok: true;
  generatedAt: string;
  month: string; // YYYY-MM (UTC)
  providers: ProviderBudgetStatus[];
  summary: {
    totalBudgetUsd: number;
    budgetedSpentUsd: number;
    unbudgetedSpentUsd: number;
    totalSpentUsd: number;
    estimatedApiEquivalentUsd: number;
    remainingUsd: number;
    percentUsed: number | null;
    overBudget: boolean;
    warning: boolean;
  };
}

function monthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function serverConfig(
  config: unknown,
  encryptedSecretConfig: string | null
): Record<string, unknown> | null {
  try {
    return providerConfigForServer(config, encryptedSecretConfig);
  } catch {
    return null;
  }
}

function monthLabel(now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function forecastSubscriptionRenewals(
  subscriptions: Array<{
    costUsd: number;
    currency: string;
    interval: string;
    intervalCount: number;
    nextRenewalAt: Date;
    autoRenew: boolean;
  }>,
  now: Date
): number {
  const monthEnd = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)
  );
  let total = 0;
  for (const subscription of subscriptions) {
    if (
      !subscription.autoRenew ||
      subscription.currency.toUpperCase() !== "USD" ||
      !isSubscriptionInterval(subscription.interval)
    ) {
      continue;
    }
    let renewal = subscription.nextRenewalAt;
    let guard = 0;
    while (renewal < monthEnd && guard < 240) {
      if (renewal > now) total += subscription.costUsd;
      renewal = advancePeriod(
        renewal,
        subscription.interval,
        Math.max(1, Math.trunc(subscription.intervalCount))
      );
      guard += 1;
    }
  }
  return total;
}

async function computeBudgetStatusUncached(now: Date): Promise<BudgetStatusResponse> {
  const monthStart = monthStartUtc(now);
  const rawCutoff = getExternalEventRawCutoff(now);

  const [
    providers,
    pushedByProvider,
    receiptCashByProviderId,
    latestCostTimes,
    materializedSubscriptionEvents,
  ] = await Promise.all([
    prisma.provider.findMany({
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        displayName: true,
        type: true,
        config: true,
        secretConfig: true,
        isActive: true,
        refreshIntervalMin: true,
        // Budget-breach control state (default-off). Surfaced on the DTO so the
        // dashboard/API can show the spend-cap/breach state, and used to emit
        // the advisory budget_control_paused / key_disable_recommended alerts.
        budgetControlsEnabled: true,
        budgetBreachState: true,
        budgetPausedAt: true,
        budgetPauseReason: true,
        budgetPauseThresholdUsd: true,
        budgetPauseObservedSpendUsd: true,
        keyDisableRecommended: true,
        plan: {
          select: {
            billingMode: true,
            fixedMonthlyCostUsd: true,
            monthlyBudgetUsd: true,
            monthlyRequestLimit: true,
            lowBalanceUsd: true,
            lowCredits: true,
            renewalDate: true,
            billingInterval: true,
            mustKeepFunded: true,
          },
        },
        snapshots: {
          orderBy: { fetchedAt: "desc" },
          take: 1,
          select: {
            balance: true,
            totalCost: true,
            fixedCostIncludedUsd: true,
            costWindowStart: true,
            costWindowEnd: true,
            costScope: true,
            costIncludesUnknownFixed: true,
            totalRequests: true,
            credits: true,
            // rawData is deliberately NOT selected here: nothing in this
            // function reads p.snapshots[0].rawData - the two places that
            // need Gemini rawData (geminiStatusSnapshots and
            // latestCostSnapshots below) fetch it themselves, scoped to only
            // the google-ai provider(s). Selecting it here pulled the full
            // adapter raw-response blob for all 39 providers on every call
            // for no reason and was a major contributor to the OOM crash on
            // the 512MB instance (see #392).
            fetchedAt: true,
          },
        },
        subscriptions: {
          where: {
            OR: [
              { status: "active" },
              {
                externalBillingManaged: true,
                lastChargedPeriodStart: { not: null },
              },
            ],
          },
          select: {
            id: true,
            costUsd: true,
            currency: true,
            interval: true,
            intervalCount: true,
            nextRenewalAt: true,
            autoRenew: true,
            externalBillingSource: true,
            externalBillingId: true,
            externalBillingManaged: true,
            currentPeriodStart: true,
            lastChargedPeriodStart: true,
            status: true,
          },
        },
        externalBillingChargeCorrections: {
          where: {
            originalPeriodStart: { gte: monthStart, lte: now },
          },
          orderBy: { observedAt: "desc" },
          select: {
            managedSubscriptionId: true,
            originalPeriodStart: true,
            originalPeriodEnd: true,
            originalAmountUsd: true,
            correctedAmountUsd: true,
            observedAt: true,
          },
        },
        externalBilling: {
          select: {
            source: true,
            externalId: true,
            kind: true,
            status: true,
            amountUsd: true,
            currency: true,
            billingInterval: true,
            currentPeriodStart: true,
            currentPeriodEnd: true,
            rollupRole: true,
            syncedAt: true,
          },
        },
        usageReconciliations: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { deltaUsd: true, status: true },
        },
      },
    }),
    sumMonthToDateExternalCostByProvider(monthStart, rawCutoff),
    sumMonthToDateReceiptCashByProviderId(monthStart, rawCutoff, now),
    prisma.usageSnapshot.groupBy({
      by: ["providerId"],
      where: {
        fetchedAt: { gte: monthStart, lte: now },
        totalCost: { not: null },
        // Cash eligibility: exclude daily windows and explicitly unknown
        // scopes (health-check placeholders, non-MTD estimates). Legacy null
        // scope remains eligible when the cost window is open-ended or starts
        // this month — adapters that know MTD set calendar_month_to_date /
        // billing_cycle_to_date.
        AND: [
          {
            OR: [
              { costScope: null },
              {
                costScope: {
                  in: ["calendar_month_to_date", "billing_cycle_to_date"],
                },
              },
            ],
          },
          {
            OR: [
              { costWindowStart: null },
              { costWindowStart: { gte: monthStart } },
            ],
          },
        ],
      },
      _max: { fetchedAt: true },
    }),
    prisma.externalUsageEvent.findMany({
      where: {
        sourceApp: "subscription",
        metricType: "subscription",
        occurredAt: { gte: monthStart, lte: now },
      },
      select: {
        idempotencyKey: true,
        costUsd: true,
        metadata: true,
        occurredAt: true,
        windowStart: true,
        windowEnd: true,
      },
    }),
  ]);

  const geminiProviders = providers.filter(
    (provider) =>
      provider.type.trim().toLowerCase() === "builtin" &&
      canonicalProviderKey(provider.name) === "google-ai"
  );
  // Read the latest non-null-rawData snapshot for EACH Gemini provider with a
  // bounded, per-provider findFirst (SQL LIMIT 1) - one rawData blob apiece.
  // Deliberately NOT a single `findMany(where providerId in gemini)`: without a
  // per-provider bound that materializes and JSON-parses EVERY retained
  // non-null-rawData snapshot for each Gemini provider (45-day retention x
  // 15-min polling = potentially thousands of large blobs) just to keep the
  // latest of each - reintroducing the OOM this change exists to kill. The loop
  // is a per-provider N+1, but ONLY over the Gemini subset (canonical name
  // "google-ai"), which is typically 1 and rarely more than a handful, so
  // serialization under connection_limit=1 is negligible and each read stays
  // O(1). Mirrors the identical bounded strategy in app/api/providers/route.ts.
  const geminiStatusSnapshots = new Map<
    string,
    { rawData: unknown; fetchedAt: Date }
  >();
  for (const provider of geminiProviders) {
    const snapshot = await prisma.usageSnapshot.findFirst({
      where: {
        providerId: provider.id,
        rawData: { not: Prisma.DbNull },
      },
      orderBy: { fetchedAt: "desc" },
      select: { rawData: true, fetchedAt: true },
    });
    if (snapshot) geminiStatusSnapshots.set(provider.id, snapshot);
  }

  const materializedChargeByIdempotencyKey = new Map<
    string,
    {
      subscriptionId: string;
      costUsd: number;
      occurredAt: Date;
      windowStart: Date;
      windowEnd: Date;
    }
  >();
  for (const event of materializedSubscriptionEvents) {
    if (!event.metadata || typeof event.metadata !== "object" || Array.isArray(event.metadata)) {
      continue;
    }
    const subscriptionId = (event.metadata as Record<string, unknown>).subscriptionId;
    if (
      typeof subscriptionId !== "string" ||
      !event.idempotencyKey ||
      event.costUsd == null ||
      !event.windowStart ||
      !event.windowEnd
    ) {
      continue;
    }
    materializedChargeByIdempotencyKey.set(event.idempotencyKey, {
      subscriptionId,
      costUsd: event.costUsd,
      occurredAt: event.occurredAt,
      windowStart: event.windowStart,
      windowEnd: event.windowEnd,
    });
  }

  const latestCostSnapshots = latestCostTimes.length
    ? await prisma.usageSnapshot.findMany({
        where: {
          OR: latestCostTimes.flatMap((row) =>
            row._max.fetchedAt
              ? [{ providerId: row.providerId, fetchedAt: row._max.fetchedAt }]
              : []
          ),
        },
        orderBy: { fetchedAt: "desc" },
        select: {
          id: true,
          providerId: true,
          fetchedAt: true,
          totalCost: true,
          fixedCostIncludedUsd: true,
          costWindowStart: true,
          costWindowEnd: true,
          costScope: true,
          costIncludesUnknownFixed: true,
          // rawData is NOT selected here (see costRawDataById below) -
          // this query runs for every provider with a cost snapshot this
          // month (typically close to all 39), and rawData is only ever
          // consulted for the bounded Google billing-identity and Mistral
          // legacy-provenance checks. Pulling the full blob for every provider
          // was the other half of this endpoint's OOM (see #392).
        },
      })
    : [];
  const latestCostByProviderId = new Map<
    string,
    (typeof latestCostSnapshots)[number]
  >();
  for (const snapshot of latestCostSnapshots) {
    if (!latestCostByProviderId.has(snapshot.providerId)) {
      latestCostByProviderId.set(snapshot.providerId, snapshot);
    }
  }
  // Cost-coverage caveats are tiny, typed metadata. Read just their presence
  // from selected cost snapshots so a provider-reported amount can remain
  // exact while budget coverage is never presented as complete when the
  // provider documents a known missing cost surface (for example OCI's
  // publication delay). Do not materialize raw adapter payloads here.
  const latestCostSnapshotIds = [...latestCostByProviderId.values()].map(
    (snapshot) => snapshot.id
  );
  const costCoverageCaveatSnapshotIds = new Set<string>();
  if (latestCostSnapshotIds.length > 0) {
    const rows = await prisma.$queryRaw<Array<{ id: string; version: unknown; code: unknown }>>(
      Prisma.sql`
        SELECT
          "id" AS "id",
          json_extract("rawData", '$.__apiUsageMonitor.version') AS "version",
          json_extract("rawData", '$.__apiUsageMonitor.costCoverageCaveat.code') AS "code"
        FROM "UsageSnapshot"
        WHERE "id" IN (${Prisma.join(latestCostSnapshotIds)})
      `
    );
    for (const row of rows) {
      if (Number(row.version) === 1 && typeof row.code === "string") {
        costCoverageCaveatSnapshotIds.add(row.id);
      }
    }
  }
  // Fetch rawData only for the selected Gemini and Mistral cost candidates.
  // Gemini needs its billing-config identity check. Mistral needs a bounded
  // read-time defense so the known retired spend-limit-as-cash provenance is
  // quarantined even before the idempotent maintenance correction gets its
  // first post-deploy pass (or when the current Mistral credential 401s).
  const costRawDataProviderIds = providers
    .filter((provider) => {
      const key = canonicalProviderKey(provider.name);
      return (
        provider.type.trim().toLowerCase() === "builtin" &&
        (key === "google-ai" || key === "mistral")
      );
    })
    .map((provider) => provider.id);
  const selectedCostSnapshotIds = costRawDataProviderIds
    .map((providerId) => latestCostByProviderId.get(providerId)?.id)
    .filter((id): id is string => typeof id === "string");
  const costRawDataRows = selectedCostSnapshotIds.length
    ? await prisma.usageSnapshot.findMany({
        where: { id: { in: selectedCostSnapshotIds } },
        select: { id: true, rawData: true },
      })
    : [];
  const costRawDataById = new Map(
    costRawDataRows.map((row) => [row.id, row.rawData])
  );

  const providerIdentityCandidates = providers.map((provider) => ({
    id: provider.id,
    name: provider.name,
    identityPriority:
      (provider.plan?.monthlyBudgetUsd != null ? 4 : 0) +
      (provider.plan ? 2 : 0),
  }));
  const pushedByProviderId = new Map<string, ProviderPushedCost>();
  for (const [producerName, pushed] of pushedByProvider) {
    const owner = resolveProviderIdentity(producerName, providerIdentityCandidates);
    if (!owner) continue;
    const bucket = pushedByProviderId.get(owner.id) ?? {
      usagePushed: 0,
      subscriptionPushed: 0,
      subscriptionPushedManualUsd: 0,
      estimatedApiEquivalentUsd: 0,
      pricedEventCount: 0,
      unpricedEventCount: 0,
      unclassifiedCostEventCount: 0,
    };
    bucket.usagePushed += pushed.usagePushed;
    bucket.subscriptionPushed += pushed.subscriptionPushed;
    bucket.subscriptionPushedManualUsd += pushed.subscriptionPushedManualUsd;
    bucket.estimatedApiEquivalentUsd += pushed.estimatedApiEquivalentUsd;
    bucket.pricedEventCount += pushed.pricedEventCount;
    bucket.unpricedEventCount += pushed.unpricedEventCount;
    bucket.unclassifiedCostEventCount += pushed.unclassifiedCostEventCount;
    pushedByProviderId.set(owner.id, bucket);
  }

  // Statistical spike/anomaly detection over per-provider daily spend history.
  // Env-gated (ANOMALY_ALERTS_ENABLED) and fully defensive: any failure or a
  // partial/mocked DB degrades to "no anomalies" rather than breaking the
  // canonical budget computation. The detector + robustness live in
  // anomaly-detection.ts; the loader is one capped, scalar-only snapshot query.
  const anomalyConfig = resolveAnomalyConfig();
  let anomaliesByProviderId = new Map<string, AnomalyResult[]>();
  if (anomalyConfig.enabled) {
    try {
      anomaliesByProviderId = await loadSpendAnomaliesByProviderId(now, anomalyConfig);
    } catch (error) {
      console.warn("[anomaly-detection] spend anomaly load failed; skipping", error);
    }
  }

  const providerStatuses: ProviderBudgetStatus[] = providers.map((p) => {
    const plan = p.plan;
    const latestSnapshot = p.snapshots[0] ?? null;
    const currentBillingConfig = serverConfig(p.config, p.secretConfig);
    const geminiBillingStatus = deriveGeminiBillingStatus({
      providerName: p.name,
      providerType: p.type,
      billingConfig: currentBillingConfig,
      latestSnapshot: geminiStatusSnapshots.get(p.id) ?? null,
    });
    const latestCostSnapshot = latestCostByProviderId.get(p.id) ?? null;
    const snapshotCostCoverageIncomplete =
      latestCostSnapshot != null &&
      costCoverageCaveatSnapshotIds.has(latestCostSnapshot.id);
    const geminiCostIdentityStatus = deriveGeminiBillingStatus({
      providerName: p.name,
      providerType: p.type,
      billingConfig: currentBillingConfig,
      latestSnapshot: latestCostSnapshot
        ? {
            rawData: costRawDataById.get(latestCostSnapshot.id) ?? null,
            fetchedAt: latestCostSnapshot.fetchedAt,
          }
        : null,
    });
    const fixedMonthlyCostUsd = plan?.fixedMonthlyCostUsd ?? 0;
    const billingConfigurationChanged =
      geminiBillingStatus?.state === "configuration_changed" ||
      geminiCostIdentityStatus?.state === "configuration_changed";
    const legacyMistralSnapshotQuarantined =
      p.type.trim().toLowerCase() === "builtin" &&
      canonicalProviderKey(p.name) === "mistral" &&
      latestCostSnapshot != null &&
      isLegacyMistralSpendLimitCostSnapshot({
        ...latestCostSnapshot,
        rawData: costRawDataById.get(latestCostSnapshot.id) ?? null,
      });
    const billingSnapshotQuarantined =
      billingConfigurationChanged ||
      geminiBillingStatus?.state === "not_configured" ||
      geminiCostIdentityStatus?.state === "not_configured" ||
      legacyMistralSnapshotQuarantined;
    // A fingerprint mismatch or removed billing configuration means the prior
    // snapshot belongs to an identity that is no longer current. Quarantine it
    // instead of charging old-project dollars to this provider row.
    const snapshotCostUsd = billingSnapshotQuarantined
      ? null
      : latestCostSnapshot?.totalCost ?? null;
    const snapshotFixedCostIncludedUsd = Math.max(
      0,
      Math.min(
        latestCostSnapshot?.fixedCostIncludedUsd ?? 0,
        snapshotCostUsd ?? 0
      )
    );
    const pushed = pushedByProviderId.get(p.id) ?? {
      usagePushed: 0,
      subscriptionPushed: 0,
      subscriptionPushedManualUsd: 0,
      estimatedApiEquivalentUsd: 0,
      pricedEventCount: 0,
      unpricedEventCount: 0,
      unclassifiedCostEventCount: 0,
    };
    const pushedMonthToDateUsd = pushed.usagePushed + pushed.subscriptionPushed;
    const receiptCash = receiptCashByProviderId.get(p.id) ?? {
      paidUsd: 0,
      eventCount: 0,
    };
    const pushedCostCoverage = classifyCostCoverage(pushed);
    // Usage-like pushed cost is deduped against the variable portion of the
    // poll snapshot via max(); fixed representations are reconciled below.
    const snapshotVariableCostUsd = Math.max(
      0,
      (snapshotCostUsd ?? 0) - snapshotFixedCostIncludedUsd
    );
    // Variable *consumption* only. max(snapshot, push) assumes one channel
    // supersets the other (org MTD vs app subset). Prepaid receipt cash is
    // funding, not usage — it stays in receiptCashPaidUsd and may floor EOM
    // projection, but must not inflate spentUsd / budget breach on top-ups.
    const observedVariableUsageUsd = Math.max(
      snapshotVariableCostUsd,
      pushed.usagePushed
    );
    const usageCost = observedVariableUsageUsd;
    const liveExternalFixed = p.externalBilling.filter((record) => {
      return (
        isExternalBillingLinkCandidate(record, {
          now,
          staleAfterMs: externalBillingFreshnessWindowMs(
            p.refreshIntervalMin
          ),
        }) &&
        record.currentPeriodStart != null &&
        record.currentPeriodStart >= monthStart &&
        record.currentPeriodStart <= now
      );
    });
    const localFixed = p.subscriptions.filter(
      (subscription) => subscription.currency.toUpperCase() === "USD"
    );
    const linkedPeriods = new Map<
      string,
      { materializedUsd: number; representedSnapshotUsd: number; observedAt: Date }
    >();
    const addLinkedPeriod = (
      subscriptionId: string,
      periodStart: Date,
      periodEnd: Date,
      representedSnapshotUsd: number,
      observedAt: Date,
      expectedMaterializedUsd?: number
    ) => {
      const periodKey = `${subscriptionId}\u0000${periodStart.toISOString()}\u0000${periodEnd.toISOString()}`;
      const materialized = materializedChargeByIdempotencyKey.get(
        subscriptionChargeIdempotencyKey(subscriptionId, periodStart)
      );
      if (
        !materialized ||
        materialized.subscriptionId !== subscriptionId ||
        materialized.occurredAt.getTime() !== periodStart.getTime() ||
        materialized.windowStart.getTime() !== periodStart.getTime() ||
        materialized.windowEnd.getTime() !== periodEnd.getTime() ||
        (expectedMaterializedUsd != null &&
          Math.abs(materialized.costUsd - expectedMaterializedUsd) > 1e-6)
      ) {
        return;
      }
      const existing = linkedPeriods.get(periodKey);
      if (!existing || observedAt > existing.observedAt) {
        linkedPeriods.set(periodKey, {
          materializedUsd: materialized.costUsd,
          representedSnapshotUsd,
          observedAt,
        });
      }
    };
    for (const subscription of localFixed) {
      if (!subscription.externalBillingSource || !subscription.externalBillingId) {
        continue;
      }
      const externalRecord = liveExternalFixed.find(
        (record) =>
          record.source === subscription.externalBillingSource &&
          record.externalId === subscription.externalBillingId
      );
      if (externalRecord) {
        const exactCurrentTerms = canLinkSubscriptionToExternalBilling(
          subscription,
          externalRecord
        );
        const chargedManagedCorrection =
          subscription.externalBillingManaged &&
          subscription.lastChargedPeriodStart?.getTime() ===
            subscription.currentPeriodStart.getTime() &&
          externalRecord.currentPeriodStart?.getTime() ===
            subscription.currentPeriodStart.getTime();
        if (exactCurrentTerms || chargedManagedCorrection) {
          const materializedPeriod = exactCurrentTerms
            ? resolveExternalBillingPeriod(externalRecord)!
            : {
                start: subscription.currentPeriodStart,
                end: subscription.nextRenewalAt,
              };
          addLinkedPeriod(
            subscription.id,
            materializedPeriod.start,
            materializedPeriod.end,
            externalRecord.amountUsd ?? 0,
            externalRecord.syncedAt
          );
        }
      }

    }
    // Correction proofs were written only while the provider record was
    // fresh/authoritative and only after verifying one exact local event. They
    // remain historical overlap evidence if the source rolls/stales or an
    // owner later edits/deletes the Subscription row; neither action deletes
    // the already-materialized charge event. Stale evidence cannot create a
    // new proof or settle a new collision.
    for (const correction of p.externalBillingChargeCorrections) {
      addLinkedPeriod(
        correction.managedSubscriptionId,
        correction.originalPeriodStart,
        correction.originalPeriodEnd,
        correction.correctedAmountUsd,
        correction.observedAt,
        correction.originalAmountUsd
      );
    }
    const representedSnapshotFixedUsd = [...linkedPeriods.values()].reduce(
      (sum, period) => sum + period.representedSnapshotUsd,
      0
    );
    // Do not spend proof from one fixed source against an unrelated/partial
    // provider snapshot. The snapshot must cover every represented corrected
    // amount before any exact linked historical events are replaced.
    const linkedMaterializedFixedUsd =
      snapshotFixedCostIncludedUsd + 0.005 >= representedSnapshotFixedUsd
        ? [...linkedPeriods.values()].reduce(
            (sum, period) => sum + period.materializedUsd,
            0
          )
        : 0;
    const linkedSnapshotRepresentationUsd =
      linkedMaterializedFixedUsd > 0 ? representedSnapshotFixedUsd : 0;
    // A provider can correct a fixed charge after the linked historical event
    // materialized. Once an included fixed-cost snapshot exists, subtract the
    // full overlap proven by linked materialized/subscription evidence, even
    // when that old event is larger than a downward-corrected snapshot. This
    // makes $5 historical + $4 corrected snapshot resolve to $4 (and $5 + $6
    // to $6), while never deducting more than either the linked event total or
    // the subscription event channel actually contains.
    //
    // pushed.subscriptionPushed is additive across BOTH the materializer's own
    // sourceApp="subscription" charge (the thing linkedMaterializedFixedUsd
    // proves overlaps the snapshot) AND any manual adjustments (owner-directed
    // historical corrections/refunds, sourceApp != SUBSCRIPTION_SOURCE_APP)
    // that are never represented in the snapshot at all. Dedupe against only
    // the materializer-linked slice — isolated by subtracting the tracked
    // manual contribution — so a manual refund is never cancelled out by this
    // dedupe, and clamp it at 0 so a refund that drives the isolated slice
    // negative can never make the dedupe itself negative and ADD spend back
    // (see subscriptionPushedManualUsd's doc comment in external-usage-events.ts).
    const materializerLinkedSubscriptionPushedUsd = Math.max(
      0,
      pushed.subscriptionPushed - pushed.subscriptionPushedManualUsd
    );
    const linkedFixedDedupeUsd =
      snapshotFixedCostIncludedUsd > 0
        ? Math.min(
            materializerLinkedSubscriptionPushedUsd,
            linkedMaterializedFixedUsd
          )
        : 0;
    const snapshotCostIncludesUnknownFixed =
      snapshotCostUsd != null
        ? latestCostSnapshot?.costIncludesUnknownFixed ?? false
        : false;
    const fixedCostConflict =
      (fixedMonthlyCostUsd > 0 &&
        (pushed.subscriptionPushed > 0 || snapshotFixedCostIncludedUsd > 0)) ||
      Math.min(
        Math.max(
          0,
          snapshotFixedCostIncludedUsd - linkedSnapshotRepresentationUsd
        ),
        Math.max(0, pushed.subscriptionPushed - linkedFixedDedupeUsd)
      ) > 0.005 ||
      (snapshotCostIncludesUnknownFixed && pushed.subscriptionPushed > 0) ||
      linkedMaterializedFixedUsd - linkedFixedDedupeUsd > 0.005;
    // Prefer a single fixed source of truth for cash: when subscription events
    // already materialize the recurring fee, do NOT also add ProviderPlan
    // fixedMonthlyCostUsd (operator double-model). Still surface fixedCostConflict
    // so Settings can resolve the misconfiguration. Linked snapshot dedupe is
    // unchanged below.
    const planFixedInCashUsd =
      fixedMonthlyCostUsd > 0 && pushed.subscriptionPushed > 0
        ? 0
        : fixedMonthlyCostUsd;
    // Preserve every distinct *remaining* fixed source. Collapse only the amount
    // proven to represent the same provider billing identity through an explicit
    // local Subscription link; equal prices alone are never treated as identity.
    const fixedAccruedUsd =
      planFixedInCashUsd +
      pushed.subscriptionPushed +
      snapshotFixedCostIncludedUsd -
      linkedFixedDedupeUsd;
    const spentUsd = fixedAccruedUsd + usageCost;
    const hasPushedEvents =
      pushed.pricedEventCount +
        pushed.unpricedEventCount +
        pushed.unclassifiedCostEventCount >
      0;
    const hasKnownVariableCost =
      pushed.pricedEventCount > 0 ||
      snapshotCostUsd != null ||
      receiptCash.paidUsd > 0;
    const hasUnknownCost =
      pushed.unpricedEventCount > 0 || pushed.unclassifiedCostEventCount > 0;
    let spendCoverage: CostCoverage = hasUnknownCost
      ? hasKnownVariableCost || fixedAccruedUsd > 0
        ? "partial"
        : pushed.unclassifiedCostEventCount > 0
          ? "legacy_unknown"
          : "unknown"
      : hasPushedEvents || snapshotCostUsd != null
        ? "complete"
        : fixedAccruedUsd > 0 || receiptCash.paidUsd > 0
          ? "partial"
          : "unknown";
    // Anthropic individual accounts and Mistral's currently published Admin
    // Usage schema have no authoritative cash-total API. A fully priced
    // producer stream is complete for the events received, but cannot prove
    // that every account request reached the monitor. Keep provider-level
    // cash explicitly partial until an authoritative cost snapshot exists.
    if (
      ["anthropic", "mistral"].includes(canonicalProviderKey(p.name)) &&
      snapshotCostUsd == null &&
      hasPushedEvents &&
      spendCoverage === "complete"
    ) {
      spendCoverage = "partial";
    }
    const geminiBillingIncomplete =
      geminiBillingStatus != null && geminiBillingStatus.state !== "ready";
    if (geminiBillingIncomplete && spendCoverage === "complete") {
      spendCoverage =
        hasKnownVariableCost || fixedAccruedUsd > 0 ? "partial" : "unknown";
    }
    if (snapshotCostCoverageIncomplete && spendCoverage === "complete") {
      spendCoverage = hasKnownVariableCost || fixedAccruedUsd > 0
        ? "partial"
        : "unknown";
    }
    const forecastedSubscriptionRenewalsUsd = forecastSubscriptionRenewals(
      p.subscriptions,
      now
    );
    // Receipt funding is a lumpy cash event, not a consumption sample. While
    // it covers the observed variable usage, keep the receipt amount as the
    // variable projection instead of annualizing/month-elapsed extrapolating
    // that deposit. Once observed usage exceeds receipt cash, resume the
    // ordinary usage-rate forecast with the receipt as a lower bound.
    const projectedVariableUsageUsd =
      receiptCash.paidUsd >= observedVariableUsageUsd
        ? receiptCash.paidUsd
        : Math.max(
            receiptCash.paidUsd,
            calculateEomForecast(observedVariableUsageUsd, 0, now)
          );
    const monthlyBudgetUsd = plan?.monthlyBudgetUsd ?? null;

    // Reuse the shared alert logic for budget alerts by feeding the combined usage cost as the
    // snapshot's totalCost (so budget_exceeded/budget_warning reflect BOTH poll + pushed spend).
    const alertState = buildProviderAlertState(
      {
        isActive: p.isActive,
        refreshIntervalMin: p.refreshIntervalMin,
        plan: plan ?? null,
        latestSnapshot: {
          balance: latestSnapshot?.balance ?? null,
          totalCost: usageCost,
          totalRequests: latestSnapshot?.totalRequests ?? null,
          credits: latestSnapshot?.credits ?? null,
          fetchedAt: latestSnapshot?.fetchedAt ?? now,
        },
        trackedSpendUsd: spentUsd,
        fixedAccruedUsd,
        reconciliationDiscrepancyUsd: p.usageReconciliations?.[0]?.status === "discrepancy" ? p.usageReconciliations[0].deltaUsd : null,
        anomalies: anomaliesByProviderId.get(p.id),
      },
      now
    );
    const budgetAlerts = alertState.alerts.filter(
      (a) =>
        a.code === "budget_exceeded" ||
        a.code === "budget_warning" ||
        a.code === "usage_reconciliation_discrepancy" ||
        a.code === "spend_anomaly" ||
        a.code === "request_anomaly"
    );
    if (fixedCostConflict) {
      budgetAlerts.push({
        code: "fixed_cost_conflict",
        severity: "warning",
        message:
          "Provider-reported and manual fixed costs may overlap; link or remove the manual entry after reconciling the provider billing record.",
      });
    }
    if (p.isActive && geminiBillingIncomplete) {
      const message =
        billingConfigurationChanged
          ? "Google Cloud Billing configuration changed; prior-configuration cost is excluded until the new configuration is verified."
          : geminiBillingStatus.state === "error"
          ? "Google Cloud Billing sync failed; spend is last known and coverage is incomplete."
          : geminiBillingStatus.state === "pending"
            ? "Google Cloud Billing export is pending; pending is not $0 and spend coverage is incomplete."
            : geminiBillingStatus.state === "unchecked"
              ? "Google Cloud Billing has not been checked for the current configuration."
              : "Google Cloud Billing is not configured; Gemini API spend coverage is incomplete.";
      budgetAlerts.push({
        code: "billing_sync_incomplete",
        severity:
          billingConfigurationChanged || geminiBillingStatus.state === "error"
            ? "warning"
            : "info",
        message,
      });
    }

    // Advisory budget-control alerts. Gated on the master flag AND the
    // per-provider opt-in so that with controls off (the default) NO new alert
    // is ever produced — behavior is byte-identical to notify-only. These are
    // observability only; key_disable_recommended never reflects any credential
    // change (key revocation is owner-only per the safety rules).
    const budgetControlsActive =
      budgetAutoControlsEnabledForStatus() && p.budgetControlsEnabled;
    const budgetBreachState = normalizeBudgetBreachState(p.budgetBreachState);
    if (budgetControlsActive && p.budgetPausedAt != null) {
      budgetAlerts.push({
        code: "budget_control_paused",
        severity: "critical",
        message:
          p.budgetPauseReason ??
          "Provider polling was automatically paused on a sustained budget breach.",
      });
    }
    if (budgetControlsActive && p.keyDisableRecommended) {
      budgetAlerts.push({
        code: "key_disable_recommended",
        severity: "warning",
        message:
          "RECOMMENDATION ONLY: budget breach suggests disabling or rotating this provider key. No credential has been modified.",
      });
    }

    let status: BudgetStatusLevel;
    let remainingUsd: number | null;
    let percentUsed: number | null;
    if (monthlyBudgetUsd == null || monthlyBudgetUsd <= 0) {
      status = "unconfigured";
      remainingUsd = null;
      percentUsed = null;
    } else {
      remainingUsd = monthlyBudgetUsd - spentUsd;
      percentUsed = spentUsd / monthlyBudgetUsd;
      status =
        spentUsd >= monthlyBudgetUsd
          ? "exceeded"
          : spentUsd >= monthlyBudgetUsd * WARNING_RATIO
            ? "warning"
            : "ok";
    }

    // Throttle consumers need runway, not only lagging MTD spend. projectedStatus
    // elevates when EOM projection would breach even if current spend is still ok.
    let projectedStatus: BudgetStatusLevel = status;
    if (monthlyBudgetUsd != null && monthlyBudgetUsd > 0) {
      const projected = projectedVariableUsageUsd + fixedAccruedUsd + forecastedSubscriptionRenewalsUsd;
      // projectedEomUsd is assigned below — compute inline for projectedStatus.
      const projectedEomForStatus = projected;
      if (projectedEomForStatus >= monthlyBudgetUsd) {
        projectedStatus = "exceeded";
      } else if (projectedEomForStatus >= monthlyBudgetUsd * WARNING_RATIO) {
        projectedStatus = status === "exceeded" ? "exceeded" : "warning";
      }
    }

    return {
      id: p.id,
      name: p.name,
      displayName: p.displayName,
      monthlyBudgetUsd,
      fixedMonthlyCostUsd,
      snapshotCostUsd,
      snapshotCostFetchedAt: billingSnapshotQuarantined
        ? null
        : latestCostSnapshot?.fetchedAt.toISOString() ?? null,
      snapshotCostWindowStart: billingSnapshotQuarantined
        ? null
        : latestCostSnapshot?.costWindowStart?.toISOString() ?? null,
      snapshotCostWindowEnd: billingSnapshotQuarantined
        ? null
        : latestCostSnapshot?.costWindowEnd?.toISOString() ?? null,
      snapshotCostScope: billingSnapshotQuarantined
        ? null
        : latestCostSnapshot?.costScope ?? null,
      snapshotFixedCostIncludedUsd,
      snapshotCostIncludesUnknownFixed,
      pushedMonthToDateUsd,
      receiptCashPaidUsd: receiptCash.paidUsd,
      receiptCashEventCount: receiptCash.eventCount,
      observedVariableUsageUsd,
      estimatedApiEquivalentUsd: pushed.estimatedApiEquivalentUsd,
      pushedCostCoverage,
      pushedPricedEventCount: pushed.pricedEventCount,
      pushedUnpricedEventCount: pushed.unpricedEventCount,
      pushedUnclassifiedCostEventCount: pushed.unclassifiedCostEventCount,
      spendCoverage,
      subscriptionMonthToDateUsd: pushed.subscriptionPushed,
      fixedAccruedUsd,
      linkedFixedDedupeUsd,
      fixedCostConflict,
      forecastedSubscriptionRenewalsUsd,
      spentUsd,
      projectedEomUsd:
        fixedAccruedUsd +
        projectedVariableUsageUsd +
        forecastedSubscriptionRenewalsUsd,
      remainingUsd,
      percentUsed,
      status,
      projectedStatus,
      alerts: budgetAlerts,
      budgetControls: {
        enabled: p.budgetControlsEnabled,
        breachState: budgetBreachState,
        pausedAt: p.budgetPausedAt?.toISOString() ?? null,
        pauseReason: p.budgetPauseReason,
        pauseThresholdUsd: p.budgetPauseThresholdUsd,
        pauseObservedSpendUsd: p.budgetPauseObservedSpendUsd,
        keyDisableRecommended: p.keyDisableRecommended,
      },
    };
  });

  const budgeted = providerStatuses.filter((p) => p.monthlyBudgetUsd != null && p.monthlyBudgetUsd > 0);
  const totalBudgetUsd = budgeted.reduce((s, p) => s + (p.monthlyBudgetUsd ?? 0), 0);
  const budgetedSpentUsd = budgeted.reduce((s, p) => s + p.spentUsd, 0);
  const totalSpentUsd = providerStatuses.reduce((s, p) => s + p.spentUsd, 0);
  const estimatedApiEquivalentUsd = providerStatuses.reduce(
    (sum, provider) => sum + provider.estimatedApiEquivalentUsd,
    0
  );

  return {
    ok: true,
    generatedAt: now.toISOString(),
    month: monthLabel(now),
    providers: providerStatuses,
    summary: {
      totalBudgetUsd,
      budgetedSpentUsd,
      unbudgetedSpentUsd: totalSpentUsd - budgetedSpentUsd,
      totalSpentUsd,
      estimatedApiEquivalentUsd,
      remainingUsd: totalBudgetUsd - budgetedSpentUsd,
      percentUsed: totalBudgetUsd > 0 ? budgetedSpentUsd / totalBudgetUsd : null,
      overBudget: providerStatuses.some((p) => p.status === "exceeded"),
      warning: providerStatuses.some((p) => p.status === "warning"),
    },
  };
}

// ---------------------------------------------------------------------------
// Stale-while-revalidate cache for computeBudgetStatus and
// computeProjectBudgetStatus.
//
// computeBudgetStatusUncached's sumMonthToDateExternalCostByProvider call
// live-groups the ENTIRE current month of raw ExternalUsageEvent rows on
// every invocation (the daily-rollup branch only ever applies to days older
// than the raw-retention cutoff, never to the current month) - measured at
// ~11.4s in production, which is effectively all of GET /api/providers's
// ~11.5s. computeProjectBudgetStatusUncached's OWN
// sumMonthToDateExternalCostAttribution call has the identical shape and
// cost (same live-group-the-current-month root cause) and is the entire
// reason GET /api/projects and GET /api/budget-status were STILL ~11s after
// computeBudgetStatus grew its own cache. A stale provider hit can also start
// its refresh in the background while a project refresh proceeds to its own
// attribution aggregate. The two ExternalUsageEvent summary functions now
// share a FIFO lease around their complete bodies, so neither cold nor stale
// paths can retain both aggregate result sets at once. Everything else either
// function reads stays well under 100ms.
//
// Rather than changing what gets computed (a money-path calculation with a
// lot of reconciliation logic - see the comment atop this file), this caches
// the OUTPUT of each: the exact same object the respective *Uncached
// function returns today, memoized for a short TTL. The dashboard is fine
// reading numbers up to TTL seconds stale (this is explicitly an accepted
// trade-off, not an oversight). Caching computeProjectBudgetStatus's OUTPUT
// (rather than only its own extra query) is the simplest fix: it already
// calls the now-cached computeBudgetStatus internally, so wrapping its own
// output makes the ENTIRE /api/projects + /api/budget-status path fast, not
// just the slice that overlaps /api/providers.
//
// Design: one small generic helper (createStaleWhileRevalidateCache below),
// used by both caches, so the concurrency/rollover contract is fixed and
// tested in exactly one place instead of two bespoke copies with two chances
// to reintroduce the same bug.
//   - Single module-level cache entry per wrapped function (this app runs
//     numInstances:1, so a per-process cache is equivalent to a shared one -
//     no cross-instance staleness/coherency concerns).
//   - Cache key is the UTC month-start timestamp, so each cache auto-drops
//     stale data at month rollover instead of serving last month's spend
//     into the new month. `now` is each wrapped function's only input, and
//     every other value the computation reads (DB rows, env-driven
//     retention cutoff) comes from the current process's live state at
//     compute time, not from any other argument - so the month-start key is
//     complete for this cache's correctness contract.
//   - TTL is env-overridable via BUDGET_STATUS_CACHE_TTL_MS (default 60s),
//     shared by both caches below.
//   - Stale-while-revalidate: once a value exists for the current key, every
//     call returns it immediately - even past TTL. A stale hit kicks off a
//     background refresh (deduped: only one refresh in flight per key at a
//     time) and still returns the old value immediately rather than making
//     the caller wait on it. Only a cold cache (nothing cached yet for the
//     current month) or a month rollover computes inline/blocking, and
//     concurrent callers during that blocking compute share the same
//     in-flight promise instead of each starting their own ~11s query.
//   - The in-flight refresh promise is associated with the key it is
//     computing (not just "something is running"). A caller only piggybacks
//     on an in-flight refresh when that refresh's key matches its OWN
//     requested key; a caller whose key doesn't match (e.g. a UTC month
//     rollover landing while the previous month's background refresh is
//     still running) starts its own fresh compute instead of awaiting the
//     wrong month's in-flight work and returning its (mislabeled) result. A
//     refresh only writes its result into the cache and clears the
//     in-flight slot while it still "owns" that slot at completion; if a
//     newer request for a different key has since taken over the slot, the
//     older refresh's result is discarded instead of clobbering the newer
//     entry. After awaiting, a caller re-checks (and if necessary retries)
//     until the cache entry actually matches its own requested key, so a
//     caller can never return a different key's data.
//   - A background refresh that throws is caught and logged at warn; the
//     last good cached value keeps being served. A blocking (cold-start)
//     compute that throws propagates the error as before - there is no
//     "last good value" to fall back to yet.
//   - Explicit invalidation (bustBudgetStatusCache, called by the project and
//     provider mutation routes) drops the entry AND bumps a generation
//     counter. The generation is required for correctness: the cache key is
//     just the month-start string, which an invalidation does not change, so
//     ownership of the in-flight slot is (key, generation). Without it, a
//     refresh that began before the mutation still matched on key at
//     completion - because a post-bust caller had re-claimed the slot for the
//     same month - and would write its pre-mutation snapshot into the
//     just-busted cache, clear the slot out from under the post-bust refresh,
//     and thereby get that refresh's correct result discarded. The user then
//     saw the deleted project (or the missing new one) for another full TTL.
//     With the generation, pre-invalidation work can never be published:
//     worst case it is discarded and the next reader pays a cold compute,
//     which is the fail-safe direction (slower, never wrong).
//
// Disabled under the Vitest test runner by default: the existing test suite
// calls computeBudgetStatus/computeProjectBudgetStatus repeatedly with a
// fixed `now` across many distinct DB fixtures within the same test file
// (module instance), and a real cache keyed only on month-start would serve
// one test's provider data to every later test in that file. Production has
// no VITEST env var, so this only ever affects `vitest run`. The dedicated
// cache-behavior tests below force each cache on via its own exported
// test-only override.

interface StaleWhileRevalidateCacheEntry<T> {
  key: string;
  value: T;
  computedAt: number;
}

/**
 * A small stale-while-revalidate memoization helper keyed by an arbitrary
 * string derived from the call's `now`. See the file comment above for the
 * full concurrency/rollover contract this implements.
 */
function createStaleWhileRevalidateCache<T>(options: {
  label: string;
  compute: (now: Date) => Promise<T>;
  keyFor: (now: Date) => string;
  ttlMs: () => number;
}) {
  let entry: StaleWhileRevalidateCacheEntry<T> | null = null;
  // The key AND generation of the refresh that currently "owns"
  // refreshPromise. A refresh only writes to `entry` / clears these slots
  // while it still owns them at completion - see the file comment above.
  let refreshPromise: Promise<void> | null = null;
  let refreshKey: string | null = null;
  let refreshGeneration = -1;
  // Bumped by invalidate(). The cache key alone (a month-start string) cannot
  // express "the underlying rows changed", so ownership is (key, generation):
  // without the generation, a refresh that started BEFORE an invalidation
  // still saw `refreshKey === key` at completion - because a post-invalidation
  // caller had re-claimed the slot for the same month - and wrote its
  // pre-mutation snapshot into the freshly-busted cache.
  let generation = 0;
  let override: boolean | null = null;

  function enabled(): boolean {
    if (override !== null) return override;
    return process.env.VITEST !== "true";
  }

  function ownsSlot(key: string, gen: number): boolean {
    return refreshKey === key && refreshGeneration === gen;
  }

  async function refresh(now: Date, key: string, gen: number): Promise<void> {
    try {
      const value = await options.compute(now);
      // Only adopt this result if a newer request hasn't already taken over
      // this key's in-flight slot (e.g. a month rollover started its own
      // fresh compute for the new key while this now-stale-key refresh was
      // still in flight) - otherwise a slow, superseded refresh could
      // clobber a more current cache entry after the fact.
      //
      // `generation === gen` additionally rejects a result computed from rows
      // read BEFORE an invalidation: that data is known-stale by definition,
      // so it must never be published, even though its month key still
      // matches. Discarding is the fail-safe direction - the next reader just
      // recomputes (today's cold-cache cost) rather than being served numbers
      // the user has already invalidated.
      if (ownsSlot(key, gen) && generation === gen) {
        entry = { key, value, computedAt: Date.now() };
      }
    } catch (error) {
      // A background refresh (there IS a last-good value for this key) must
      // never crash the process or surface to the caller that triggered it -
      // keep serving what we have and try again on the next stale hit. A
      // cold start (no cached value yet for this key) has nothing to fall
      // back to, so it rethrows and the caller sees the failure, exactly
      // like an uncached call would today.
      // eslint-disable-next-line no-console -- intentional: surfaces cache-refresh failures for on-call visibility
      console.warn(
        `[${options.label}] refresh failed; serving last good value if available`,
        error
      );
      if (!entry || entry.key !== key) {
        throw error;
      }
    } finally {
      // Only clear the slot if we still own it. Checking the generation too
      // stops a superseded pre-invalidation refresh from releasing the slot
      // that a post-invalidation refresh has since claimed - which used to
      // make that newer refresh fail its own ownership check and throw away
      // its (correct) result.
      if (ownsSlot(key, gen)) {
        refreshPromise = null;
        refreshKey = null;
        refreshGeneration = -1;
      }
    }
  }

  async function get(now: Date): Promise<T> {
    if (!enabled()) {
      return options.compute(now);
    }

    const key = options.keyFor(now);
    const cached = entry;
    if (cached && cached.key === key) {
      if (
        Date.now() - cached.computedAt >= options.ttlMs() &&
        !(refreshPromise && ownsSlot(key, generation))
      ) {
        // Fire-and-forget: don't let a slow/failing background refresh delay
        // (or, via an unhandled rejection, crash) the caller that happened
        // to notice the value was stale.
        const gen = generation;
        refreshKey = key;
        refreshGeneration = gen;
        refreshPromise = refresh(now, key, gen).catch(() => {});
      }
      return cached.value;
    }

    // Cold cache, or the requested key doesn't match what's cached (e.g. a
    // UTC month rollover). Only piggyback on an in-flight refresh when it is
    // for THIS key - an in-flight refresh for a different key (a
    // still-finishing prior-month background refresh, or another caller's
    // own rollover) must never be awaited here: it would resolve to the
    // wrong key's data and could block us needlessly.
    for (;;) {
      // Re-read the generation each attempt: an invalidation that lands while
      // we are awaiting must send us round the loop for a genuinely fresh
      // compute rather than letting us adopt pre-invalidation work.
      const gen = generation;
      let inFlight: Promise<void>;
      if (refreshPromise && ownsSlot(key, gen)) {
        inFlight = refreshPromise;
      } else {
        refreshKey = key;
        refreshGeneration = gen;
        inFlight = refresh(now, key, gen);
        refreshPromise = inFlight;
      }
      await inFlight;
      if (entry && entry.key === key) {
        return entry.value;
      }
      // Extremely rare: something else moved the cache on again before we
      // could read our own result back (e.g. a rapid double rollover).
      // Loop and try again for our own key.
    }
  }

  function invalidate(): void {
    // Bumping the generation is what actually evicts in-flight work: any
    // refresh already running was computed from pre-invalidation rows, so it
    // loses ownership here and its result is dropped on completion.
    generation++;
    entry = null;
    refreshPromise = null;
    refreshKey = null;
    refreshGeneration = -1;
  }

  /**
   * Soft-stale mark (Wave F / E7): keep serving the last-good value, but force
   * the next reader to kick a background refresh immediately (as if TTL
   * expired). Unlike invalidate(), this does not drop the entry or bump the
   * generation — safe to call after high-volume ingest without thrashing.
   */
  function markSoftStale(): void {
    if (entry) {
      entry = { ...entry, computedAt: 0 };
    }
  }

  return {
    get,
    invalidate,
    markSoftStale,
    setOverrideForTests(value: boolean | null): void {
      override = value;
    },
    resetForTests(): void {
      invalidate();
    },
  };
}

function budgetStatusCacheKey(now: Date): string {
  return monthStartUtc(now).toISOString();
}

// Exported (mirrors resolveSchedulerBootDelayMs in usage-recorder.ts) so
// budget-status-cache.test.ts can exercise the env-parsing edge cases
// directly. An empty or whitespace-only BUDGET_STATUS_CACHE_TTL_MS must fall
// through to the 60s default rather than parsing as 0 (Number("") === 0,
// which is finite and >= 0, so it would otherwise silently disable the SWR
// window entirely).
export function budgetStatusCacheTtlMs(): number {
  const raw = process.env.BUDGET_STATUS_CACHE_TTL_MS?.trim();
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 60_000;
}

const budgetStatusSwrCache = createStaleWhileRevalidateCache<BudgetStatusResponse>({
  label: "budget-status-cache",
  compute: computeBudgetStatusUncached,
  keyFor: budgetStatusCacheKey,
  ttlMs: budgetStatusCacheTtlMs,
});

/** Test-only: force the cache on/off regardless of the Vitest-default gate. Pass null to restore the default. */
export function __setBudgetStatusCacheOverrideForTests(enabled: boolean | null): void {
  budgetStatusSwrCache.setOverrideForTests(enabled);
}

/** Test-only: drop any cached value/in-flight refresh so the next call recomputes from scratch. */
export function __resetBudgetStatusCacheForTests(): void {
  budgetStatusSwrCache.resetForTests();
}

/**
 * Invalidate both the computeBudgetStatus and computeProjectBudgetStatus
 * caches, so the next read of either recomputes from current rows.
 *
 * Call this from a mutation AFTER its write has committed, whenever that write
 * changes what these summaries report: provider create/update/delete and
 * project create/update/delete. Both caches are always busted together -
 * computeProjectBudgetStatus's output embeds computeBudgetStatus's, so
 * invalidating only one would leave the other serving a contradicting view.
 *
 * Hard invalidation is deliberately NOT the default for usage ingest
 * (/api/ingest/usage, OTLP): those write continuously, and full busts per
 * event would defeat the cache. Use markBudgetStatusSoftStale() after a
 * successful ingest so the next reader still gets last-good immediately but
 * kicks a background refresh (Wave F / E7).
 *
 * Invalidation is generation-based, so a refresh that started before this call
 * cannot publish its (pre-mutation) result afterwards.
 */
export function bustBudgetStatusCache(): void {
  budgetStatusSwrCache.invalidate();
  projectBudgetStatusSwrCache.invalidate();
  clearMtdScanMemo();
}

/**
 * Soft-stale both budget SWR caches after ingest/OTLP successfully persists
 * new rows. Does not drop last-good values or bump generations.
 */
export function markBudgetStatusSoftStale(): void {
  budgetStatusSwrCache.markSoftStale();
  projectBudgetStatusSwrCache.markSoftStale();
  // Wave H / E1: drop shared MTD scan memo so soft-stale refresh recomputes
  // against post-ingest rows rather than serving a 5s-stale groupBy.
  clearMtdScanMemo();
}

export async function computeBudgetStatus(now: Date = new Date()): Promise<BudgetStatusResponse> {
  return budgetStatusSwrCache.get(now);
}

export interface ProjectBudgetStatus {
  id: string;
  name: string;
  description: string | null;
  monthlyBudgetUsd: number | null;
  spentUsd: number;
  projectedEomUsd: number;
  spendCoverage: CostCoverage;
  pricedEventCount: number;
  unpricedEventCount: number;
  unclassifiedCostEventCount: number;
  incompleteAllocatedProviderCount: number;
  // Cost attributed directly to this project — events carrying its projectId
  // (incl. materialized subscription charges) plus the legacy fallback where an
  // untagged event's sourceApp matches this project's name.
  directUsd: number;
  // Cost distributed to this project by ProviderProjectAllocation percentages
  // out of each provider's residual (spend not directly attributed anywhere).
  allocatedUsd: number;
  remainingUsd: number | null;
  percentUsed: number | null;
  status: BudgetStatusLevel;
}

export interface ProjectBudgetStatusResponse {
  ok: true;
  generatedAt: string;
  month: string;
  providers: ProviderBudgetStatus[];
  projects: ProjectBudgetStatus[];
  summary: {
    totalBudgetUsd: number;
    budgetedSpentUsd: number;
    unbudgetedSpentUsd: number;
    unassignedSpentUsd: number;
    totalSpentUsd: number;
    estimatedApiEquivalentUsd: number;
    remainingUsd: number;
    percentUsed: number | null;
    overBudget: boolean;
    warning: boolean;
  };
}

async function computeProjectBudgetStatusUncached(now: Date): Promise<ProjectBudgetStatusResponse> {
  // On a cold cache this await completes provider totals before attribution.
  // On a stale hit it intentionally returns the cached provider view and may
  // start a background provider refresh, preserving SWR latency. The shared
  // exclusive lease inside the two ExternalUsageEvent summary functions then
  // queues attribution behind that refresh through result processing. Do not
  // take a higher-level lock here: this nested provider call would deadlock.
  const providerStatus = await computeBudgetStatus(now);
  const [projects, attribution, identityProviders] = await Promise.all([
    prisma.project.findMany({
      include: {
        allocations: true,
      },
      orderBy: { name: "asc" }
    }),
    sumMonthToDateExternalCostAttribution(monthStartUtc(now), getExternalEventRawCutoff(now)),
    prisma.provider.findMany({
      select: {
        id: true,
        name: true,
        plan: { select: { monthlyBudgetUsd: true } },
      },
    }),
  ]);

  // Use the same oldest-row canonical resolver as ingest for the legacy
  // sourceApp-name fallback. Existing alias duplicates are therefore stable
  // even before an operator consolidates them.
  const projectIdByName = buildCanonicalProjectIdMap(projects);

  // Slice the (provider, sourceApp, projectId) triples into:
  //   directByProjectId  — cost attributed to a specific project. A row counts
  //     when it carries a projectId (authoritative), OR — only if untagged —
  //     when its sourceApp matches a known Project.name (legacy behaviour, kept
  //     for back-compat but no longer able to double-count a projectId row).
  //   attributedByProvider — for each provider, the slice of its cost that
  //     landed on SOME project above; subtracted from provider.spentUsd to get
  //     the residual that percentage allocations distribute (this is the fix
  //     for the old code, which subtracted a differently-keyed pushed total).
  const directByProjectId = new Map<string, number>();
  const directFixedByProjectId = new Map<string, number>();
  const directCoverageByProjectId = new Map<
    string,
    {
      pricedEventCount: number;
      unpricedEventCount: number;
      unclassifiedCostEventCount: number;
    }
  >();
  const attributedByProviderId = new Map<string, number>();
  const attributedFixedByProviderId = new Map<string, number>();
  const directVariableByProviderProjectId = new Map<
    string,
    Map<string, number>
  >();
  const totalDirectVariableByProviderId = new Map<string, number>();
  const providerById = new Map(providerStatus.providers.map((p) => [p.id, p]));
  const projectProviderCandidates = identityProviders.map((provider) => ({
    id: provider.id,
    name: provider.name,
    identityPriority:
      (provider.plan?.monthlyBudgetUsd != null ? 4 : 0) +
      (provider.plan ? 2 : 0),
  }));
  for (const row of attribution) {
    const projectId =
      row.projectId ?? projectIdByName.get(canonicalProjectKey(row.sourceApp)) ?? null;
    if (!projectId) continue;
    const directCoverage = directCoverageByProjectId.get(projectId) ?? {
      pricedEventCount: 0,
      unpricedEventCount: 0,
      unclassifiedCostEventCount: 0,
    };
    directCoverage.pricedEventCount += row.pricedEventCount;
    directCoverage.unpricedEventCount += row.unpricedEventCount;
    directCoverage.unclassifiedCostEventCount +=
      row.unclassifiedCostEventCount;
    directCoverageByProjectId.set(projectId, directCoverage);
    directByProjectId.set(projectId, (directByProjectId.get(projectId) ?? 0) + row.costUsd);
    const providerOwner = resolveProviderIdentity(
      row.provider,
      projectProviderCandidates
    );
    if (providerOwner) {
      attributedByProviderId.set(
        providerOwner.id,
        (attributedByProviderId.get(providerOwner.id) ?? 0) + row.costUsd
      );
      if (row.metricType !== "subscription") {
        const byProject =
          directVariableByProviderProjectId.get(providerOwner.id) ??
          new Map<string, number>();
        byProject.set(projectId, (byProject.get(projectId) ?? 0) + row.costUsd);
        directVariableByProviderProjectId.set(providerOwner.id, byProject);
        totalDirectVariableByProviderId.set(
          providerOwner.id,
          (totalDirectVariableByProviderId.get(providerOwner.id) ?? 0) + row.costUsd
        );
      }
    }
    if (row.metricType === "subscription") {
      directFixedByProjectId.set(
        projectId,
        (directFixedByProjectId.get(projectId) ?? 0) + row.costUsd
      );
      if (providerOwner) {
        attributedFixedByProviderId.set(
          providerOwner.id,
          (attributedFixedByProviderId.get(providerOwner.id) ?? 0) + row.costUsd
        );
      }
    }
  }

  // A prepaid receipt is a lumpy cash event, not a daily consumption sample.
  // When it covers observed variable usage, apportion that non-forecastable
  // amount first across directly attributed usage and then across the residual
  // that percentage allocations distribute. This keeps the project view
  // consistent with the provider forecast without double-counting receipts.
  const receiptBackedVariableByProviderId = new Map<string, number>();
  const directReceiptBackedByProjectId = new Map<string, number>();
  const directReceiptBackedByProviderId = new Map<string, number>();
  for (const provider of providerStatus.providers) {
    if (provider.receiptCashPaidUsd < provider.observedVariableUsageUsd) continue;
    const receiptBackedVariableUsd = Math.min(
      Math.max(0, provider.spentUsd - provider.fixedAccruedUsd),
      provider.receiptCashPaidUsd
    );
    if (receiptBackedVariableUsd <= 0) continue;
    receiptBackedVariableByProviderId.set(provider.id, receiptBackedVariableUsd);
    const totalDirectVariable = totalDirectVariableByProviderId.get(provider.id) ?? 0;
    const directCovered = Math.min(receiptBackedVariableUsd, totalDirectVariable);
    directReceiptBackedByProviderId.set(provider.id, directCovered);
    if (directCovered <= 0 || totalDirectVariable <= 0) continue;
    for (const [projectId, directVariable] of
      directVariableByProviderProjectId.get(provider.id) ?? []) {
      directReceiptBackedByProjectId.set(
        projectId,
        (directReceiptBackedByProjectId.get(projectId) ?? 0) +
          directCovered * (directVariable / totalDirectVariable)
      );
    }
  }

  const projectStatuses: ProjectBudgetStatus[] = projects.map((proj) => {
    // 1. Direct per-event attribution (projectId, plus legacy name match).
    const directUsd = directByProjectId.get(proj.id) ?? 0;
    const directFixedUsd = directFixedByProjectId.get(proj.id) ?? 0;

    // 2. Percentage allocation of each provider's residual — the spend NOT
    // already directly attributed to any project (fixed fees, poll-snapshot
    // usage, and any untagged pushed telemetry).
    let allocatedUsd = 0;
    let allocatedFixedUsd = 0;
    let allocatedReceiptBackedUsd = 0;
    let allocatedHasKnownCost = false;
    let allocatedHasCurrentUnknownCost = false;
    let allocatedHasLegacyUnknownCost = false;
    let incompleteAllocatedProviderCount = 0;
    for (const alloc of proj.allocations) {
      const provider = providerById.get(alloc.providerId);
      if (!provider) continue;
      const attributed = attributedByProviderId.get(provider.id) ?? 0;
      const residual = Math.max(0, provider.spentUsd - attributed);
      const attributedFixed = attributedFixedByProviderId.get(provider.id) ?? 0;
      const fixedResidual = Math.max(0, provider.fixedAccruedUsd - attributedFixed);
      const ratio = Math.max(0, Math.min(100, alloc.percentage)) / 100;
      if (ratio <= 0) continue;
      allocatedUsd += residual * ratio;
      allocatedFixedUsd += Math.min(residual, fixedResidual) * ratio;
      const receiptBackedResidual = Math.max(
        0,
        (receiptBackedVariableByProviderId.get(provider.id) ?? 0) -
          (directReceiptBackedByProviderId.get(provider.id) ?? 0)
      );
      allocatedReceiptBackedUsd +=
        Math.min(residual, receiptBackedResidual) * ratio;
      if (provider.spendCoverage === "complete") {
        allocatedHasKnownCost = true;
      } else {
        incompleteAllocatedProviderCount += 1;
        if (provider.spendCoverage === "partial") {
          allocatedHasKnownCost = true;
        }
        if (
          provider.spendCoverage === "legacy_unknown" ||
          provider.pushedUnclassifiedCostEventCount > 0
        ) {
          allocatedHasLegacyUnknownCost = true;
        }
        if (
          provider.spendCoverage !== "legacy_unknown" ||
          provider.pushedUnpricedEventCount > 0
        ) {
          allocatedHasCurrentUnknownCost = true;
        }
      }
    }

    const spentUsd = directUsd + allocatedUsd;
    const directReceiptBackedUsd =
      directReceiptBackedByProjectId.get(proj.id) ?? 0;
    const directCoverage = directCoverageByProjectId.get(proj.id) ?? {
      pricedEventCount: 0,
      unpricedEventCount: 0,
      unclassifiedCostEventCount: 0,
    };
    const hasKnownCost =
      directCoverage.pricedEventCount > 0 || allocatedHasKnownCost;
    const hasCurrentUnknownCost =
      directCoverage.unpricedEventCount > 0 || allocatedHasCurrentUnknownCost;
    const hasLegacyUnknownCost =
      directCoverage.unclassifiedCostEventCount > 0 ||
      allocatedHasLegacyUnknownCost;
    const hasUnknownCost = hasCurrentUnknownCost || hasLegacyUnknownCost;
    const spendCoverage: CostCoverage = hasUnknownCost
      ? hasKnownCost
        ? "partial"
        : hasLegacyUnknownCost && !hasCurrentUnknownCost
          ? "legacy_unknown"
          : "unknown"
      : hasKnownCost
        ? "complete"
        : "unknown";

    let status: BudgetStatusLevel;
    let remainingUsd: number | null;
    let percentUsed: number | null;
    if (proj.monthlyBudgetUsd == null || proj.monthlyBudgetUsd <= 0) {
      status = "unconfigured";
      remainingUsd = null;
      percentUsed = null;
    } else {
      remainingUsd = proj.monthlyBudgetUsd - spentUsd;
      percentUsed = spentUsd / proj.monthlyBudgetUsd;
      status =
        spentUsd >= proj.monthlyBudgetUsd
          ? "exceeded"
          : spentUsd >= proj.monthlyBudgetUsd * WARNING_RATIO
            ? "warning"
            : "ok";
    }

    return {
      id: proj.id,
      name: proj.name,
      description: proj.description,
      monthlyBudgetUsd: proj.monthlyBudgetUsd,
      spentUsd,
      projectedEomUsd: calculateEomForecast(
        spentUsd,
        Math.min(
          spentUsd,
          directFixedUsd +
            allocatedFixedUsd +
            directReceiptBackedUsd +
            allocatedReceiptBackedUsd
        ),
        now
      ),
      spendCoverage,
      ...directCoverage,
      incompleteAllocatedProviderCount,
      directUsd,
      allocatedUsd,
      remainingUsd,
      percentUsed,
      status,
    };
  });

  const budgeted = projectStatuses.filter((p) => p.monthlyBudgetUsd != null && p.monthlyBudgetUsd > 0);
  const totalBudgetUsd = budgeted.reduce((s, p) => s + (p.monthlyBudgetUsd ?? 0), 0);
  const budgetedSpentUsd = budgeted.reduce((s, p) => s + p.spentUsd, 0);
  const attributedProjectSpentUsd = projectStatuses.reduce((s, p) => s + p.spentUsd, 0);
  // Provider totals are the money source of truth. Project rows are an
  // attribution view and may intentionally leave some provider spend
  // unassigned (or be over-allocated by operator configuration), so never
  // derive the app-wide total from only the visible project rows.
  const totalSpentUsd = providerStatus.summary.totalSpentUsd;
  const unassignedSpentUsd = Math.max(0, totalSpentUsd - attributedProjectSpentUsd);

  return {
    ok: true,
    generatedAt: now.toISOString(),
    month: monthLabel(now),
    providers: providerStatus.providers,
    projects: projectStatuses,
    summary: {
      totalBudgetUsd,
      budgetedSpentUsd,
      unbudgetedSpentUsd: Math.max(0, totalSpentUsd - budgetedSpentUsd),
      unassignedSpentUsd,
      totalSpentUsd,
      estimatedApiEquivalentUsd: providerStatus.summary.estimatedApiEquivalentUsd,
      remainingUsd: totalBudgetUsd - budgetedSpentUsd,
      percentUsed: totalBudgetUsd > 0 ? budgetedSpentUsd / totalBudgetUsd : null,
      overBudget: projectStatuses.some((p) => p.status === "exceeded"),
      warning: projectStatuses.some((p) => p.status === "warning"),
    },
  };
}

// Wraps computeProjectBudgetStatusUncached with the same generic SWR cache
// used for computeBudgetStatus above (same key function, same shared TTL
// knob). This is FIX 1 for GET /api/projects and GET /api/budget-status:
// both routes call only computeProjectBudgetStatus, never computeBudgetStatus
// directly, so caching computeBudgetStatus alone left their own
// sumMonthToDateExternalCostAttribution call fully exposed to the same
// ~11.4s current-month live-group cost. Caching this function's OUTPUT
// covers that call (and, transitively, the now-fast cached
// computeBudgetStatus call it also makes) in one place.
const projectBudgetStatusSwrCache = createStaleWhileRevalidateCache<ProjectBudgetStatusResponse>({
  label: "project-budget-status-cache",
  compute: computeProjectBudgetStatusUncached,
  keyFor: budgetStatusCacheKey,
  ttlMs: budgetStatusCacheTtlMs,
});

/** Test-only: force the project cache on/off regardless of the Vitest-default gate. Pass null to restore the default. */
export function __setProjectBudgetStatusCacheOverrideForTests(enabled: boolean | null): void {
  projectBudgetStatusSwrCache.setOverrideForTests(enabled);
}

/** Test-only: drop any cached project value/in-flight refresh so the next call recomputes from scratch. */
export function __resetProjectBudgetStatusCacheForTests(): void {
  projectBudgetStatusSwrCache.resetForTests();
}

export async function computeProjectBudgetStatus(now: Date = new Date()): Promise<ProjectBudgetStatusResponse> {
  return projectBudgetStatusSwrCache.get(now);
}
