import {
  errorResult,
  fetchJson,
  parseNumber,
  type AdapterExternalBillingSync,
  type UsageResult,
} from "./helpers";

function validDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

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
  const spendLimitUsd =
    parseNumber(completion?.usage_limit) ??
    parseNumber(completion?.usage_limit_organization);
  const usageCurrency = typeof usage.currency === "string"
    ? usage.currency.trim().toUpperCase()
    : null;
  const limitsCurrency = typeof limits.limits?.currency === "string"
    ? limits.limits.currency.trim().toUpperCase()
    : "USD";
  const periodStart = validDate(usage.start_date) ? usage.start_date : null;
  const periodEnd = validDate(usage.end_date) ? usage.end_date : null;
  const usageShapeComplete =
    usageResponse.ok &&
    periodStart != null &&
    periodEnd != null &&
    Date.parse(periodEnd) > Date.parse(periodStart) &&
    Boolean(usageCurrency);
  const spendLimitComplete =
    limitsResponse.ok && spendLimitUsd != null && limitsCurrency === "USD";
  const requestLimit = rateResponse.ok
    ? parseNumber(rate.requests_per_second)
    : null;
  const rateLimitComplete = requestLimit != null;
  // The Admin API documents /usage as the cost/consumption source and
  // /spend-limit as limits/status. Its category payload is intentionally
  // open-shaped, however, and the public schema does not define a reliable
  // monetary total field. Never reinterpret spend-limit usage counters as
  // dollars. Until a documented category-cost shape is available, preserve
  // the report for operator inspection but leave monetary totals unknown.
  const totalCost = null;
  const balance = null;
  const status = limits.limits?.last_payment_failure
    ? "payment_failed"
    : completion?.monthly_limit_reached
      ? "limit_reached"
      : "active";
  const billingSyncs: AdapterExternalBillingSync[] = [];

  if (spendLimitComplete) {
    billingSyncs.push({
      source: "mistral-spend-limits",
      authoritative: true,
      records: [
        {
          externalId: "organization",
          kind: "account",
          planName: "Mistral organization spend limit",
          status,
          spendLimitUsd,
          spendLimitWindow: completion?.no_monthly_limit ? null : "month",
        },
      ],
    });
  }
  if (rateLimitComplete) {
    billingSyncs.push({
      source: "mistral-rate-limits",
      authoritative: true,
      records: [
        {
          externalId: "organization",
          kind: "account",
          planName: "Mistral organization rate limit",
          status: "active",
          requestLimit,
          requestLimitWindow: "second",
        },
      ],
    });
  }

  return {
    balance,
    totalCost,
    costWindowStart: null,
    costWindowEnd: null,
    costScope: "unknown",
    totalRequests: null,
    credits: null,
    rawData: {
      usageReport: usageResponse.ok
        ? {
            startDate: periodStart,
            endDate: periodEnd,
            currency: usageCurrency,
            categoriesPresent: [
              "chat",
              "completion",
              "ocr",
              "audio",
              "connectors",
              "libraries_api",
              "fine_tuning",
              "vibe_usage",
            ].filter((key) => usage[key] != null),
            pricesCount: Array.isArray(usage.prices) ? usage.prices.length : null,
          }
        : null,
      spendLimit: limitsResponse.ok
        ? {
            amount: spendLimitUsd,
            currency: limitsCurrency,
            noMonthlyLimit: completion?.no_monthly_limit ?? null,
            monthlyLimitReached: completion?.monthly_limit_reached ?? null,
            lastPaymentFailure: limits.limits?.last_payment_failure ?? null,
          }
        : null,
      rateLimit: rateResponse.ok
        ? {
            requestsPerSecond: requestLimit,
            modelTokenLimitsAvailable: rate.tokens_limits_by_model != null,
          }
        : null,
      capabilities: {
        actualCost: false,
        usageBreakdown: usageShapeComplete,
        spendLimit: spendLimitComplete,
        rateLimit: rateLimitComplete,
        credential: "Mistral Backoffice Admin API key",
        costNote:
          "The public Admin API schema does not define a stable monetary-total field inside category usage data; spend-limit counters are not treated as cost.",
      },
    },
    externalBillingSyncs: billingSyncs.length > 0 ? billingSyncs : undefined,
  };
}
