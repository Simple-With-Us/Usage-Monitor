import { calculateEomForecast } from "@/lib/forecasting";
import { isSubscriptionInterval, rollForwardRenewal } from "@/lib/subscriptions";

export type AlertSeverity = "critical" | "warning" | "info";

export interface ProviderAlert {
  code:
    | "budget_exceeded"
    | "budget_warning"
    | "balance_low"
    | "credits_low"
    | "request_limit"
    | "request_limit_warning"
    | "renewal_overdue"
    | "renewal_due"
    | "missing_balance_visibility"
    | "stale_snapshot"
    | "missing_snapshot"
    | "unconfigured_budget";
  severity: AlertSeverity;
  message: string;
}

export interface ProviderPlanForAlerts {
  billingMode: string;
  fixedMonthlyCostUsd: number | null;
  monthlyBudgetUsd: number | null;
  monthlyRequestLimit: number | null;
  lowBalanceUsd: number | null;
  lowCredits: number | null;
  renewalDate: Date | string | null;
  billingInterval?: string | null;
  mustKeepFunded: boolean;
}

export interface UsageSnapshotForAlerts {
  balance: number | null;
  totalCost: number | null;
  totalRequests: number | null;
  credits: number | null;
  fetchedAt: Date | string;
}

export interface ProviderAlertInput {
  isActive: boolean;
  refreshIntervalMin: number;
  plan: ProviderPlanForAlerts | null;
  latestSnapshot: UsageSnapshotForAlerts | null;
  // Canonical month-to-date spend across poll, pushed usage, subscriptions,
  // and configured fixed cost. When omitted, preserve the legacy snapshot
  // calculation for pure/unit-test callers.
  trackedSpendUsd?: number;
  // Portion of trackedSpendUsd that is already a discrete/fixed charge and
  // must not be linearly extrapolated to month end.
  fixedAccruedUsd?: number;
}

export interface ProviderAlertState {
  alerts: ProviderAlert[];
  estimatedMonthlyCostUsd: number;
  projectedEomUsd: number;
  billingMode: "actual" | "estimated" | "manual";
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const WARNING_RATIO = 0.8;
const RENEWAL_WARNING_DAYS = 7;

function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function normalizeBillingMode(value: string | undefined): ProviderAlertState["billingMode"] {
  if (value === "actual" || value === "estimated" || value === "manual") {
    return value;
  }
  return "manual";
}

export function buildProviderAlertState(
  input: ProviderAlertInput,
  now = new Date()
): ProviderAlertState {
  const alerts: ProviderAlert[] = [];
  const { plan, latestSnapshot } = input;
  const fixedMonthlyCost = plan?.fixedMonthlyCostUsd ?? 0;
  const usageCost = latestSnapshot?.totalCost ?? 0;
  const estimatedMonthlyCostUsd = input.trackedSpendUsd ?? fixedMonthlyCost + usageCost;
  const projectedEomUsd = calculateEomForecast(
    estimatedMonthlyCostUsd,
    input.fixedAccruedUsd ?? fixedMonthlyCost,
    now
  );
  const billingMode = normalizeBillingMode(plan?.billingMode);

  if (!input.isActive) {
    return { alerts, estimatedMonthlyCostUsd, projectedEomUsd, billingMode };
  }

  if (!plan) {
    alerts.push({
      code: "unconfigured_budget",
      severity: "info",
      message: "No budget, renewal, or limit metadata configured.",
    });
  }

  if (!latestSnapshot) {
    alerts.push({
      code: "missing_snapshot",
      severity: "warning",
      message: "No usage snapshot has been fetched yet.",
    });
  } else {
    const fetchedAt = new Date(latestSnapshot.fetchedAt);
    const staleAfterMs = Math.max(input.refreshIntervalMin * 3 * 60 * 1000, MS_PER_DAY);
    if (now.getTime() - fetchedAt.getTime() > staleAfterMs) {
      alerts.push({
        code: "stale_snapshot",
        severity: "warning",
        message: "Latest usage snapshot is stale.",
      });
    }
  }

  if (plan?.monthlyBudgetUsd != null && plan.monthlyBudgetUsd > 0) {
    if (estimatedMonthlyCostUsd >= plan.monthlyBudgetUsd) {
      alerts.push({
        code: "budget_exceeded",
        severity: "critical",
        message: `${formatUsd(estimatedMonthlyCostUsd)} tracked against ${formatUsd(
          plan.monthlyBudgetUsd
        )} monthly budget.`,
      });
    } else if (estimatedMonthlyCostUsd >= plan.monthlyBudgetUsd * WARNING_RATIO) {
      alerts.push({
        code: "budget_warning",
        severity: "warning",
        message: `${formatUsd(estimatedMonthlyCostUsd)} tracked against ${formatUsd(
          plan.monthlyBudgetUsd
        )} monthly budget.`,
      });
    }
  }

  if (latestSnapshot?.totalRequests != null && plan?.monthlyRequestLimit) {
    if (latestSnapshot.totalRequests >= plan.monthlyRequestLimit) {
      alerts.push({
        code: "request_limit",
        severity: "critical",
        message: `${formatNumber(latestSnapshot.totalRequests)} requests against ${formatNumber(
          plan.monthlyRequestLimit
        )} monthly limit.`,
      });
    } else if (latestSnapshot.totalRequests >= plan.monthlyRequestLimit * WARNING_RATIO) {
      alerts.push({
        code: "request_limit_warning",
        severity: "warning",
        message: `${formatNumber(latestSnapshot.totalRequests)} requests against ${formatNumber(
          plan.monthlyRequestLimit
        )} monthly limit.`,
      });
    }
  }

  const balanceFloor = plan?.lowBalanceUsd ?? (plan?.mustKeepFunded ? 0 : null);
  if (latestSnapshot?.balance != null && balanceFloor != null) {
    if (latestSnapshot.balance <= balanceFloor) {
      alerts.push({
        code: "balance_low",
        severity: latestSnapshot.balance <= 0 || plan?.mustKeepFunded ? "critical" : "warning",
        message: `Balance ${formatUsd(latestSnapshot.balance)} is at or below ${formatUsd(
          balanceFloor
        )}.`,
      });
    }
  } else if (plan?.mustKeepFunded && latestSnapshot?.balance == null) {
    alerts.push({
      code: "missing_balance_visibility",
      severity: "warning",
      message: "Marked must-keep-funded, but no balance is visible.",
    });
  }

  if (
    latestSnapshot?.credits != null &&
    plan?.lowCredits != null &&
    latestSnapshot.credits <= plan.lowCredits
  ) {
    alerts.push({
      code: "credits_low",
      severity: "warning",
      message: `${formatNumber(latestSnapshot.credits)} credits at or below ${formatNumber(
        plan.lowCredits
      )}.`,
    });
  }

  if (plan?.renewalDate) {
    const rawRenewal = new Date(plan.renewalDate);
    // When a cadence is known, roll a past renewalDate forward to the next
    // upcoming occurrence so a recurring plan never reads as permanently
    // "overdue" once its date passes (the persisted date is advanced on the
    // maintenance cycle — see rollForwardProviderRenewals). Without a cadence
    // there is nothing to advance to, so a past date is genuinely overdue.
    const interval =
      plan.billingInterval && isSubscriptionInterval(plan.billingInterval)
        ? plan.billingInterval
        : null;
    const renewal = interval ? rollForwardRenewal(rawRenewal, interval, 1, now) : rawRenewal;
    const daysUntilRenewal = Math.ceil(
      (renewal.getTime() - now.getTime()) / MS_PER_DAY
    );
    if (daysUntilRenewal < 0) {
      alerts.push({
        code: "renewal_overdue",
        severity: "critical",
        message: "Plan renewal date has passed.",
      });
    } else if (daysUntilRenewal <= RENEWAL_WARNING_DAYS) {
      alerts.push({
        code: "renewal_due",
        severity: "warning",
        message: `Plan renews in ${daysUntilRenewal} day${
          daysUntilRenewal === 1 ? "" : "s"
        }.`,
      });
    }
  }

  return { alerts, estimatedMonthlyCostUsd, projectedEomUsd, billingMode };
}
