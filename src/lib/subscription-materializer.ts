import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  persistExternalUsageEventsInTransaction,
  type ExternalUsageEventInput,
} from "@/lib/external-usage-events";
import {
  SUBSCRIPTION_SOURCE_APP,
  subscriptionChargeIdempotencyKey,
} from "@/lib/subscription-charge-identity";
import {
  advancePeriod,
  isAmbiguousSubscriptionPeriodWindow,
  isSubscriptionInterval,
  type SubscriptionInterval,
} from "@/lib/subscriptions";

// Turns each active subscription's elapsed billing periods into synthetic
// ExternalUsageEvent rows (metricType="subscription"), so recurring fees flow
// through the SAME month-to-date sums, daily rollups, per-project attribution,
// and budgets as metered usage — no special-casing in budget-status.
//
// Idempotent two ways: every charge's idempotencyKey is a hash of
// (subscriptionId, periodStart), and the subscription tracks a
// lastChargedPeriodStart watermark. Re-running never double-charges a period
// (the upsert is a no-op on a seen key), so it's safe to call on every
// maintenance cycle.
//
// The event's `provider` string is the provider's (already lowercased) name so
// the charge aggregates under that provider exactly like pushed usage; its
// `projectId` is the subscription's, so per-project budgets pick it up.

// Guard against a subscription whose startDate is far in the past generating an
// unbounded backfill in one pass.
const MAX_PERIODS_PER_RUN = 240;

function isReceiptBackedSubscriptionCharge(
  subscription: Pick<
    SubscriptionChargePlanInput,
    "externalBillingManaged" | "externalBillingSource" | "externalBillingId"
  >
): boolean {
  if (subscription.externalBillingManaged === true) return true;
  return Boolean(
    subscription.externalBillingSource?.trim() &&
      subscription.externalBillingId?.trim()
  );
}

export interface MaterializeSubscriptionsResult {
  examined: number;
  charged: number;
  eventsWritten: number;
  /** Managed rows paused because their stored period window is not an exact cadence. */
  ambiguousPaused: number;
  /**
   * S8: active rows skipped because they are denominated in a non-USD
   * currency. Non-USD amounts are NEVER materialized as USD; creation is
   * rejected at the API layer (subscription-input.ts), so any such row is a
   * legacy/direct-DB survivor and its suppression is surfaced loudly (warn
   * log + this count + a billing_sync_incomplete budget alert). Optional so
   * partial maintenance-result mocks in other lanes' tests keep compiling;
   * materializeDueSubscriptions always populates it.
   */
  nonUsdSkipped?: number;
}

interface SubscriptionChargePlanInput {
  id: string;
  name: string;
  costUsd: number;
  currency: string;
  interval: string;
  intervalCount: number;
  projectId: string | null;
  autoRenew: boolean;
  currentPeriodStart: Date;
  nextRenewalAt: Date;
  lastChargedPeriodStart: Date | null;
  /** Provider-linked rows are receipt-backed.  Catalog/seeded rows are modeled. */
  externalBillingManaged?: boolean;
  /** Linked-but-unmanaged (Cloudflare legacy handoff) is also receipt-backed. */
  externalBillingSource?: string | null;
  externalBillingId?: string | null;
  provider: { name: string; refreshIntervalMin?: number };
}

interface DueSubscription extends SubscriptionChargePlanInput {
  providerId: string;
  externalAdoptionGuardKey: string | null;
  externalBillingSource: string | null;
  externalBillingId: string | null;
  externalBillingManaged: boolean;
}

interface ChargeCorrectionProof {
  managedSubscriptionId: string;
  source: string;
  externalId: string;
  correctedPeriodStart: Date;
  correctedPeriodEnd: Date;
  correctedGuardKey: string;
}

interface ChargePlan {
  inputs: ExternalUsageEventInput[];
  currentPeriodStart: Date;
  nextRenewalAt: Date;
  lastChargedPeriodStart: Date;
}

// Pure planning step (exported for tests): given a subscription and `now`,
// returns the charges to emit and the advanced cycle fields. Charges every
// period whose start is at or before `now` and past the watermark.
export function planSubscriptionCharges(
  subscription: SubscriptionChargePlanInput,
  now: Date
): ChargePlan | null {
  const interval: SubscriptionInterval = isSubscriptionInterval(subscription.interval)
    ? subscription.interval
    : "monthly";
  const intervalCount = Math.max(1, Math.trunc(subscription.intervalCount));

  const inputs: ExternalUsageEventInput[] = [];
  let periodStart = subscription.currentPeriodStart;
  let lastCharged = subscription.lastChargedPeriodStart;
  let latestStarted = subscription.currentPeriodStart;
  const cadencePeriodEnd = advancePeriod(periodStart, interval, intervalCount);
  let nextRenewalAt =
    subscription.nextRenewalAt.getTime() > periodStart.getTime()
      ? new Date(
          Math.min(
            subscription.nextRenewalAt.getTime(),
            cadencePeriodEnd.getTime()
          )
        )
      : cadencePeriodEnd;
  let latestPeriodEnd = nextRenewalAt;
  let guard = 0;

  while (periodStart.getTime() <= now.getTime() && guard < MAX_PERIODS_PER_RUN) {
    guard += 1;
    const periodEnd = nextRenewalAt;

    if (!lastCharged || periodStart.getTime() > lastCharged.getTime()) {
      const providerLinked = isReceiptBackedSubscriptionCharge(subscription);
      inputs.push({
        idempotencyKey: subscriptionChargeIdempotencyKey(
          subscription.id,
          periodStart
        ),
        sourceApp: SUBSCRIPTION_SOURCE_APP,
        provider: subscription.provider.name,
        projectId: subscription.projectId,
        service: subscription.name,
        label: subscription.name,
        billingMode: "manual",
        metricType: "subscription",
        unit: "usd",
        costUsd: subscription.costUsd,
        // Only an authoritative provider period (or an already-linked
        // Cloudflare legacy row waiting for handoff) is cash.  Seeded /
        // owner-typed catalog rows stay estimated so the dashboard cannot
        // call them paid.
        confidence: providerLinked ? "actual" : "estimated",
        occurredAt: periodStart,
        windowStart: periodStart,
        windowEnd: periodEnd,
        metadata: {
          subscriptionId: subscription.id,
          subscriptionName: subscription.name,
          interval,
          intervalCount,
          currency: subscription.currency,
          // Extra keys stay off receipt-backed rows: Cloudflare handoff
          // proof requires the exact 5-key metadata set.
          ...(providerLinked
            ? {}
            : { modeled: true, chargeBasis: "modeled" }),
        },
      });
      lastCharged = periodStart;
    }

    latestStarted = periodStart;
    latestPeriodEnd = periodEnd;
    // A non-auto-renewing subscription is charged for exactly the one term it
    // is in and then stops — never advance into (or charge) a following period.
    if (!subscription.autoRenew) break;
    if (periodEnd.getTime() > now.getTime()) break;
    periodStart = periodEnd;
    nextRenewalAt = advancePeriod(periodStart, interval, intervalCount);
  }

  if (inputs.length === 0) return null;

  return {
    inputs,
    currentPeriodStart: latestStarted,
    nextRenewalAt: latestPeriodEnd,
    lastChargedPeriodStart: lastCharged as Date,
  };
}

function conflictingManagedPeriodStarts(
  subscription: DueSubscription,
  plan: ChargePlan,
  correctionProofs: ChargeCorrectionProof[]
): Set<number> {
  const periodStarts = new Set<number>();
  const guardKey = subscription.externalAdoptionGuardKey;
  const externalBillingSource = subscription.externalBillingSource;
  const externalBillingId = subscription.externalBillingId;
  if (
    !guardKey ||
    subscription.externalBillingManaged !== false ||
    !externalBillingSource ||
    !externalBillingId
  ) {
    return periodStarts;
  }

  for (const proof of correctionProofs) {
    if (
      proof.managedSubscriptionId === subscription.id ||
      proof.correctedGuardKey !== guardKey ||
      proof.source !== externalBillingSource ||
      proof.externalId !== externalBillingId
    ) {
      continue;
    }
    if (
      plan.inputs.some(
        (input) =>
          input.windowStart?.getTime() ===
            proof.correctedPeriodStart.getTime() &&
          input.windowEnd?.getTime() === proof.correctedPeriodEnd.getTime()
      )
    ) {
      periodStarts.add(proof.correctedPeriodStart.getTime());
    }
  }
  return periodStarts;
}

export type SettleSubscriptionResult =
  | { outcome: "skipped" }
  | { outcome: "non_usd"; name: string; currency: string }
  | { outcome: "ambiguous_paused" }
  | { outcome: "charged"; charged: number; eventsWritten: number };

export async function settleSubscriptionCharges(
  subscriptionId: string,
  now: Date
): Promise<SettleSubscriptionResult> {
  return prisma.$transaction(
    async (tx) => {
      // SQLite interactive transactions begin deferred. Take the writer lock
      // before re-reading the guarded row and its collision provenance so a
      // concurrent owner edit cannot be mistaken for the state we settle.
      await tx.$executeRaw`
        UPDATE "Subscription"
        SET "costUsd" = "costUsd"
        WHERE "id" = ${subscriptionId}
      `;
      const subscription = await tx.subscription.findFirst({
        where: {
          id: subscriptionId,
          status: "active",
          currentPeriodStart: { lte: now },
        },
        select: {
          id: true,
          providerId: true,
          externalAdoptionGuardKey: true,
          externalBillingSource: true,
          externalBillingId: true,
          externalBillingManaged: true,
          name: true,
          costUsd: true,
          currency: true,
          interval: true,
          intervalCount: true,
          projectId: true,
          autoRenew: true,
          status: true,
          currentPeriodStart: true,
          nextRenewalAt: true,
          lastChargedPeriodStart: true,
          provider: {
            select: { name: true, refreshIntervalMin: true },
          },
        },
      });
      if (!subscription) return { outcome: "skipped" };

      // S8: never charge a non-USD-denominated subscription AS USD.
      if (subscription.currency.toUpperCase() !== "USD") {
        return {
          outcome: "non_usd",
          name: subscription.name,
          currency: subscription.currency,
        };
      }

      // External-managed rows with a non-exact period window are mid-period /
      // provider-skew evidence — pause and skip inventing charges.
      if (subscription.externalBillingManaged) {
        const interval: SubscriptionInterval = isSubscriptionInterval(
          subscription.interval
        )
          ? subscription.interval
          : "monthly";
        const intervalCount = Math.max(1, Math.trunc(subscription.intervalCount));
        const legacyHandoffId =
          process.env.CLOUDFLARE_LEGACY_HANDOFF_SUBSCRIPTION_ID?.trim() ?? "";
        const allowUtcMidnightCalendarException =
          legacyHandoffId.length > 0 && legacyHandoffId === subscription.id;
        if (
          isAmbiguousSubscriptionPeriodWindow(
            subscription.currentPeriodStart,
            subscription.nextRenewalAt,
            interval,
            intervalCount,
            { allowUtcMidnightCalendarException }
          )
        ) {
          await tx.subscription.update({
            where: { id: subscription.id },
            data: { status: "paused", canceledAt: null, autoRenew: false },
          });
          return { outcome: "ambiguous_paused" };
        }
      }

      const plan = planSubscriptionCharges(subscription, now);
      if (!plan) return { outcome: "skipped" };

      let inputsToPersist = plan.inputs;
      if (
        subscription.externalAdoptionGuardKey &&
        subscription.externalBillingManaged === false &&
        subscription.externalBillingSource &&
        subscription.externalBillingId
      ) {
        const correctionProofs =
          await tx.externalBillingChargeCorrection.findMany({
            where: {
              providerId: subscription.providerId,
              correctedGuardKey: subscription.externalAdoptionGuardKey,
              source: subscription.externalBillingSource,
              externalId: subscription.externalBillingId,
            },
            select: {
              managedSubscriptionId: true,
              source: true,
              externalId: true,
              correctedPeriodStart: true,
              correctedPeriodEnd: true,
              correctedGuardKey: true,
            },
          });
        const settledPeriodStarts = conflictingManagedPeriodStarts(
          subscription,
          plan,
          correctionProofs
        );
        if (settledPeriodStarts.size > 0) {
          inputsToPersist = plan.inputs.filter(
            (input) =>
              !settledPeriodStarts.has(input.windowStart?.getTime() ?? Number.NaN)
          );
        }
      }

      const persisted = await persistExternalUsageEventsInTransaction(
        tx,
        inputsToPersist
      );

      // Optimistic revision predicate: ensure status is still active and
      // lastChargedPeriodStart matches what was read under the writer lock.
      const applied = await tx.subscription.updateMany({
        where: {
          id: subscription.id,
          status: "active",
          lastChargedPeriodStart: subscription.lastChargedPeriodStart,
        },
        data: {
          currentPeriodStart: plan.currentPeriodStart,
          nextRenewalAt: plan.nextRenewalAt,
          lastChargedPeriodStart: plan.lastChargedPeriodStart,
        },
      });

      if (applied.count !== 1) {
        throw new Error("subscription changed under materializer");
      }

      return {
        outcome: "charged",
        charged: inputsToPersist.length > 0 ? 1 : 0,
        eventsWritten: persisted.persisted,
      };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 5_000,
      timeout: 30_000,
    }
  );
}

export async function materializeDueSubscriptions(
  now: Date = new Date(),
  options: { beforeTransactionalRecheck?: () => Promise<void> } = {}
): Promise<MaterializeSubscriptionsResult> {
  const subscriptions = await prisma.subscription.findMany({
    where: { status: "active", currentPeriodStart: { lte: now } },
    select: { id: true },
  });

  let charged = 0;
  let eventsWritten = 0;
  let ambiguousPaused = 0;
  let nonUsdSkipped = 0;

  for (const { id } of subscriptions) {
    if (options.beforeTransactionalRecheck) {
      await options.beforeTransactionalRecheck();
    }
    const result = await settleSubscriptionCharges(id, now);
    if (result.outcome === "non_usd") {
      console.warn(
        `[subscription-materializer] suppressing non-USD subscription ${id} (${result.name}, currency=${result.currency}): charges are skipped, never charged as USD, until authoritative FX conversion exists`
      );
      nonUsdSkipped += 1;
    } else if (result.outcome === "ambiguous_paused") {
      ambiguousPaused += 1;
    } else if (result.outcome === "charged") {
      charged += result.charged;
      eventsWritten += result.eventsWritten;
    }
  }

  return {
    examined: subscriptions.length,
    charged,
    eventsWritten,
    ambiguousPaused,
    nonUsdSkipped,
  };
}

const MANUAL_ADJUSTMENT_SOURCE_APP = "manual-billing-adjustment";

function metadataString(
  metadata: Prisma.JsonValue | null | undefined,
  key: string
): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function metadataFlag(
  metadata: Prisma.JsonValue | null | undefined,
  key: string
): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return false;
  }
  return (metadata as Record<string, unknown>)[key] === true;
}

/** Catalog / seed charges.  Receipt-backed Cloudflare-legacy rows stay cash. */
function isModeledSubscriptionCharge(
  metadata: Prisma.JsonValue | null | undefined,
  confidence: string
): boolean {
  return (
    confidence === "estimated" ||
    metadataFlag(metadata, "modeled") ||
    metadataString(metadata, "chargeBasis") === "modeled"
  );
}

export interface RetractSubscriptionChargesOptions {
  /**
   * One-time ghost repair may delete invented pre-#1307 `actual` seed
   * charges.  Pause / delete must not: those paths keep receipt-backed
   * 5-key Cloudflare handoff rows.
   */
  includeReceiptBacked?: boolean;
}

/**
 * Remove modeled materializer rows (and matching owner void adjustments) for
 * one subscription.  Pause / cancel / considering must not leave invented
 * cash in month-to-date spend.  Caller decides the new status / watermark.
 */
export async function retractSubscriptionChargesInTransaction(
  tx: Prisma.TransactionClient,
  subscriptionId: string,
  options: RetractSubscriptionChargesOptions = {}
): Promise<{ deleted: number }> {
  const includeReceiptBacked = options.includeReceiptBacked === true;
  const candidates = await tx.externalUsageEvent.findMany({
    where: {
      sourceApp: { in: [SUBSCRIPTION_SOURCE_APP, MANUAL_ADJUSTMENT_SOURCE_APP] },
    },
    select: { id: true, sourceApp: true, confidence: true, metadata: true },
  });
  const ids = candidates
    .filter((event) => {
      if (event.sourceApp === SUBSCRIPTION_SOURCE_APP) {
        if (metadataString(event.metadata, "subscriptionId") !== subscriptionId) {
          return false;
        }
        return (
          includeReceiptBacked ||
          isModeledSubscriptionCharge(event.metadata, event.confidence)
        );
      }
      if (metadataString(event.metadata, "voidsSubscriptionId") !== subscriptionId) {
        return false;
      }
      return (
        includeReceiptBacked ||
        isModeledSubscriptionCharge(event.metadata, event.confidence) ||
        metadataFlag(event.metadata, "estimate")
      );
    })
    .map((event) => event.id);
  if (ids.length === 0) return { deleted: 0 };
  const deleted = await tx.externalUsageEvent.deleteMany({
    where: { id: { in: ids } },
  });
  return { deleted: deleted.count };
}

export async function retractSubscriptionCharges(
  subscriptionId: string,
  options: RetractSubscriptionChargesOptions = {}
): Promise<{ deleted: number }> {
  return prisma.$transaction((tx) =>
    retractSubscriptionChargesInTransaction(tx, subscriptionId, options)
  );
}
