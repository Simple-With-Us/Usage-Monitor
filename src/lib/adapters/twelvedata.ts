import {
  errorResult,
  fetchJson,
  headerNumber,
  parseNumber,
  type UsageResult,
} from "./helpers";

export async function fetchUsage(apiKey: string): Promise<UsageResult> {
  const response = await fetchJson("https://api.twelvedata.com/api_usage", {
    headers: { Authorization: `apikey ${apiKey}` },
  });
  if (!response.ok) return errorResult(response.status);

  const data = (response.data ?? {}) as Record<string, unknown>;
  if (data.status === "error") {
    return errorResult(parseNumber(data.code) ?? 400, {
      note: typeof data.message === "string" ? data.message : undefined,
    });
  }

  // Twelve Data documents these response headers as the real-time source of
  // truth. The /api_usage body additionally carries current plan details.
  const used = headerNumber(response.headers, [
    "api-credits-used",
    "api-credits-request",
  ]);
  const remaining = headerNumber(response.headers, ["api-credits-left"]);
  const creditLimit =
    used != null && remaining != null ? used + remaining : null;
  const planValue = data.plan;
  const planName = typeof planValue === "string"
    ? planValue
    : planValue && typeof planValue === "object"
      ? ((planValue as Record<string, unknown>).name as string | undefined) ?? null
      : null;

  return {
    balance: null,
    totalCost: null,
    totalRequests: used,
    credits: remaining,
    rawData: {
      usage: data,
      apiCreditsUsed: used,
      apiCreditsRemaining: remaining,
      apiCreditsLimit: creditLimit,
      capabilities: {
        currentPlan: true,
        realtimeCredits: true,
        billingCost: false,
        renewalDate: false,
      },
    },
    externalBilling: planName || creditLimit != null
      ? {
          source: "twelve-data-api-usage",
          authoritative: true,
          records: [
            {
              externalId: "api-plan",
              kind: "plan",
              planName,
              status: "active",
              requestLimit: creditLimit,
              requestLimitWindow: "provider-defined-credit-window",
            },
          ],
        }
      : undefined,
  };
}
