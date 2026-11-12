import { Prisma } from "@prisma/client";
import {
  externalBillingFreshnessWindowMs,
  type ExternalBillingLinkCandidateRecord,
  hasExactExternalBillingCadencePeriod,
  isExternalBillingLinkCandidate,
  normalizeExternalBillingCadence,
  resolveExternalBillingPeriod,
} from "@/lib/external-billing-link";
import { prisma } from "@/lib/prisma";
import {
  SUBSCRIPTION_SOURCE_APP,
  subscriptionChargeIdempotencyKey,
} from "@/lib/subscription-charge-identity";
import {
  advancePeriod,
  type SubscriptionInterval,
} from "@/lib/subscriptions";

export interface AdoptExternalBillingSubscriptionsResult {
  examined: number;
  eligible: number;
  adopted: number;
  existing: number;
  ambiguous: number;
  reconciled: number;
  deactivated: number;
  raced: number;
  cloudflareLegacyHandoff: CloudflareLegacyHandoffStatus;
}

export type CloudflareLegacyHandoffStatus =
  | "disabled"
  | "invalid_target"
  | "not_found"
  | "wrong_provider"
  | "wrong_identity"
  | "already_managed"
  | "owner_guard_present"
  | "provider_plan_conflict"
  | "external_billing_ineligible"
  | "term_mismatch"
  | "guard_collision"
  | "charge_proof_missing"
  | "handed_off"
  | "not_run";

export interface ExternalBillingSubscriptionAdoptionOptions {
  /** Test-only synchronization point after preflight and before DB write lock. */
  beforeTransactionalRecheck?: () => Promise<void>;
  /** Test-only synchronization point while the SQLite writer lock is held. */
  afterTransactionalRecheck?: () => Promise<void>;
}

export interface PaidRecurringAdoptionRecord
  extends ExternalBillingLinkCandidateRecord {
  source: string;
  externalId: string;
  paidRecurringAuthoritative: boolean;
  serviceName: string | null;
  planName: string | null;
  dateKind: string | null;
  nextRenewalAt: string | Date | null;
}

export interface PaidRecurringAdoptionCandidate {
  providerId: string;
  source: string;
  externalId: string;
  serviceName: string;
  planName: string | null;
  amountUsd: number;
  amountCents: number;
  cadence: SubscriptionInterval;
  periodStart: Date;
  periodEnd: Date;
  guardKey: string;
  observedAt: Date;
}

const providerStateSelect = {
  id: true,
  name: true,
  type: true,
  isActive: true,
  refreshIntervalMin: true,
  plan: { select: { fixedMonthlyCostUsd: true } },
  subscriptions: {
    select: {
      id: true,
      projectId: true,
      externalBillingSource: true,
      externalBillingId: true,
      externalBillingManaged: true,
      externalAdoptionGuardKey: true,
      name: true,
      costUsd: true,
      currency: true,
      interval: true,
      intervalCount: true,
      currentPeriodStart: true,
      nextRenewalAt: true,
      lastChargedPeriodStart: true,
      autoRenew: true,
      status: true,
      canceledAt: true,
    },
  },
  externalBilling: {
    orderBy: { externalId: "asc" as const },
    select: {
      source: true,
      externalId: true,
      paidRecurringAuthoritative: true,
      kind: true,
      serviceName: true,
      planName: true,
      status: true,
      amountUsd: true,
      currency: true,
      billingInterval: true,
      currentPeriodStart: true,
      currentPeriodEnd: true,
      nextRenewalAt: true,
      rollupRole: true,
      dateKind: true,
      syncedAt: true,
    },
  },
} satisfies Prisma.ProviderSelect;

type ProviderState = Prisma.ProviderGetPayload<{
  select: typeof providerStateSelect;
}>;
type AdoptionTransaction = Prisma.TransactionClient;

type AdoptionCandidate = PaidRecurringAdoptionCandidate;

interface CloudflareLegacyHandoffConfig {
  targetId: string | null;
  initialStatus: "disabled" | "invalid_target" | "not_found";
}

const CLOUDFLARE_LEGACY_SOURCE = "cloudflare-subscriptions";
const CLOUDFLARE_LEGACY_DISPLAY_NAME =
  "Cloudflare Workers Paid (Congress.Trade)";
const CLOUDFLARE_LEGACY_SERVICE_NAME = "Workers Paid";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const TERMINAL_STATUSES = new Set([
  "canceled",
  "cancelled",
  "disabled",
  "expired",
  "failed",
  "inactive",
  "payment_failed",
  "unpaid",
]);

function cleanLabel(value: string | null): string | null {
  const label = value?.trim();
  return label || null;
}

function cloudflareLegacyHandoffConfig(): CloudflareLegacyHandoffConfig {
  const configured =
    process.env.CLOUDFLARE_LEGACY_HANDOFF_SUBSCRIPTION_ID?.trim() ?? "";
  if (!configured) return { targetId: null, initialStatus: "disabled" };
  if (!UUID_PATTERN.test(configured)) {
    return { targetId: null, initialStatus: "invalid_target" };
  }
  return { targetId: configured, initialStatus: "not_found" };
}

const USD_MINOR_UNIT_TOLERANCE = 1e-6;

/** Reject provider amounts that are not exact USD minor units. */
export function exactUsdCents(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const scaled = value * 100;
  const cents = Math.round(scaled);
  return Number.isSafeInteger(cents) &&
    Math.abs(scaled - cents) <= USD_MINOR_UNIT_TOLERANCE
    ? cents
    : null;
}

/** Treat any values rounding to the same cent as ambiguous/equivalent. */
export function conservativeUsdCents(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

function externalKey(source: string, externalId: string): string {
  return `${source}\u0000${externalId}`;
}

export function externalAdoptionGuardKey(
  providerId: string,
  amountCents: number,
  cadence: SubscriptionInterval
): string {
  return `external-paid-recurring:${providerId}:${cadence}:${amountCents}`;
}

function candidateShapeKey(candidate: AdoptionCandidate): string {
  return candidate.guardKey;
}

export function paidRecurringAdoptionCandidate(
  providerId: string,
  refreshIntervalMin: number,
  record: PaidRecurringAdoptionRecord,
  now: Date
): PaidRecurringAdoptionCandidate | null {
  const amountCents = exactUsdCents(record.amountUsd);
  const serviceName = cleanLabel(record.serviceName) ?? cleanLabel(record.planName);
  if (
    record.paidRecurringAuthoritative !== true ||
    record.rollupRole?.trim().toLowerCase() !== "canonical" ||
    !["renewal", "period_end"].includes(
      record.dateKind?.trim().toLowerCase() ?? ""
    ) ||
    amountCents == null ||
    amountCents <= 0 ||
    !serviceName ||
    !hasExactExternalBillingCadencePeriod(record) ||
    !isExternalBillingLinkCandidate(record, {
      now,
      staleAfterMs: externalBillingFreshnessWindowMs(
        refreshIntervalMin
      ),
    })
  ) {
    return null;
  }

  const cadence = normalizeExternalBillingCadence(record.billingInterval);
  const period = resolveExternalBillingPeriod(record);
  const observedAt =
    record.syncedAt instanceof Date
      ? record.syncedAt
      : new Date(record.syncedAt);
  if (!cadence || !period || !Number.isFinite(observedAt.getTime())) return null;

  return {
    providerId,
    source: record.source,
    externalId: record.externalId,
    serviceName,
    planName: cleanLabel(record.planName),
    amountUsd: amountCents / 100,
    amountCents,
    cadence,
    periodStart: period.start,
    periodEnd: period.end,
    guardKey: externalAdoptionGuardKey(providerId, amountCents, cadence),
    observedAt,
  };
}

function asRecord(value: Prisma.JsonValue | null): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function findExternalAdoptionGuardKeyForCharge(input: {
  providerId: string;
  refreshIntervalMin: number;
  externalBillingSource: string | null;
  externalBillingId: string | null;
  costUsd: number;
  currency: string;
  interval: string;
  intervalCount: number;
  now?: Date;
}, db: Pick<Prisma.TransactionClient, "providerExternalBilling"> = prisma): Promise<string | null> {
  const cadence = normalizeExternalBillingCadence(input.interval);
  const cents = conservativeUsdCents(input.costUsd);
  if (
    !input.externalBillingSource ||
    !input.externalBillingId ||
    input.currency.trim().toUpperCase() !== "USD" ||
    input.intervalCount !== 1 ||
    !cadence ||
    cents == null
  ) {
    return null;
  }

  // Re-read the exact declared identity in the caller's final write
  // transaction. If an adapter refresh deleted or weakened it, return null
  // (additive) rather than borrowing another same-shaped provider record.
  const record = await db.providerExternalBilling.findUnique({
    where: {
      providerId_source_externalId: {
        providerId: input.providerId,
        source: input.externalBillingSource,
        externalId: input.externalBillingId,
      },
    },
    select: providerStateSelect.externalBilling.select,
  });
  if (!record) return null;
  const now = input.now ?? new Date();
  const matching = paidRecurringAdoptionCandidate(
    input.providerId,
    input.refreshIntervalMin,
    record,
    now
  );
  return matching?.cadence === cadence && matching.amountCents === cents
    ? matching.guardKey
    : null;
}

function hasExistingRecurringCharge(
  candidate: AdoptionCandidate,
  subscriptions: ProviderState["subscriptions"]
): boolean {
  return subscriptions.some((subscription) => {
    const cadence = normalizeExternalBillingCadence(subscription.interval);
    return (
      subscription.currency.trim().toUpperCase() === "USD" &&
      subscription.intervalCount === 1 &&
      cadence === candidate.cadence &&
      conservativeUsdCents(subscription.costUsd) === candidate.amountCents
    );
  });
}

function conflictsWithProviderPlan(
  fixedMonthlyCostUsd: number | null | undefined
): boolean {
  return (
    fixedMonthlyCostUsd != null &&
    Number.isFinite(fixedMonthlyCostUsd) &&
    fixedMonthlyCostUsd > 0
  );
}

function billingTimestamp(value: Date | string | null): Date | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

/**
 * Cloudflare reports paid Workers renewals at UTC midnight on the correct
 * calendar renewal date even when current_period_start includes a creation
 * time. That explicit provider window is not an exact calendar-month duration,
 * so it stays ineligible for general automatic adoption. The one-time guarded
 * legacy handoff may use it only when every Cloudflare-specific invariant is
 * exact and the explicit end is midnight on the calendar date produced by
 * advancing the start one month.
 */
function cloudflareLegacyHandoffCandidate(
  providerId: string,
  refreshIntervalMin: number,
  record: PaidRecurringAdoptionRecord,
  now: Date
): PaidRecurringAdoptionCandidate | null {
  const amountCents = exactUsdCents(record.amountUsd);
  const cadence = normalizeExternalBillingCadence(record.billingInterval);
  const periodStart = billingTimestamp(record.currentPeriodStart);
  const periodEnd = billingTimestamp(record.currentPeriodEnd);
  const nextRenewalAt = billingTimestamp(record.nextRenewalAt);
  if (
    record.source !== CLOUDFLARE_LEGACY_SOURCE ||
    record.paidRecurringAuthoritative !== true ||
    record.kind.trim().toLowerCase() !== "subscription" ||
    cleanLabel(record.serviceName) !== CLOUDFLARE_LEGACY_SERVICE_NAME ||
    record.status?.trim().toLowerCase() !== "paid" ||
    record.rollupRole?.trim().toLowerCase() !== "canonical" ||
    record.dateKind?.trim().toLowerCase() !== "renewal" ||
    record.currency?.trim().toUpperCase() !== "USD" ||
    cadence !== "monthly" ||
    amountCents == null ||
    amountCents <= 0 ||
    !periodStart ||
    !periodEnd ||
    !nextRenewalAt ||
    nextRenewalAt.getTime() !== periodEnd.getTime() ||
    !isExternalBillingLinkCandidate(record, {
      now,
      staleAfterMs: externalBillingFreshnessWindowMs(refreshIntervalMin),
    })
  ) {
    return null;
  }

  const exactCadencePeriod = hasExactExternalBillingCadencePeriod(record);
  const calendarRenewal = advancePeriod(periodStart, "monthly", 1);
  const explicitMidnightRenewal =
    periodEnd.getUTCHours() === 0 &&
    periodEnd.getUTCMinutes() === 0 &&
    periodEnd.getUTCSeconds() === 0 &&
    periodEnd.getUTCMilliseconds() === 0 &&
    periodEnd.getUTCFullYear() === calendarRenewal.getUTCFullYear() &&
    periodEnd.getUTCMonth() === calendarRenewal.getUTCMonth() &&
    periodEnd.getUTCDate() === calendarRenewal.getUTCDate();
  if (!exactCadencePeriod && !explicitMidnightRenewal) {
    return null;
  }

  return {
    providerId,
    source: record.source,
    externalId: record.externalId,
    serviceName: CLOUDFLARE_LEGACY_SERVICE_NAME,
    planName: cleanLabel(record.planName),
    amountUsd: amountCents / 100,
    amountCents,
    cadence,
    periodStart,
    periodEnd,
    guardKey: externalAdoptionGuardKey(providerId, amountCents, cadence),
    observedAt:
      record.syncedAt instanceof Date
        ? record.syncedAt
        : new Date(record.syncedAt),
  };
}

function hasUniqueCloudflareLegacyHandoffShape(
  provider: ProviderState,
  candidatesByExternalKey: Map<string, AdoptionCandidate>,
  candidate: AdoptionCandidate,
  now: Date
): boolean {
  const identities = new Set<string>();
  for (const [candidateIdentity, other] of candidatesByExternalKey) {
    if (other.guardKey === candidate.guardKey) {
      identities.add(candidateIdentity);
    }
  }
  for (const record of provider.externalBilling) {
    const other = cloudflareLegacyHandoffCandidate(
      provider.id,
      provider.refreshIntervalMin,
      record,
      now
    );
    if (other?.guardKey === candidate.guardKey) {
      identities.add(
        `${provider.id}\u0000${externalKey(record.source, record.externalId)}`
      );
    }
  }
  return identities.size === 1;
}

function isTerminalRecord(
  record: ProviderState["externalBilling"][number]
): boolean {
  return TERMINAL_STATUSES.has(record.status?.trim().toLowerCase() ?? "");
}

function differs(
  subscription: ProviderState["subscriptions"][number],
  data: {
    name?: string;
    costUsd?: number;
    interval?: string;
    intervalCount?: number;
    currentPeriodStart?: Date;
    nextRenewalAt?: Date;
    autoRenew?: boolean;
    status?: string;
    canceledAt?: Date | null;
    externalAdoptionGuardKey?: string;
  }
): boolean {
  return Object.entries(data).some(([key, value]) => {
    const existing = subscription[key as keyof typeof subscription];
    if (existing instanceof Date && value instanceof Date) {
      return existing.getTime() !== value.getTime();
    }
    return existing !== value;
  });
}

function hasChargedCurrentPeriod(
  subscription: ProviderState["subscriptions"][number]
): boolean {
  return (
    subscription.lastChargedPeriodStart?.getTime() ===
    subscription.currentPeriodStart.getTime()
  );
}

function chargedBillingTermsMatchCandidate(
  subscription: ProviderState["subscriptions"][number],
  candidate: AdoptionCandidate
): boolean {
  return (
    exactUsdCents(subscription.costUsd) === candidate.amountCents &&
    normalizeExternalBillingCadence(subscription.interval) ===
      candidate.cadence &&
    subscription.intervalCount === 1 &&
    subscription.currentPeriodStart.getTime() ===
      candidate.periodStart.getTime() &&
    subscription.nextRenewalAt.getTime() === candidate.periodEnd.getTime()
  );
}

function chargedTermsMatchCandidate(
  subscription: ProviderState["subscriptions"][number],
  candidate: AdoptionCandidate
): boolean {
  return (
    subscription.name === candidate.serviceName &&
    chargedBillingTermsMatchCandidate(subscription, candidate)
  );
}

function preservesCloudflareLegacyDisplayName(
  provider: ProviderState,
  subscription: ProviderState["subscriptions"][number]
): boolean {
  return (
    provider.type === "builtin" &&
    provider.name === "cloudflare" &&
    subscription.externalBillingSource === CLOUDFLARE_LEGACY_SOURCE &&
    subscription.name === CLOUDFLARE_LEGACY_DISPLAY_NAME
  );
}

/**
 * Persist correction authority only after proving the exact local charge row
 * that the fresh provider observation replaces. The proof survives provider
 * rollover/staleness, but neither can create a new proof.
 */
async function recordChargedCorrectionProof(
  tx: AdoptionTransaction,
  provider: ProviderState,
  subscription: ProviderState["subscriptions"][number],
  candidate: AdoptionCandidate
): Promise<boolean> {
  if (
    candidate.periodStart.getTime() !==
      subscription.currentPeriodStart.getTime() ||
    !hasChargedCurrentPeriod(subscription) ||
    chargedBillingTermsMatchCandidate(subscription, candidate)
  ) {
    return false;
  }

  const event = await tx.externalUsageEvent.findUnique({
    where: {
      idempotencyKey: subscriptionChargeIdempotencyKey(
        subscription.id,
        subscription.currentPeriodStart
      ),
    },
    select: {
      sourceApp: true,
      provider: true,
      metricType: true,
      costUsd: true,
      occurredAt: true,
      windowStart: true,
      windowEnd: true,
      metadata: true,
    },
  });
  const metadata = asRecord(event?.metadata ?? null);
  const originalAmountCents = exactUsdCents(subscription.costUsd);
  const eventAmountCents = exactUsdCents(event?.costUsd ?? null);
  if (
    !event ||
    event.sourceApp !== SUBSCRIPTION_SOURCE_APP ||
    event.provider !== provider.name ||
    event.metricType !== "subscription" ||
    originalAmountCents == null ||
    eventAmountCents !== originalAmountCents ||
    event.occurredAt.getTime() !==
      subscription.currentPeriodStart.getTime() ||
    event.windowStart?.getTime() !==
      subscription.currentPeriodStart.getTime() ||
    event.windowEnd?.getTime() !== subscription.nextRenewalAt.getTime() ||
    metadata?.subscriptionId !== subscription.id
  ) {
    return false;
  }

  await tx.externalBillingChargeCorrection.upsert({
    where: {
      managedSubscriptionId_originalPeriodStart_correctedGuardKey: {
        managedSubscriptionId: subscription.id,
        originalPeriodStart: subscription.currentPeriodStart,
        correctedGuardKey: candidate.guardKey,
      },
    },
    create: {
      providerId: provider.id,
      managedSubscriptionId: subscription.id,
      source: candidate.source,
      externalId: candidate.externalId,
      originalPeriodStart: subscription.currentPeriodStart,
      originalPeriodEnd: subscription.nextRenewalAt,
      originalAmountUsd: subscription.costUsd,
      correctedPeriodStart: candidate.periodStart,
      correctedPeriodEnd: candidate.periodEnd,
      correctedAmountUsd: candidate.amountUsd,
      correctedGuardKey: candidate.guardKey,
      observedAt: candidate.observedAt,
    },
    // The unique key already identifies the original charge plus corrected
    // shape. Preserve the first exact authoritative observation verbatim.
    update: {},
  });
  return true;
}

function hasExactSubscriptionChargeMetadata(
  value: Prisma.JsonValue | null,
  subscription: ProviderState["subscriptions"][number],
  candidate: AdoptionCandidate
): boolean {
  const metadata = asRecord(value);
  if (!metadata) return false;
  const keys = Object.keys(metadata).sort();
  return (
    JSON.stringify(keys) ===
      JSON.stringify(
        [
          "currency",
          "interval",
          "intervalCount",
          "subscriptionId",
          "subscriptionName",
        ].sort()
      ) &&
    metadata.subscriptionId === subscription.id &&
    metadata.subscriptionName === subscription.name &&
    metadata.interval === candidate.cadence &&
    metadata.intervalCount === 1 &&
    metadata.currency === "USD"
  );
}

async function hasExactCurrentPeriodChargeProof(
  tx: AdoptionTransaction,
  provider: ProviderState,
  subscription: ProviderState["subscriptions"][number],
  candidate: AdoptionCandidate
): Promise<boolean> {
  if (
    subscription.lastChargedPeriodStart?.getTime() !==
    candidate.periodStart.getTime()
  ) {
    return false;
  }
  const event = await tx.externalUsageEvent.findUnique({
    where: {
      idempotencyKey: subscriptionChargeIdempotencyKey(
        subscription.id,
        candidate.periodStart
      ),
    },
    select: {
      sourceApp: true,
      provider: true,
      service: true,
      label: true,
      billingMode: true,
      metricType: true,
      unit: true,
      costUsd: true,
      confidence: true,
      occurredAt: true,
      windowStart: true,
      windowEnd: true,
      projectId: true,
      metadata: true,
    },
  });
  return Boolean(
    event &&
      event.sourceApp === SUBSCRIPTION_SOURCE_APP &&
      event.provider === provider.name &&
      event.service === subscription.name &&
      event.label === subscription.name &&
      event.billingMode === "manual" &&
      event.metricType === "subscription" &&
      event.unit === "usd" &&
      exactUsdCents(event.costUsd) === candidate.amountCents &&
      event.confidence === "actual" &&
      event.occurredAt.getTime() === candidate.periodStart.getTime() &&
      event.windowStart?.getTime() === candidate.periodStart.getTime() &&
      event.windowEnd?.getTime() === candidate.periodEnd.getTime() &&
      event.projectId === subscription.projectId &&
      hasExactSubscriptionChargeMetadata(
        event.metadata,
        subscription,
        candidate
      )
  );
}

async function handoffCloudflareLegacySubscription(
  tx: AdoptionTransaction,
  providers: ProviderState[],
  candidatesByExternalKey: Map<string, AdoptionCandidate>,
  now: Date,
  targetId: string | null,
  initialStatus: CloudflareLegacyHandoffStatus
): Promise<CloudflareLegacyHandoffStatus> {
  if (!targetId) return initialStatus;

  const provider = providers.find((item) =>
    item.subscriptions.some((subscription) => subscription.id === targetId)
  );
  const subscription = provider?.subscriptions.find(
    (item) => item.id === targetId
  );
  if (!provider || !subscription) return "not_found";
  if (
    provider.type !== "builtin" ||
    provider.name !== "cloudflare" ||
    !provider.isActive
  ) {
    return "wrong_provider";
  }
  if (
    subscription.externalBillingSource !== CLOUDFLARE_LEGACY_SOURCE ||
    !subscription.externalBillingId
  ) {
    return "wrong_identity";
  }
  const identity = externalKey(
    subscription.externalBillingSource,
    subscription.externalBillingId
  );
  const externalRecord = provider.externalBilling.find(
    (record) => externalKey(record.source, record.externalId) === identity
  );
  if (!externalRecord) {
    return "wrong_identity";
  }
  if (subscription.externalBillingManaged) return "already_managed";
  if (subscription.externalAdoptionGuardKey !== null) {
    return "owner_guard_present";
  }
  if (conflictsWithProviderPlan(provider.plan?.fixedMonthlyCostUsd)) {
    return "provider_plan_conflict";
  }

  const candidate = cloudflareLegacyHandoffCandidate(
    provider.id,
    provider.refreshIntervalMin,
    externalRecord,
    now
  );
  if (!candidate) return "external_billing_ineligible";
  if (
    !preservesCloudflareLegacyDisplayName(provider, subscription) ||
    exactUsdCents(subscription.costUsd) !== candidate.amountCents ||
    subscription.currency !== "USD" ||
    subscription.interval !== candidate.cadence ||
    subscription.intervalCount !== 1 ||
    subscription.currentPeriodStart.getTime() !==
      candidate.periodStart.getTime() ||
    subscription.nextRenewalAt.getTime() !== candidate.periodEnd.getTime() ||
    !subscription.autoRenew ||
    subscription.status !== "active" ||
    subscription.canceledAt !== null
  ) {
    return "term_mismatch";
  }
  if (
    !hasUniqueCloudflareLegacyHandoffShape(
      provider,
      candidatesByExternalKey,
      candidate,
      now
    ) ||
    provider.subscriptions.some(
      (other) =>
        other.id !== subscription.id &&
        hasExistingRecurringCharge(candidate, [other])
    ) ||
    providers.some((item) =>
      item.subscriptions.some(
        (other) =>
          other.id !== subscription.id &&
          other.externalAdoptionGuardKey === candidate.guardKey
      )
    )
  ) {
    return "guard_collision";
  }
  if (
    !(await hasExactCurrentPeriodChargeProof(
      tx,
      provider,
      subscription,
      candidate
    ))
  ) {
    return "charge_proof_missing";
  }

  await tx.subscription.update({
    where: { id: subscription.id },
    data: {
      externalBillingManaged: true,
      externalAdoptionGuardKey: candidate.guardKey,
      autoRenew: false,
    },
  });
  Object.assign(subscription, {
    externalBillingManaged: true,
    externalAdoptionGuardKey: candidate.guardKey,
    autoRenew: false,
  });
  return "handed_off";
}

async function pauseAmbiguousSubscriptions(
  tx: AdoptionTransaction,
  subscriptions: ProviderState["subscriptions"],
  blockedSubscriptionIds: Set<string>,
  result: AdoptExternalBillingSubscriptionsResult
): Promise<void> {
  for (const subscription of subscriptions) {
    blockedSubscriptionIds.add(subscription.id);
    if (subscription.status === "paused" && !subscription.autoRenew) continue;
    await tx.subscription.update({
      where: { id: subscription.id },
      data: { status: "paused", canceledAt: null, autoRenew: false },
    });
    result.deactivated += 1;
  }
}

async function reconcileManagedSubscriptions(
  tx: AdoptionTransaction,
  providers: ProviderState[],
  candidatesByExternalKey: Map<string, AdoptionCandidate>,
  now: Date,
  result: AdoptExternalBillingSubscriptionsResult
): Promise<void> {
  const blockedSubscriptionIds = new Set<string>();
  for (const provider of providers) {
    const recordsByKey = new Map(
      provider.externalBilling.map((record) => [
        externalKey(record.source, record.externalId),
        record,
      ])
    );

    for (const subscription of provider.subscriptions) {
      if (!subscription.externalBillingManaged) continue;
      if (blockedSubscriptionIds.has(subscription.id)) continue;
      if (conflictsWithProviderPlan(provider.plan?.fixedMonthlyCostUsd)) {
        if (subscription.status !== "paused" || subscription.autoRenew) {
          await tx.subscription.update({
            where: { id: subscription.id },
            data: { status: "paused", canceledAt: null, autoRenew: false },
          });
          result.deactivated += 1;
        }
        continue;
      }
      const source = subscription.externalBillingSource;
      const externalId = subscription.externalBillingId;
      const key = source && externalId ? externalKey(source, externalId) : null;
      const record = key ? recordsByKey.get(key) : undefined;
      const generalCandidate = key
        ? candidatesByExternalKey.get(`${provider.id}\u0000${key}`)
        : undefined;
      // The midnight-window exception belongs only to the exact preserved
      // legacy Cloudflare row after its guarded handoff. Other providers and
      // other managed Cloudflare subscriptions keep the general exact-period
      // reconciliation rules.
      const candidate =
        record && preservesCloudflareLegacyDisplayName(provider, subscription)
          ? cloudflareLegacyHandoffCandidate(
              provider.id,
              provider.refreshIntervalMin,
              record,
              now
            ) ?? undefined
          : generalCandidate;

      if (!record) {
        if (subscription.status !== "canceled" || subscription.autoRenew) {
          await tx.subscription.update({
            where: { id: subscription.id },
            data: {
              status: "canceled",
              canceledAt: now,
              autoRenew: false,
            },
          });
          result.deactivated += 1;
        }
        continue;
      }

      if (!candidate) {
        const status = isTerminalRecord(record) ? "canceled" : "paused";
        if (status === "paused") result.ambiguous += 1;
        if (subscription.status !== status || subscription.autoRenew) {
          await tx.subscription.update({
            where: { id: subscription.id },
            data: {
              status,
              canceledAt: status === "canceled" ? now : null,
              autoRenew: false,
            },
          });
          result.deactivated += 1;
        }
        continue;
      }

      const candidateStart = candidate.periodStart.getTime();
      const storedStart = subscription.currentPeriodStart.getTime();
      if (
        candidateStart < storedStart ||
        (candidateStart > storedStart &&
          candidateStart < subscription.nextRenewalAt.getTime())
      ) {
        result.ambiguous += 1;
        continue;
      }

      // Record the fresh correction before resolving a guard collision. A
      // process can stop after this transaction and before materialization;
      // the proof must already be durable when the provider later rolls over.
      await recordChargedCorrectionProof(
        tx,
        provider,
        subscription,
        candidate
      );

      // The guard is a durable claim on one provider/cadence/amount shape. If
      // another row already owns the candidate's guard, changing this managed
      // row would throw P2002 and abort all adoption maintenance. Pause the
      // auto-managed participant(s) instead. Owner rows remain untouched; the
      // materializer independently suppresses a guarded duplicate when this
      // linked identity has already charged the same period.
      const guardCollisions =
        candidate.guardKey === subscription.externalAdoptionGuardKey
          ? []
          : provider.subscriptions.filter(
              (other) =>
                other.id !== subscription.id &&
                other.externalAdoptionGuardKey === candidate.guardKey
            );
      if (guardCollisions.length > 0) {
        result.ambiguous += 1;
        await pauseAmbiguousSubscriptions(
          tx,
          [
            subscription,
            ...guardCollisions.filter(
              (collision) => collision.externalBillingManaged
            ),
          ],
          blockedSubscriptionIds,
          result
        );
        continue;
      }

      // Once this exact period has materialized, its local terms and guard are
      // historical accounting evidence. Provider corrections to amount,
      // cadence or end must not rewrite that evidence or mark
      // the old charge exact again. Pause for explicit reconciliation while
      // preserving both the original guard and materialized event.
      if (
        candidateStart === storedStart &&
        hasChargedCurrentPeriod(subscription) &&
        !chargedTermsMatchCandidate(subscription, candidate) &&
        !(
          preservesCloudflareLegacyDisplayName(provider, subscription) &&
          chargedBillingTermsMatchCandidate(subscription, candidate)
        )
      ) {
        result.ambiguous += 1;
        await pauseAmbiguousSubscriptions(
          tx,
          [subscription],
          blockedSubscriptionIds,
          result
        );
        continue;
      }

      const isNewPeriod = candidateStart > storedStart;
      const canRefreshChargeTerms =
        isNewPeriod || subscription.lastChargedPeriodStart == null;
      const data = {
        ...(canRefreshChargeTerms
          ? {
              ...(preservesCloudflareLegacyDisplayName(
                provider,
                subscription
              )
                ? {}
                : { name: candidate.serviceName }),
              costUsd: candidate.amountUsd,
              interval: candidate.cadence,
              intervalCount: 1,
              currentPeriodStart: candidate.periodStart,
              nextRenewalAt: candidate.periodEnd,
            }
          : {}),
        autoRenew: false,
        status: "active",
        canceledAt: null,
        externalAdoptionGuardKey: candidate.guardKey,
      };
      if (differs(subscription, data)) {
        await tx.subscription.update({
          where: { id: subscription.id },
          data,
        });
        result.reconciled += 1;
      }
    }
  }
}

async function reconcileAndAdopt(
  tx: AdoptionTransaction,
  providers: ProviderState[],
  now: Date,
  raced: number,
  legacyHandoff: CloudflareLegacyHandoffConfig
): Promise<AdoptExternalBillingSubscriptionsResult> {
  const result: AdoptExternalBillingSubscriptionsResult = {
    examined: providers.reduce(
      (sum, provider) => sum + provider.externalBilling.length,
      0
    ),
    eligible: 0,
    adopted: 0,
    existing: 0,
    ambiguous: 0,
    reconciled: 0,
    deactivated: 0,
    raced,
    cloudflareLegacyHandoff: legacyHandoff.initialStatus,
  };

  const candidates: AdoptionCandidate[] = [];
  const candidatesByExternalKey = new Map<string, AdoptionCandidate>();
  for (const provider of providers) {
    for (const record of provider.externalBilling) {
      const identityKey = `${provider.id}\u0000${externalKey(
        record.source,
        record.externalId
      )}`;
      const candidate = paidRecurringAdoptionCandidate(
        provider.id,
        provider.refreshIntervalMin,
        record,
        now
      );
      if (candidate) {
        candidates.push(candidate);
        candidatesByExternalKey.set(identityKey, candidate);
      }
    }
  }
  result.eligible = candidates.length;

  result.cloudflareLegacyHandoff =
    await handoffCloudflareLegacySubscription(
      tx,
      providers,
      candidatesByExternalKey,
      now,
      legacyHandoff.targetId,
      legacyHandoff.initialStatus
    );

  await reconcileManagedSubscriptions(
    tx,
    providers,
    candidatesByExternalKey,
    now,
    result
  );

  const shapeCounts = new Map<string, number>();
  for (const candidate of candidates) {
    const key = candidateShapeKey(candidate);
    shapeCounts.set(key, (shapeCounts.get(key) ?? 0) + 1);
  }

  for (const candidate of candidates) {
    const provider = providers.find((item) => item.id === candidate.providerId)!;
    const exactLink = provider.subscriptions.some(
      (subscription) =>
        subscription.externalBillingSource === candidate.source &&
        subscription.externalBillingId === candidate.externalId
    );
    if (exactLink) {
      result.existing += 1;
      continue;
    }
    if (
      (shapeCounts.get(candidateShapeKey(candidate)) ?? 0) > 1 ||
      hasExistingRecurringCharge(candidate, provider.subscriptions) ||
      conflictsWithProviderPlan(provider.plan?.fixedMonthlyCostUsd)
    ) {
      result.ambiguous += 1;
      continue;
    }

    await tx.subscription.create({
      data: {
        providerId: candidate.providerId,
        externalBillingSource: candidate.source,
        externalBillingId: candidate.externalId,
        externalBillingManaged: true,
        externalAdoptionGuardKey: candidate.guardKey,
        name: candidate.serviceName,
        costUsd: candidate.amountUsd,
        currency: "USD",
        interval: candidate.cadence,
        intervalCount: 1,
        startDate: candidate.periodStart,
        currentPeriodStart: candidate.periodStart,
        nextRenewalAt: candidate.periodEnd,
        autoRenew: false,
        status: "active",
      },
    });
    result.adopted += 1;
  }

  return result;
}

function retryableWriteConflict(error: unknown): boolean {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    ["P1008", "P2002", "P2034"].includes(error.code)
  ) {
    return true;
  }
  return (
    error instanceof Error &&
    /database is locked|write conflict|timed out/i.test(error.message)
  );
}

/**
 * Reconciles single-term externally managed subscriptions and adopts new exact
 * paid terms. A SQLite write lock is taken before the authoritative re-read so
 * manual creates and provider cancellation/deletion cannot race the decision.
 */
export async function adoptExternalBillingSubscriptions(
  now = new Date(),
  options: ExternalBillingSubscriptionAdoptionOptions = {}
): Promise<AdoptExternalBillingSubscriptionsResult> {
  const legacyHandoff = cloudflareLegacyHandoffConfig();
  const preflight = await prisma.provider.findMany({
    select: providerStateSelect,
  });
  if (preflight.length === 0) {
    return {
      examined: 0,
      eligible: 0,
      adopted: 0,
      existing: 0,
      ambiguous: 0,
      reconciled: 0,
      deactivated: 0,
      raced: 0,
      cloudflareLegacyHandoff: legacyHandoff.initialStatus,
    };
  }

  await options.beforeTransactionalRecheck?.();

  let raced = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          // SQLite begins interactive transactions deferred. This harmless
          // write obtains the one durable writer lock before the full re-read.
          await tx.$executeRaw`
            UPDATE "Provider"
            SET "refreshIntervalMin" = "refreshIntervalMin"
            WHERE "id" = ${preflight[0].id}
          `;
          const providers = await tx.provider.findMany({
            select: providerStateSelect,
          });
          await options.afterTransactionalRecheck?.();
          return reconcileAndAdopt(
            tx,
            providers,
            now,
            raced,
            legacyHandoff
          );
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 5_000,
          timeout: 20_000,
        }
      );
    } catch (error) {
      if (!retryableWriteConflict(error) || attempt === 2) throw error;
      raced += 1;
    }
  }

  throw new Error("External billing adoption retry loop exhausted");
}
