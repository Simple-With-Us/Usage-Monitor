import {
  AdapterError,
  errorResult,
  fetchJson,
  headerNumber,
  type UsageResult,
} from "./helpers";

export async function fetchUsage(apiKey: string): Promise<UsageResult> {
  const res = await fetchJson("https://api.resend.com/api-keys", {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "User-Agent": "api-usage-monitor/1.0",
    },
  });

  if (!res.ok) {
    return errorResult(res.status, { response: res.data });
  }

  if (
    !res.data ||
    typeof res.data !== "object" ||
    Array.isArray(res.data) ||
    !Array.isArray((res.data as { data?: unknown }).data)
  ) {
    throw new AdapterError("Resend returned an invalid API-key list", {
      code: "INVALID_RESPONSE",
    });
  }
  const keyCount = (res.data as { data: unknown[] }).data.length;
  const rateLimit = headerNumber(res.headers, ["ratelimit-limit", "x-ratelimit-limit"]);
  const rateRemaining = headerNumber(res.headers, ["ratelimit-remaining", "x-ratelimit-remaining"]);
  const rateReset = res.headers.get("ratelimit-reset") ?? res.headers.get("x-ratelimit-reset");
  // Despite their names, Resend documents these values as USED email counts,
  // not quota limits. Never put them in requestLimit or derive a remainder.
  const monthlyEmailsUsed = headerNumber(res.headers, ["x-resend-monthly-quota"]);
  const dailyEmailsUsed = headerNumber(res.headers, ["x-resend-daily-quota"]);
  const emailUsageRecords = [
    ...(monthlyEmailsUsed != null && monthlyEmailsUsed >= 0
      ? [
          {
            externalId: "monthly-email-usage",
            kind: "account" as const,
            serviceName: "Resend transactional email",
            planName: "Monthly emails used",
            status: "active",
            requestLimitWindow: "month",
            usageQuantity: monthlyEmailsUsed,
            remainingQuantity: null,
            usageUnit: "emails",
            rollupRole: "metadata" as const,
          },
        ]
      : []),
    ...(dailyEmailsUsed != null && dailyEmailsUsed >= 0
      ? [
          {
            externalId: "daily-email-usage",
            kind: "account" as const,
            serviceName: "Resend transactional email",
            planName: "Daily emails used",
            status: "active",
            requestLimitWindow: "day",
            usageQuantity: dailyEmailsUsed,
            remainingQuantity: null,
            usageUnit: "emails",
            rollupRole: "metadata" as const,
          },
        ]
      : []),
  ];

  return {
    balance: null,
    totalCost: null,
    costScope: "unknown",
    totalRequests: null,
    credits: null,
    rawData: {
      apiKeyCount: keyCount,
      apiRateLimit: {
        limit: rateLimit,
        remaining: rateRemaining,
        reset: rateReset,
      },
      emailUsage: {
        monthlyEmailsUsed:
          monthlyEmailsUsed != null && monthlyEmailsUsed >= 0
            ? monthlyEmailsUsed
            : null,
        dailyEmailsUsed:
          dailyEmailsUsed != null && dailyEmailsUsed >= 0
            ? dailyEmailsUsed
            : null,
      },
      note: "Resend quota headers expose used email counts only, not quota limits or remaining email allowance. The non-sending API-key endpoint does not expose plan, renewal, or billing cost.",
      capabilities: {
        nonBillableKeyValidation: true,
        apiRequestRateHeaders: rateLimit != null || rateRemaining != null,
        emailUsageCounts: emailUsageRecords.length > 0,
        emailQuotaLimits: false,
        billingCost: false,
        subscriptionStatus: false,
      },
    },
    externalBilling:
      rateLimit != null || rateRemaining != null
        ? {
            source: "resend-api-rate-limit",
            authoritative: true,
            records: [
              {
                externalId: "account-api-rate-limit",
                kind: "account",
                serviceName: "Resend API",
                planName: "API request rate limit",
                status: "active",
                requestLimit: rateLimit,
                requestLimitWindow: rateReset ? `reset ${rateReset}` : "provider-defined window",
                usageQuantity:
                  rateLimit != null && rateRemaining != null
                    ? Math.max(0, rateLimit - rateRemaining)
                    : null,
                remainingQuantity: rateRemaining,
                usageUnit: "API requests",
                rollupRole: "metadata",
              },
            ],
          }
        : undefined,
    // Header absence is not an authoritative zero: preserve the previous
    // known usage if Resend, a proxy, or a future API version omits both.
    externalBillingSyncs:
      emailUsageRecords.length > 0
        ? [
            {
              source: "resend-email-quota-usage",
              authoritative: true,
              records: emailUsageRecords,
            },
          ]
        : undefined,
  };
}
