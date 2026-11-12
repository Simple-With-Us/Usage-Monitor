export interface LinkableExternalBillingRecord {
  externalId: string | null;
  kind: string;
  status: string | null;
  amountUsd: number | null;
  currency: string | null;
  billingInterval: string | null;
  currentPeriodStart: string | Date | null;
  rollupRole?: string | null;
}

export interface ExternalBillingLinkCandidateRecord
  extends LinkableExternalBillingRecord {
  currentPeriodEnd: string | Date | null;
  syncedAt: string | Date;
}

export interface LinkableSubscriptionCharge {
  costUsd: number;
  currency: string;
  interval: string;
  intervalCount: number;
  status: string;
}

const INACTIVE_STATUSES = new Set([
  "canceled",
  "cancelled",
  "disabled",
  "expired",
  "failed",
  "inactive",
  "limit_reached",
  "paused",
  "past-due",
  "past_due",
  "payment_failed",
  "unpaid",
  "unavailable",
]);
const KNOWN_LIVE_STATUSES = new Set([
  "active",
  "enabled",
  "open",
  "paid",
]);
const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1_000;

function isLiveStatus(value: string | null): boolean {
  const status = value?.trim().toLowerCase() ?? "active";
  return status !== "considering" && !INACTIVE_STATUSES.has(status);
}

function isKnownLiveStatus(value: string | null): boolean {
  return KNOWN_LIVE_STATUSES.has(value?.trim().toLowerCase() ?? "");
}

export function externalBillingFreshnessWindowMs(
  refreshIntervalMin = 60
): number {
  return Math.min(
    24 * 60 * 60 * 1_000,
    Math.max(60 * 60 * 1_000, refreshIntervalMin * 3 * 60 * 1_000)
  );
}

export function normalizeExternalBillingCadence(
  value: string | null
): SubscriptionInterval | null {
  const cadence = value?.trim().toLowerCase();
  if (!cadence) return null;
  if (["week", "weekly"].includes(cadence)) return "weekly";
  if (["month", "monthly"].includes(cadence)) return "monthly";
  if (["quarter", "quarterly"].includes(cadence)) return "quarterly";
  if (["year", "yearly", "annual", "annually"].includes(cadence)) return "annual";
  return null;
}

/** True only when the provider supplied one complete, exact cadence period. */
export function hasExactExternalBillingCadencePeriod(
  record: Pick<
    ExternalBillingLinkCandidateRecord,
    "billingInterval" | "currentPeriodStart" | "currentPeriodEnd"
  >
): boolean {
  const cadence = normalizeExternalBillingCadence(record.billingInterval);
  const start = timestamp(record.currentPeriodStart);
  const end = timestamp(record.currentPeriodEnd);
  if (!cadence || start == null || end == null || end <= start) return false;
  return advancePeriod(new Date(start), cadence, 1).getTime() === end;
}

function normalizedCurrency(value: string | null): string | null {
  const currency = value?.trim().toUpperCase();
  return currency || null;
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= 0.005;
}

function timestamp(value: string | Date | null): number | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function addUtcMonths(value: number, months: number): number {
  const result = new Date(value);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)
  ).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result.getTime();
}

function derivedPeriodEnd(periodStart: number, cadence: string): number {
  if (cadence === "weekly") return periodStart + 7 * 24 * 60 * 60 * 1_000;
  if (cadence === "monthly") return addUtcMonths(periodStart, 1);
  if (cadence === "quarterly") return addUtcMonths(periodStart, 3);
  return addUtcMonths(periodStart, 12);
}

export function resolveExternalBillingPeriod(
  record: Pick<
    ExternalBillingLinkCandidateRecord,
    "billingInterval" | "currentPeriodStart" | "currentPeriodEnd"
  >
): { start: Date; end: Date } | null {
  const cadence = normalizeExternalBillingCadence(record.billingInterval);
  if (!cadence) return null;
  const periodStart = timestamp(record.currentPeriodStart);
  if (periodStart == null) return null;

  const explicitPeriodEnd = timestamp(record.currentPeriodEnd);
  if (record.currentPeriodEnd != null && explicitPeriodEnd == null) return null;
  const cadencePeriodEnd = derivedPeriodEnd(periodStart, cadence);
  const periodEnd = explicitPeriodEnd == null
    ? cadencePeriodEnd
    : Math.min(explicitPeriodEnd, cadencePeriodEnd);
  if (periodEnd <= periodStart) return null;
  return { start: new Date(periodStart), end: new Date(periodEnd) };
}

function hasCurrentPeriod(
  record: ExternalBillingLinkCandidateRecord,
  now: number
): boolean {
  const period = resolveExternalBillingPeriod(record);
  return Boolean(
    period && period.start.getTime() <= now && now < period.end.getTime()
  );
}

export interface ExternalBillingLinkCandidateOptions {
  now?: number | Date;
  staleAfterMs?: number;
}

/** Records that can satisfy the exact fixed-charge identity used by budget dedupe. */
export function isExternalBillingLinkCandidate(
  record: ExternalBillingLinkCandidateRecord,
  options: ExternalBillingLinkCandidateOptions = {}
): boolean {
  const nowInput = options.now ?? Date.now();
  const now = nowInput instanceof Date ? nowInput.getTime() : nowInput;
  const staleAfterMs = options.staleAfterMs ?? externalBillingFreshnessWindowMs();
  const syncedAt = timestamp(record.syncedAt);
  const cadence = normalizeExternalBillingCadence(record.billingInterval);
  return (
    Number.isFinite(now) &&
    Number.isFinite(staleAfterMs) &&
    staleAfterMs > 0 &&
    Boolean(record.externalId) &&
    ["plan", "subscription"].includes(record.kind.trim().toLowerCase()) &&
    (record.rollupRole?.trim().toLowerCase() ?? "canonical") === "canonical" &&
    isKnownLiveStatus(record.status) &&
    record.amountUsd != null &&
    Number.isFinite(record.amountUsd) &&
    record.amountUsd >= 0 &&
    normalizedCurrency(record.currency) === "USD" &&
    cadence != null &&
    syncedAt != null &&
    syncedAt <= now + MAX_FUTURE_CLOCK_SKEW_MS &&
    now - syncedAt <= staleAfterMs &&
    hasCurrentPeriod(record, now)
  );
}

/** Exact recurring-charge equivalence shared by API validation, display, and budget dedupe. */
export function canLinkSubscriptionToExternalBilling(
  subscription: LinkableSubscriptionCharge,
  record: LinkableExternalBillingRecord
): boolean {
  const recordCadence = normalizeExternalBillingCadence(record.billingInterval);
  const subscriptionCadence = normalizeExternalBillingCadence(
    subscription.interval
  );
  return (
    Boolean(record.externalId) &&
    ["plan", "subscription"].includes(record.kind.trim().toLowerCase()) &&
    (record.rollupRole?.trim().toLowerCase() ?? "canonical") === "canonical" &&
    record.amountUsd != null &&
    Number.isFinite(record.amountUsd) &&
    record.amountUsd >= 0 &&
    nearlyEqual(record.amountUsd, subscription.costUsd) &&
    normalizedCurrency(record.currency) ===
      normalizedCurrency(subscription.currency) &&
    normalizedCurrency(record.currency) === "USD" &&
    subscription.intervalCount === 1 &&
    recordCadence != null &&
    recordCadence === subscriptionCadence &&
    Boolean(record.currentPeriodStart) &&
    isLiveStatus(record.status) === isLiveStatus(subscription.status)
  );
}

export function formatExternalBillingAmount(
  amount: number,
  currency: string | null
): string {
  const normalizedCurrency = currency?.trim().toUpperCase() || "UNKNOWN";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: normalizedCurrency,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${normalizedCurrency}`;
  }
}
import {
  advancePeriod,
  type SubscriptionInterval,
} from "@/lib/subscriptions";
