import type { Prisma } from "@prisma/client";
import type { ProviderPlanInput } from "@/lib/provider-input";

/**
 * A provider's recurring fee is modeled EITHER as ProviderPlan.fixedMonthlyCostUsd
 * OR as a Subscription — never both, or the two double-count in the projected
 * spend. Shared by all three writers of that invariant (POST /api/subscriptions,
 * PUT /api/providers/:id, and the external-billing adoption job) so they cannot
 * drift apart.
 */
export function planFixedCostConflicts(
  fixedMonthlyCostUsd: number | null | undefined
): boolean {
  return (
    fixedMonthlyCostUsd != null &&
    Number.isFinite(fixedMonthlyCostUsd) &&
    fixedMonthlyCostUsd > 0
  );
}

/**
 * Thrown from inside an interactive transaction when the in-transaction recheck
 * finds the opposing side of that invariant already committed. Routes catch it
 * and return the same 400 their pre-transaction preflight would have, so the
 * rollback is what makes the exclusivity authoritative rather than advisory.
 */
export class PlanSubscriptionExclusivityError extends Error {
  constructor(message = "Plan price and Subscription are mutually exclusive") {
    super(message);
    this.name = "PlanSubscriptionExclusivityError";
  }
}

export function toPrismaProviderPlanData(
  plan: ProviderPlanInput
): Prisma.ProviderPlanCreateWithoutProviderInput {
  return {
    billingMode: plan.billingMode ?? "manual",
    fixedMonthlyCostUsd: plan.fixedMonthlyCostUsd,
    monthlyBudgetUsd: plan.monthlyBudgetUsd,
    monthlyRequestLimit: plan.monthlyRequestLimit,
    lowBalanceUsd: plan.lowBalanceUsd,
    lowCredits: plan.lowCredits,
    renewalDate: plan.renewalDate,
    billingInterval: plan.billingInterval ?? undefined,
    mustKeepFunded: plan.mustKeepFunded ?? false,
    notes: plan.notes,
  };
}
