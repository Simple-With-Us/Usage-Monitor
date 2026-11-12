// Pure billing-cycle math for subscriptions (no DB access). Used by the
// subscription materializer (charge generation + renewal roll-forward), the
// input parser, and budget projections.
//
// All arithmetic is in UTC to match the rest of the app's month/day boundaries
// (see budget-status.ts's monthStartUtc, data-retention.ts's startOfUtcDay).

export const SUBSCRIPTION_INTERVALS = ["weekly", "monthly", "quarterly", "annual"] as const;
export type SubscriptionInterval = (typeof SUBSCRIPTION_INTERVALS)[number];
// "considering" models a candidate paid tier that isn't purchased yet — it
// never generates charges (materializeDueSubscriptions filters status ===
// "active" at the DB query level; see subscription-materializer.ts), but it
// is a first-class row so its knobEnv can be compared against the active
// plan/free tier before committing to it.
export const SUBSCRIPTION_STATUSES = ["active", "paused", "canceled", "considering"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export function isSubscriptionInterval(value: string): value is SubscriptionInterval {
  return (SUBSCRIPTION_INTERVALS as readonly string[]).includes(value);
}

export function isSubscriptionStatus(value: string): value is SubscriptionStatus {
  return (SUBSCRIPTION_STATUSES as readonly string[]).includes(value);
}

/** Stored status plus term semantics used consistently by API and billing UI. */
export function effectiveSubscriptionStatus(
  subscription: {
    status: string;
    autoRenew: boolean;
    nextRenewalAt: Date | string;
  },
  now: Date = new Date()
): string {
  const status = subscription.status.trim().toLowerCase() || "active";
  const termEnd = new Date(subscription.nextRenewalAt).getTime();
  if (
    status === "active" &&
    !subscription.autoRenew &&
    Number.isFinite(termEnd) &&
    termEnd <= now.getTime()
  ) {
    return "expired";
  }
  return status;
}

// Months in one whole interval unit — the multiplier used for both period
// advancement (quarterly = 3 months, annual = 12) and monthly-equivalent cost.
// Weekly is special-cased in the functions below since it isn't month-based.
function monthsPerUnit(interval: SubscriptionInterval): number {
  switch (interval) {
    case "monthly":
      return 1;
    case "quarterly":
      return 3;
    case "annual":
      return 12;
    case "weekly":
      return 0; // handled separately
  }
}

// Add `months` to a UTC date, clamping the day-of-month to the target month's
// length (e.g. Jan 31 + 1 month -> Feb 28/29) so an anchor day never rolls
// into the following month.
function addUtcMonths(date: Date, months: number): Date {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const target = new Date(
    Date.UTC(
      year,
      month + months,
      1,
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds()
    )
  );
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target;
}

// The start of the billing period immediately following the one that begins at
// `periodStart`. Advancing by intervalCount whole units.
export function advancePeriod(
  periodStart: Date,
  interval: SubscriptionInterval,
  intervalCount: number
): Date {
  const count = Math.max(1, Math.trunc(intervalCount));
  if (interval === "weekly") {
    return new Date(periodStart.getTime() + count * 7 * 24 * 60 * 60 * 1000);
  }
  return addUtcMonths(periodStart, monthsPerUnit(interval) * count);
}

/**
 * Wave K / E13: true when [periodStart, periodEnd) is not an exact supported
 * cadence duration. Managed rows with ambiguous windows must not be charged
 * until reconcile rewrites exact bounds.
 *
 * The UTC-midnight calendar exception (provider end at 00:00Z on the expected
 * calendar day while start carries a creation time) is opt-in and reserved for
 * the exact Cloudflare legacy handoff row — never for general managed terms.
 */
export function isAmbiguousSubscriptionPeriodWindow(
  periodStart: Date,
  periodEnd: Date,
  interval: SubscriptionInterval,
  intervalCount: number,
  options?: { allowUtcMidnightCalendarException?: boolean }
): boolean {
  const startMs = periodStart.getTime();
  const endMs = periodEnd.getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return true;
  }
  const expectedEnd = advancePeriod(periodStart, interval, intervalCount);
  if (endMs === expectedEnd.getTime()) return false;

  if (!options?.allowUtcMidnightCalendarException) return true;

  // Opt-in midnight calendar exception only (Cloudflare Workers Paid legacy).
  const endIsUtcMidnight =
    periodEnd.getUTCHours() === 0 &&
    periodEnd.getUTCMinutes() === 0 &&
    periodEnd.getUTCSeconds() === 0 &&
    periodEnd.getUTCMilliseconds() === 0;
  if (!endIsUtcMidnight) return true;

  const expectedDay = Date.UTC(
    expectedEnd.getUTCFullYear(),
    expectedEnd.getUTCMonth(),
    expectedEnd.getUTCDate()
  );
  const endDay = Date.UTC(
    periodEnd.getUTCFullYear(),
    periodEnd.getUTCMonth(),
    periodEnd.getUTCDate()
  );
  return expectedDay !== endDay;
}

// Override the day-of-month of `date` to `anchorDay` (clamped to the month's
// length), preserving the time-of-day. Used so a subscription renews on a fixed
// calendar day regardless of its start date's day.
export function applyAnchorDay(date: Date, anchorDay: number): Date {
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  const target = new Date(date.getTime());
  target.setUTCDate(Math.min(Math.max(1, Math.trunc(anchorDay)), lastDay));
  return target;
}

// Monthly-equivalent cost, for projected-spend rollups that mix cadences
// (e.g. an annual plan contributes cost/12 per month). Weekly uses the
// 52-weeks-over-12-months convention.
export function normalizeMonthlyUsd(
  costUsd: number,
  interval: SubscriptionInterval,
  intervalCount: number
): number {
  const count = Math.max(1, Math.trunc(intervalCount));
  const monthsPerPeriod = interval === "weekly" ? count * (12 / 52) : monthsPerUnit(interval) * count;
  return monthsPerPeriod > 0 ? costUsd / monthsPerPeriod : costUsd;
}

// The initial cycle anchor for a newly-created subscription: the first period
// starts at startDate (optionally moved to the anchor day-of-month), and the
// next renewal is one interval later.
export function initialCycle(input: {
  startDate: Date;
  interval: SubscriptionInterval;
  intervalCount: number;
  anchorDay: number | null;
}): { currentPeriodStart: Date; nextRenewalAt: Date } {
  const currentPeriodStart =
    input.anchorDay != null ? applyAnchorDay(input.startDate, input.anchorDay) : input.startDate;
  return {
    currentPeriodStart,
    nextRenewalAt: advancePeriod(currentPeriodStart, input.interval, input.intervalCount),
  };
}

// Recomputes a subscription's cycle after its schedule is EDITED, guaranteeing
// the new cadence never re-charges (or overlaps) an already-charged period.
//
// `paidThrough` is the end of the last already-charged period (null if nothing
// has been charged yet). The new cadence's first period is anchored on the new
// startDate/anchorDay and then advanced until it starts AT OR AFTER paidThrough
// — so no re-anchored period can overlap billed time (the bug where moving the
// anchor a few days later in the current month emitted a second overlapping
// charge). The caller sets lastChargedPeriodStart = null: because
// currentPeriodStart >= paidThrough, nothing before billed time can ever fire.
//   - paidThrough null (nothing charged yet) → start at the anchor, allowing the
//     same intentional backfill-from-startDate as a brand-new subscription.
export function rescheduleCycle(input: {
  startDate: Date;
  interval: SubscriptionInterval;
  intervalCount: number;
  anchorDay: number | null;
  paidThrough: Date | null;
}): { currentPeriodStart: Date; nextRenewalAt: Date } {
  const anchorStart =
    input.anchorDay != null ? applyAnchorDay(input.startDate, input.anchorDay) : input.startDate;
  let start = anchorStart;
  if (input.paidThrough) {
    let guard = 0;
    while (start.getTime() < input.paidThrough.getTime() && guard < 5000) {
      start = advancePeriod(start, input.interval, input.intervalCount);
      guard += 1;
    }
  }
  return {
    currentPeriodStart: start,
    nextRenewalAt: advancePeriod(start, input.interval, input.intervalCount),
  };
}

// Rolls a renewal date forward until it is in the future, following an
// interval. Used to fix ProviderPlan.renewalDate getting stuck permanently
// "overdue" once it passes, and to advance subscription renewals. Returns the
// same instant if it is already in the future. A guard caps iterations so a
// renewal far in the past can't spin forever.
export function rollForwardRenewal(
  renewalAt: Date,
  interval: SubscriptionInterval,
  intervalCount: number,
  now: Date
): Date {
  let next = renewalAt;
  let guard = 0;
  while (next.getTime() <= now.getTime() && guard < 1000) {
    next = advancePeriod(next, interval, intervalCount);
    guard += 1;
  }
  return next;
}
