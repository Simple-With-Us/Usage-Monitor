import {
  errorResult,
  fetchJson,
  parseNumber,
  type UsageResult,
} from "./helpers";

export async function fetchUsage(apiKey: string): Promise<UsageResult> {
  const res = await fetchJson(
    `https://api.pushover.net/1/apps/limits.json?token=${encodeURIComponent(apiKey)}`
  );

  if (!res.ok) {
    return errorResult(res.status, { response: res.data });
  }

  const data = res.data as {
    status?: number;
    limit?: number;
    remaining?: number;
    reset?: number;
  };
  if (data.status !== 1) {
    return errorResult(400, { note: "Pushover returned an unsuccessful status" });
  }

  const limit = parseNumber(data.limit);
  const remaining = parseNumber(data.remaining);
  const resetAt =
    typeof data.reset === "number"
      ? new Date(data.reset * 1000).toISOString()
      : null;

  return {
    balance: null,
    totalCost: null,
    totalRequests:
      limit != null && remaining != null ? Math.max(0, limit - remaining) : null,
    credits: remaining,
    rawData: {
      quotaScope: "account-or-team-pool",
      monthlyMessageLimit: limit,
      monthlyMessagesRemaining: remaining,
      resetAt,
      capabilities: {
        messageQuota: true,
        pooledQuotaSince: "2026-05-01",
        billingCost: false,
        subscriptionStatus: false,
      },
    },
    externalBilling: limit != null
      ? {
          source: "pushover-application-limits",
          authoritative: true,
          records: [
            {
              externalId: "application-quota",
              kind: "account",
              serviceName: "Pushover messages",
              planName: "Pooled account/team quota",
              status: "active",
              requestLimit: limit,
              requestLimitWindow: "month",
              usageQuantity:
                limit != null && remaining != null
                  ? Math.max(0, limit - remaining)
                  : null,
              remainingQuantity: remaining,
              usageUnit: "messages",
              nextRenewalAt: resetAt,
              currentPeriodEnd: resetAt,
              rollupRole: "metadata",
              dateKind: "quota_reset",
            },
          ],
        }
      : undefined,
  };
}
