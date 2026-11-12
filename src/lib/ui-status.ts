/**
 * Shared status vocabulary for dashboard chrome (web).
 * Mirrors iOS Theme.SemanticStatus so both platforms use the same labels.
 */

export type UiSemanticStatus = "ok" | "warning" | "danger" | "neutral" | "incomplete";

export type OverallAccountStatus = "ok" | "warning" | "exceeded" | "unconfigured";

export function accountStatusLabel(status: OverallAccountStatus): string {
  switch (status) {
    case "exceeded":
      return "Over budget";
    case "warning":
      return "Watch spend";
    case "ok":
      return "On track";
    case "unconfigured":
      return "No budget set";
  }
}

export function accountStatusToSemantic(status: OverallAccountStatus): UiSemanticStatus {
  switch (status) {
    case "exceeded":
      return "danger";
    case "warning":
      return "warning";
    case "ok":
      return "ok";
    case "unconfigured":
      return "neutral";
  }
}

/**
 * Derive account-level status from provider alert severities + incomplete coverage.
 * Budget meter math (if totalBudget provided) can escalate to warning/exceeded.
 */
export function deriveAccountStatus(input: {
  criticalCount: number;
  warningCount: number;
  incompleteCostCount: number;
  totalSpentUsd: number;
  totalBudgetUsd: number | null;
}): OverallAccountStatus {
  const budget = input.totalBudgetUsd;
  if (budget != null && budget > 0) {
    if (input.totalSpentUsd >= budget) return "exceeded";
    if (input.totalSpentUsd / budget >= 0.8) return "warning";
  }
  if (input.criticalCount > 0) return "exceeded";
  if (input.warningCount > 0 || input.incompleteCostCount > 0) return "warning";
  if (budget == null || budget <= 0) return "unconfigured";
  return "ok";
}

/** Spend amount color — amber only when incomplete/warning; red when over; neutral when fine. */
export function spendAmountClass(status: OverallAccountStatus, incomplete: boolean): string {
  if (status === "exceeded") return "text-red-600 dark:text-red-400";
  if (status === "warning" || incomplete) return "text-amber-600 dark:text-amber-400";
  return "text-gray-900 dark:text-gray-100";
}

export function statusBadgeClasses(status: UiSemanticStatus): string {
  switch (status) {
    case "danger":
      return "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300";
    case "warning":
      return "bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200";
    case "ok":
      return "bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200";
    case "incomplete":
      // Slate — incomplete coverage is not budget risk (amber) or brand orange.
      return "bg-slate-100 text-slate-700 dark:bg-slate-800/80 dark:text-slate-200";
    case "neutral":
    default:
      return "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300";
  }
}
