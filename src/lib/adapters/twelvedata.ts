import {
  AdapterError,
  errorResult,
  fetchJson,
  headerNumber,
  parseNumber,
  type AdapterExternalBillingRecord,
  type UsageResult,
} from "./helpers";

function nonNegativeNumber(value: unknown): number | null {
  const parsed = parseNumber(value);
  return parsed != null && parsed >= 0 ? parsed : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function fetchUsage(apiKey: string): Promise<UsageResult> {
  const response = await fetchJson("https://api.twelvedata.com/api_usage", {
    headers: { Authorization: `apikey ${apiKey}` },
  });
  if (!response.ok) return errorResult(response.status);

  if (
    !response.data ||
    typeof response.data !== "object" ||
    Array.isArray(response.data)
  ) {
    throw new AdapterError("Twelve Data returned an invalid API-usage response", {
      code: "INVALID_RESPONSE",
    });
  }
  const data = response.data as Record<string, unknown>;
  if (data.status === "error") {
    return errorResult(parseNumber(data.code) ?? 400, {
      note: typeof data.message === "string" ? data.message : undefined,
    });
  }

  // The current contract returns minute/day quota state in the response body.
  // Keep the former response-header parser only as a fallback for accounts or
  // edge deployments that still return the legacy shape. Never combine the two
  // scopes: a body minute count plus a legacy header remainder may describe
  // different windows.
  const hasBodyMinuteQuota =
    data.current_usage !== undefined || data.plan_limit !== undefined;
  const legacyUsed = headerNumber(response.headers, [
    "api-credits-used",
    "api-credits-request",
  ]);
  const legacyRemaining = headerNumber(response.headers, ["api-credits-left"]);
  const legacyLimit =
    legacyUsed != null && legacyRemaining != null
      ? legacyUsed + legacyRemaining
      : null;

  const minuteUsed = hasBodyMinuteQuota
    ? nonNegativeNumber(data.current_usage)
    : legacyUsed;
  const minuteLimit = hasBodyMinuteQuota
    ? nonNegativeNumber(data.plan_limit)
    : legacyLimit;
  const minuteRemaining =
    minuteUsed != null && minuteLimit != null
      ? Math.max(0, minuteLimit - minuteUsed)
      : hasBodyMinuteQuota
        ? null
        : legacyRemaining;

  const dailyUsed = nonNegativeNumber(data.daily_usage);
  const dailyLimit = nonNegativeNumber(data.plan_daily_limit);
  const dailyRemaining =
    dailyUsed != null && dailyLimit != null
      ? Math.max(0, dailyLimit - dailyUsed)
      : null;

  const planValue = data.plan;
  const legacyPlanName =
    nonEmptyString(planValue) ??
    (planValue && typeof planValue === "object"
      ? nonEmptyString((planValue as Record<string, unknown>).name)
      : null);
  const planName = nonEmptyString(data.plan_category) ?? legacyPlanName;

  const records: AdapterExternalBillingRecord[] = [];
  if (
    minuteUsed != null ||
    minuteLimit != null ||
    minuteRemaining != null
  ) {
    records.push({
      externalId: "api-plan-minute-quota",
      kind: "plan",
      serviceName: "Twelve Data API",
      planName,
      status: "active",
      requestLimit: minuteLimit,
      requestLimitWindow: "minute",
      usageQuantity: minuteUsed,
      remainingQuantity: minuteRemaining,
      usageUnit: hasBodyMinuteQuota ? "requests" : "credits",
      rollupRole: "metadata",
    });
  }
  if (dailyUsed != null || dailyLimit != null) {
    records.push({
      externalId: "api-plan-daily-quota",
      kind: "plan",
      serviceName: "Twelve Data API",
      planName,
      status: "active",
      requestLimit: dailyLimit,
      requestLimitWindow: "day",
      usageQuantity: dailyUsed,
      remainingQuantity: dailyRemaining,
      usageUnit: "requests",
      rollupRole: "metadata",
    });
  }
  if (records.length === 0 && planName) {
    records.push({
      externalId: "api-plan",
      kind: "plan",
      serviceName: "Twelve Data API",
      planName,
      status: "active",
      rollupRole: "metadata",
    });
  }

  return {
    balance: null,
    totalCost: null,
    costScope: "unknown",
    // Prefer the broader daily window when the account exposes it. Minute and
    // day quotas remain separate in externalBilling below.
    totalRequests: dailyUsed ?? minuteUsed,
    credits: dailyRemaining ?? minuteRemaining,
    rawData: {
      // Keep only the documented account/quota fields. Unknown future fields
      // may contain identity data and do not belong in a persisted snapshot.
      planName,
      providerTimestamp: nonEmptyString(data.timestamp),
      minuteQuota: {
        source: hasBodyMinuteQuota ? "response-body" : "legacy-response-headers",
        used: minuteUsed,
        limit: minuteLimit,
        remaining: minuteRemaining,
      },
      dailyQuota: {
        used: dailyUsed,
        limit: dailyLimit,
        remaining: dailyRemaining,
      },
      endpointCreditCost: 1,
      note: "Each /api_usage poll consumes 1 Twelve Data API credit. This endpoint does not expose USD billing cost or renewal dates.",
      capabilities: {
        currentPlan: planName != null,
        minuteQuota: minuteUsed != null || minuteLimit != null,
        dailyQuota: dailyUsed != null || dailyLimit != null,
        pollConsumesCredits: true,
        billingCost: false,
        renewalDate: false,
      },
    },
    externalBilling: records.length > 0
      ? {
          source: "twelve-data-api-usage",
          authoritative: true,
          records,
        }
      : undefined,
  };
}
