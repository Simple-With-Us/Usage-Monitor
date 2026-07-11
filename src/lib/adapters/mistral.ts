import {
  errorResult,
  fetchJson,
  parseNumber,
  type UsageResult,
} from "./helpers";

export async function fetchUsage(
  apiKey: string,
  config?: Record<string, unknown>
): Promise<UsageResult> {
  const adminApiKey =
    (config?.adminApiKey as string | undefined)?.trim() || apiKey;
  const headers = { "x-api-key": adminApiKey };
  const now = new Date();
  const params = new URLSearchParams({
    month: String(now.getUTCMonth() + 1),
    year: String(now.getUTCFullYear()),
  });
  const base = "https://console.mistral.ai/api/admin";

  const [usageResponse, limitsResponse, rateResponse] = await Promise.all([
    fetchJson(`${base}/usage?${params}`, { headers }),
    fetchJson(`${base}/spend-limit`, { headers }),
    fetchJson(`${base}/rate-limit`, { headers }),
  ]);

  if (!usageResponse.ok && !limitsResponse.ok && !rateResponse.ok) {
    return errorResult(
      usageResponse.status || limitsResponse.status || rateResponse.status,
      { note: "Mistral billing endpoints require a Backoffice Admin API key" }
    );
  }

  const usage = (usageResponse.data ?? {}) as {
    start_date?: string;
    end_date?: string;
    date?: string;
    currency?: string;
    [key: string]: unknown;
  };
  const limits = (limitsResponse.data ?? {}) as {
    limits?: {
      completion?: {
        no_monthly_limit?: boolean;
        monthly_limit_reached?: boolean;
        usage?: number;
        total_usage?: number;
        usage_limit?: number;
        usage_limit_organization?: number;
      };
      last_payment_failure?: boolean;
      currency?: string;
    };
  };
  const rate = (rateResponse.data ?? {}) as {
    requests_per_second?: number;
    tokens_limits_by_model?: unknown;
  };
  const completion = limits.limits?.completion;
  const totalCost =
    parseNumber(completion?.total_usage) ?? parseNumber(completion?.usage);
  const spendLimitUsd =
    parseNumber(completion?.usage_limit) ??
    parseNumber(completion?.usage_limit_organization);
  const currency = usage.currency ?? limits.limits?.currency ?? null;
  const isUsd = currency == null || currency.toUpperCase() === "USD";
  const balance =
    isUsd && totalCost != null && spendLimitUsd != null
      ? Math.max(0, spendLimitUsd - totalCost)
      : null;
  const periodStart = usage.start_date ??
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const periodEnd = usage.end_date ?? now.toISOString();
  const periodId = periodStart.slice(0, 7);
  const status = limits.limits?.last_payment_failure
    ? "payment_failed"
    : completion?.monthly_limit_reached
      ? "limit_reached"
      : "active";

  return {
    balance,
    totalCost: isUsd ? totalCost : null,
    totalRequests: null,
    credits: balance,
    rawData: {
      usage: usageResponse.ok ? usage : null,
      spendLimit: limitsResponse.ok ? limits : null,
      rateLimit: rateResponse.ok ? rate : null,
      capabilities: {
        actualCost: limitsResponse.ok,
        usageBreakdown: usageResponse.ok,
        spendLimit: limitsResponse.ok,
        rateLimit: rateResponse.ok,
        credential: "Mistral Backoffice Admin API key",
      },
    },
    externalBilling: limitsResponse.ok || usageResponse.ok
      ? {
          source: "mistral-admin-billing",
          authoritative: true,
          records: [
            {
              externalId: periodId,
              kind: "billing_period",
              planName: "Mistral organization usage",
              status,
              amountUsd: isUsd ? totalCost : null,
              currency,
              currentPeriodStart: periodStart,
              currentPeriodEnd: periodEnd,
              requestLimit: parseNumber(rate.requests_per_second),
              requestLimitWindow: "second",
              spendLimitUsd: isUsd ? spendLimitUsd : null,
              spendLimitWindow: completion?.no_monthly_limit ? null : "month",
            },
          ],
        }
      : undefined,
  };
}
