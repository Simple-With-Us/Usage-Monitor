/**
 * Shared display formatting (U7 consolidation).
 *
 * Every money/count/date rendering in the UI funnels through these helpers so
 * fraction-digit rules (max 2) and null-state vocabulary stay consistent.
 *
 * Null-state convention:
 *  - `NULL_DISPLAY` ("--") for compact contexts — table cells, cards, charts,
 *    where an absent value just needs a placeholder.
 *  - `NOT_REPORTED` ("not reported") for prose contexts where the absence
 *    itself needs a short explanation (billing inventory, quota rows) — value
 *    casing, not a heading (fleet UI copy: /Users/jay/apps/FLEET-UI-COPY.md).
 * Pass `nullState` to opt into the prose form; the compact form is the default.
 */

export const NULL_DISPLAY = "--";
export const NOT_REPORTED = "not reported";

export interface FormatCurrencyOptions {
  /** ISO currency code; defaults to USD. A present-but-blank code formats as a raw "UNKNOWN" amount. */
  currency?: string;
  nullState?: string;
  /** Unified rule: never more than 2 fraction digits. */
  maximumFractionDigits?: number;
  /** Rarely needed — Intl defaults to the currency's own minimum (2 for USD). */
  minimumFractionDigits?: number;
}

export function formatCurrency(
  amount: number | null | undefined,
  options: FormatCurrencyOptions = {}
): string {
  const {
    currency = "USD",
    nullState = NULL_DISPLAY,
    maximumFractionDigits = 2,
    minimumFractionDigits,
  } = options;
  if (amount == null || !Number.isFinite(amount)) return nullState;
  const normalizedCurrency =
    currency.trim().toUpperCase() || "UNKNOWN";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: normalizedCurrency,
      maximumFractionDigits,
      ...(minimumFractionDigits != null ? { minimumFractionDigits } : {}),
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${normalizedCurrency}`;
  }
}

export interface FormatNumberOptions {
  nullState?: string;
  /** Unified rule: never more than 2 fraction digits. */
  maximumFractionDigits?: number;
}

export function formatNumber(
  amount: number | null | undefined,
  options: FormatNumberOptions = {}
): string {
  const { nullState = NULL_DISPLAY, maximumFractionDigits = 2 } = options;
  if (amount == null || !Number.isFinite(amount)) return nullState;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(amount);
}

/** Compact-notation count (1.2K, 10M) for chart axes and large quotas. */
export function formatCompactNumber(
  value: number,
  options: { maximumFractionDigits?: number } = {}
): string {
  const { maximumFractionDigits = 1 } = options;
  // Lowercase compact suffixes (1.2k, 10m) — fleet UI copy.
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits,
  })
    .format(value)
    .replace(/([0-9])([KMB])\b/g, (_, d, s) => d + s.toLowerCase());
}

export interface FormatDateOptions {
  nullState?: string;
  /** Defaults to `nullState` when the value is present but unparseable. */
  invalidState?: string;
}

/** Absolute calendar date in UTC (the app's money months are UTC months). */
export function formatDate(
  value: string | null | undefined,
  options: FormatDateOptions = {}
): string {
  const { nullState = NULL_DISPLAY, invalidState } = options;
  if (!value) return nullState;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return invalidState ?? nullState;
  return new Date(time).toLocaleDateString(undefined, { timeZone: "UTC" });
}

/**
 * Short absolute date for a NON-relative context (e.g. a future renewal or a
 * budget runout). Never route a future-dated value through a relative-time
 * formatter whose future/negative clamp collapses to "just now".
 */
export function formatShortDate(value: string, nowMs: number): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return NULL_DISPLAY;
  const date = new Date(time);
  const now = new Date(nowMs);
  const formatted = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  return date.getUTCFullYear() === now.getUTCFullYear()
    ? formatted
    : `${formatted}, ${date.getUTCFullYear()}`;
}

/**
 * Server-provided projection intelligence from the budget-status DTO
 * (`ProviderBudgetStatus` in src/lib/budget-status.ts — S9/S10). Threaded to
 * client components by pages that read GET /api/budget-status.
 */
export interface ProviderBudgetIntel {
  projectedStatus?: "ok" | "warning" | "exceeded" | "unconfigured" | null;
  projectedRunoutDate?: string | null;
  daysUntilBudgetExhausted?: number | null;
}

/**
 * Subtle info text for attention/detail surfaces — "Budget exhausts ~Aug 22
 * at current burn". Returns null when the DTO carries no runout signal
 * (budget unconfigured or never projected to cross). Deliberately NOT an
 * alert: this is informational runway text.
 */
export function formatBudgetRunout(
  intel: ProviderBudgetIntel,
  nowMs: number = Date.now()
): string | null {
  const days = intel.daysUntilBudgetExhausted;
  if (days == null && !intel.projectedRunoutDate) return null;
  if (days != null && days <= 0) return "Budget exhausted at current burn";
  if (!intel.projectedRunoutDate) return null;
  if (!Number.isFinite(Date.parse(intel.projectedRunoutDate))) return null;
  return `Budget exhausts ~${formatShortDate(intel.projectedRunoutDate, nowMs)} at current burn`;
}

/**
 * Short badge label for a projected (runway) status that is worse than "ok".
 * Returns null for ok/unconfigured/absent so callers render nothing.
 */
export function projectedStatusLabel(
  status: ProviderBudgetIntel["projectedStatus"]
): string | null {
  if (status === "exceeded") return "On pace to exceed budget";
  if (status === "warning") return "On pace for budget warning";
  return null;
}
