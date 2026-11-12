import {
  errorResult,
  fetchJson,
  parseNumber,
  type UsageResult,
} from "./helpers";

export async function fetchUsage(apiKey: string): Promise<UsageResult> {
  const headers = { Authorization: `Bearer ${apiKey}` };
  const [limitsResponse, userResponse] = await Promise.all([
    fetchJson("https://api.apify.com/v2/users/me/limits", { headers }),
    fetchJson("https://api.apify.com/v2/users/me", { headers }),
  ]);

  if (!limitsResponse.ok && !userResponse.ok) {
    return errorResult(limitsResponse.status || userResponse.status, {
      note: "Apify limits and account plan were both unavailable",
    });
  }

  const limitsData = limitsResponse.data as {
    data?: {
      monthlyUsageCycle?: { startAt?: string; endAt?: string };
      limits?: { maxMonthlyUsageUsd?: number };
      current?: { monthlyUsageUsd?: number };
    };
  };
  const userData = userResponse.data as {
    data?: {
      isPaying?: boolean;
      plan?: {
        id?: string;
        description?: string;
        tier?: string;
        isEnabled?: boolean;
        monthlyBasePriceUsd?: number;
        monthlyUsageCreditsUsd?: number;
        usageDiscountPercent?: number;
        teamAccountSeatCount?: number;
        supportLevel?: string;
        availableAddOns?: unknown[];
        enabledPlatformFeatures?: string[];
      };
    };
  };

  const maxMonthly = parseNumber(
    limitsData.data?.limits?.maxMonthlyUsageUsd
  );
  const usedMonthly = parseNumber(
    limitsData.data?.current?.monthlyUsageUsd
  );
  const plan = userResponse.ok ? userData.data?.plan : undefined;
  const monthlyBasePrice = parseNumber(plan?.monthlyBasePriceUsd);
  const includedCredits = parseNumber(plan?.monthlyUsageCreditsUsd);
  const balance =
    includedCredits != null && usedMonthly != null
      ? Math.max(0, includedCredits - usedMonthly)
      : null;
  const currentBill =
    monthlyBasePrice != null && usedMonthly != null && includedCredits != null
      ? monthlyBasePrice + Math.max(0, usedMonthly - includedCredits)
      : monthlyBasePrice != null || usedMonthly != null
        ? Math.max(monthlyBasePrice ?? 0, usedMonthly ?? 0)
        : null;
  const cycleStart = limitsData.data?.monthlyUsageCycle?.startAt ?? null;
  const cycleEnd = limitsData.data?.monthlyUsageCycle?.endAt ?? null;
  const now = new Date();
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const nextMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  const cycleStartMs = cycleStart ? Date.parse(cycleStart) : Number.NaN;
  const isCurrentMonthCycle =
    Number.isFinite(cycleStartMs) &&
    cycleStartMs >= monthStart &&
    cycleStartMs < nextMonth;
  const canonicalBill = isCurrentMonthCycle ? currentBill : null;

  return {
    balance,
    totalCost: canonicalBill,
    fixedCostIncludedUsd:
      canonicalBill != null && monthlyBasePrice != null
        ? Math.min(canonicalBill, Math.max(0, monthlyBasePrice))
        : null,
    costWindowStart: canonicalBill != null ? cycleStart : null,
    costWindowEnd: canonicalBill != null ? cycleEnd : null,
    costScope: canonicalBill != null ? "billing_cycle_to_date" : "unknown",
    totalRequests: null,
    credits: balance,
    rawData: {
      usageCycle: limitsData.data?.monthlyUsageCycle ?? null,
      limits: limitsData.data?.limits ?? null,
      current: limitsData.data?.current ?? null,
      // Deliberately select only billing-safe fields: /users/me also returns a
      // proxy password, which must never enter snapshot rawData.
      account: userResponse.ok
        ? {
            isPaying: userData.data?.isPaying ?? null,
            plan: plan
              ? {
                  id: plan.id,
                  description: plan.description,
                  tier: plan.tier,
                  isEnabled: plan.isEnabled,
                  monthlyBasePriceUsd: plan.monthlyBasePriceUsd,
                  monthlyUsageCreditsUsd: plan.monthlyUsageCreditsUsd,
                  usageDiscountPercent: plan.usageDiscountPercent,
                  teamAccountSeatCount: plan.teamAccountSeatCount,
                  supportLevel: plan.supportLevel,
                  availableAddOnCount: Array.isArray(plan.availableAddOns)
                    ? plan.availableAddOns.length
                    : null,
                  enabledPlatformFeatures: Array.isArray(plan.enabledPlatformFeatures)
                    ? plan.enabledPlatformFeatures.filter((feature) => typeof feature === "string").slice(0, 100)
                    : [],
                }
              : null,
          }
        : null,
      billing: {
        currentUsageUsd: usedMonthly,
        estimatedCurrentBillUsd: currentBill,
        includedInCurrentMonthBudget: canonicalBill != null,
        includedCreditsRemainingUsd: balance,
        maximumUsageLimitUsd: maxMonthly,
      },
      capabilities: {
        actualUsageCost: limitsResponse.ok,
        billingPeriod: limitsResponse.ok,
        planStatus: userResponse.ok,
        planPrice: userResponse.ok,
      },
    },
    externalBilling: plan
      ? {
          source: "apify-account-plan",
          authoritative: true,
          records: [
            {
              externalId: plan.id ?? "account-plan",
              paidRecurringAuthoritative:
                userData.data?.isPaying === true &&
                plan.isEnabled !== false &&
                monthlyBasePrice != null &&
                monthlyBasePrice > 0,
              kind: "plan",
              serviceName: "Apify platform",
              planName: plan.description ?? plan.tier ?? plan.id ?? null,
              status: plan.isEnabled === false ? "inactive" : "active",
              amountUsd: monthlyBasePrice,
              currency: "USD",
              billingInterval: "monthly",
              currentPeriodStart: cycleStart,
              currentPeriodEnd: cycleEnd,
              spendLimitUsd: maxMonthly,
              spendLimitWindow: "month",
              usageQuantity: usedMonthly,
              remainingQuantity: balance,
              usageUnit: "USD credits",
              rollupRole: "canonical",
              dateKind: "period_end",
            },
          ],
        }
      : undefined,
  };
}
