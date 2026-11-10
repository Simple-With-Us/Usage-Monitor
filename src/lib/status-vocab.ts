/**
 * Shared status & provenance vocabulary (U8 consolidation).
 *
 * One canonical badge-style map for every subscription / billing-inventory
 * status value (including the `canceled`/`cancelled` spelling variants and
 * the `past_due`/`past-due` separator variants) plus the provenance labels
 * used by the paid-services inventory. SubscriptionsPanel and
 * PaidServicesPanel both import from here — do not fork these maps again.
 */
import type { BillingInventoryProvenance } from "@/lib/billing-inventory";

const EMERALD =
  "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300";
const BLUE = "bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300";
const INDIGO =
  "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300";
const AMBER = "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300";
const AMBER_STRONG =
  "bg-amber-50 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300";
const RED = "bg-red-50 text-red-700 dark:bg-red-950/60 dark:text-red-300";
// WCAG AA: gray-700 on gray-100 = 9.37:1, gray-200 on gray-700 = 8.33:1.
// The previous gray-500/gray-400 text failed AA in both modes (4.39:1 / 4.06:1).
const GRAY = "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200";

export const STATUS_BADGE_STYLES: Record<string, string> = {
  // Live / good standing
  active: EMERALD,
  enabled: EMERALD,
  paid: EMERALD,
  open: BLUE,
  // Prospective / in-progress states
  trialing: INDIGO,
  considering: INDIGO,
  paused: AMBER,
  // Terminal-neutral (both spellings — provider APIs disagree)
  canceled: GRAY,
  cancelled: GRAY,
  // Terminal-bad (both separator variants — provider APIs disagree)
  expired: RED,
  failed: RED,
  unpaid: RED,
  payment_failed: RED,
  "payment-failed": RED,
  past_due: RED,
  "past-due": RED,
  // Quota pressure
  limit_reached: AMBER_STRONG,
  "limit-reached": AMBER_STRONG,
  // Not currently providing service
  disabled: GRAY,
  inactive: GRAY,
  unavailable: GRAY,
};

export const DEFAULT_STATUS_BADGE_STYLE = GRAY;

export function statusBadgeStyle(status: string): string {
  return STATUS_BADGE_STYLES[status] ?? DEFAULT_STATUS_BADGE_STYLE;
}

/** Sort order for subscription lists — most actionable states first. */
export const STATUS_SORT_ORDER: Record<string, number> = {
  active: 0,
  considering: 1,
  paused: 2,
  canceled: 3,
  cancelled: 3,
  expired: 4,
};

/** Human label for a raw provider/local status enum ("past_due" → "Past due"). */
export function formatStatusLabel(value: string): string {
  const normalized = value.trim().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  return normalized
    ? normalized[0].toUpperCase() + normalized.slice(1)
    : "Unknown";
}

export const BILLING_PROVENANCE_LABELS: Record<BillingInventoryProvenance, string> = {
  automatic: "Provider API",
  linked: "Verified + tracked",
  tracked: "Tracked",
  "provider-plan": "Plan settings",
};

export const BILLING_PROVENANCE_STYLES: Record<BillingInventoryProvenance, string> = {
  automatic: "bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300",
  linked: "bg-violet-50 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300",
  tracked: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  "provider-plan": "bg-amber-50 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
};

/** Legend text for the provenance disclosure in the paid-services panel. */
export const BILLING_PROVENANCE_DESCRIPTIONS: Record<BillingInventoryProvenance, string> = {
  automatic: "Reported directly by the provider's billing API during a sync.",
  linked: "Provider-reported and matched to a locally tracked subscription.",
  tracked: "Entered and maintained locally in this app — not provider-confirmed.",
  "provider-plan": "Derived from the provider's configured plan settings, not a billed record.",
};
