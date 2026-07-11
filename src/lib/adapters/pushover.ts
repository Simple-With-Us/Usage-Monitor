import {
  errorResult,
  fetchJson,
  parseNumber,
  type UsageResult,
} from "./helpers";

function previousMonthlyBoundary(date: Date): Date {
  const previousMonthLastDay = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 0)
  ).getUTCDate();
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth() - 1,
      Math.min(date.getUTCDate(), previousMonthLastDay),
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds()
    )
  );
}

export async function fetchUsage(apiKey: string): Promise<UsageResult> {
  const now = new Date();
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
  const resetDate = resetAt ? new Date(resetAt) : null;
  const requestWindowStart =
    resetDate && resetDate.getTime() > now.getTime()
      ? previousMonthlyBoundary(resetDate)
      : null;

  return {
    balance: null,
    totalCost: null,
    totalRequests:
      limit != null && remaining != null ? Math.max(0, limit - remaining) : null,
    requestUnit:
      limit != null && remaining != null ? "messages" : null,
    requestWindow:
      limit != null && remaining != null ? "billing_cycle_to_date" : null,
    requestWindowStart:
      limit != null && remaining != null ? requestWindowStart : null,
    requestWindowEnd:
      limit != null && remaining != null ? now : null,
    credits: remaining,
    rawData: {
      monthlyMessageLimit: limit,
      monthlyMessagesRemaining: remaining,
      resetAt,
      capabilities: {
        messageQuota: true,
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
              planName: "Pushover application quota",
              status: "active",
              requestLimit: limit,
              requestLimitWindow: "month",
              currentPeriodEnd: resetAt,
            },
          ],
        }
      : undefined,
  };
}
