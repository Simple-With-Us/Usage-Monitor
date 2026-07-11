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
        isEnabled?: boolean;
        monthlyBasePriceUsd?: number;
        monthlyUsageCreditsUsd?: number;
        usageDiscountPercent?: number;
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
    monthlyBasePrice != null || usedMonthly != null
      ? Math.max(monthlyBasePrice ?? 0, usedMonthly ?? 0)
      : null;
  const cycleStart = limitsData.data?.monthlyUsageCycle?.startAt ?? null;
  const cycleEnd = limitsData.data?.monthlyUsageCycle?.endAt ?? null;

  return {
    balance,
    totalCost: currentBill,
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
                  isEnabled: plan.isEnabled,
                  monthlyBasePriceUsd: plan.monthlyBasePriceUsd,
                  monthlyUsageCreditsUsd: plan.monthlyUsageCreditsUsd,
                  usageDiscountPercent: plan.usageDiscountPercent,
                }
              : null,
          }
        : null,
      billing: {
        currentUsageUsd: usedMonthly,
        estimatedCurrentBillUsd: currentBill,
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
              kind: "plan",
              planName: plan.description ?? plan.id ?? null,
              status: plan.isEnabled === false ? "inactive" : "active",
              amountUsd: monthlyBasePrice,
              currency: "USD",
              billingInterval: "monthly",
              currentPeriodStart: cycleStart,
              currentPeriodEnd: cycleEnd,
              nextRenewalAt: cycleEnd,
              spendLimitUsd: maxMonthly,
              spendLimitWindow: "month",
            },
          ],
        }
      : undefined,
  };
}
