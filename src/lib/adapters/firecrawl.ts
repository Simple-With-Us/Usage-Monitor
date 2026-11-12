import {
  AdapterError,
  type AdapterExternalBillingRecord,
  type AdapterExternalBillingSync,
  configurationError,
  errorResult,
  fetchJson,
  parseNumber,
  type UsageResult,
} from "./helpers";

const CREDIT_USAGE_URL = "https://api.firecrawl.dev/v2/team/credit-usage";
const HISTORICAL_CREDIT_USAGE_URL =
  "https://api.firecrawl.dev/v2/team/credit-usage/historical?byApiKey=false";
const MAX_HISTORICAL_PERIODS = 240;

type HistoricalCreditStatus = "complete" | "invalid" | "unavailable";

interface HistoricalCreditResult {
  status: HistoricalCreditStatus;
  sync?: AdapterExternalBillingSync;
}

function responseObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonNegativeNumber(value: unknown): number | null {
  const parsed = parseNumber(value);
  return parsed != null && parsed >= 0 ? parsed : null;
}

function historicalCreditTotal(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
    ? value
    : null;
}

function nullableIsoTimestamp(value: unknown): string | null | undefined {
  if (value == null) return null;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds)
    ? new Date(milliseconds).toISOString()
    : undefined;
}

async function fetchHistoricalCredits(
  token: string
): Promise<HistoricalCreditResult> {
  let response;
  try {
    response = await fetchJson(HISTORICAL_CREDIT_USAGE_URL, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    return { status: "unavailable" };
  }

  if (!response.ok) return { status: "unavailable" };

  const body = responseObject(response.data);
  if (
    body?.success !== true ||
    !Array.isArray(body.periods) ||
    body.periods.length > MAX_HISTORICAL_PERIODS
  ) {
    return { status: "invalid" };
  }

  const periods: Array<{
    start: string;
    end: string;
    totalCredits: number;
  }> = [];
  for (const value of body.periods) {
    const period = responseObject(value);
    const start = nullableIsoTimestamp(period?.startDate);
    const end = nullableIsoTimestamp(period?.endDate);
    const totalCredits = historicalCreditTotal(period?.totalCredits);
    if (
      !period ||
      start == null ||
      end == null ||
      totalCredits == null ||
      Date.parse(end) <= Date.parse(start)
    ) {
      return { status: "invalid" };
    }
    periods.push({ start, end, totalCredits });
  }

  periods.sort(
    (left, right) =>
      Date.parse(left.start) - Date.parse(right.start) ||
      Date.parse(left.end) - Date.parse(right.end)
  );
  for (let index = 1; index < periods.length; index += 1) {
    if (Date.parse(periods[index].start) < Date.parse(periods[index - 1].end)) {
      return { status: "invalid" };
    }
  }

  const records: AdapterExternalBillingRecord[] = periods.map((period) => ({
    externalId: `credit-history:${period.start}:${period.end}`,
    kind: "billing_period",
    serviceName: "Firecrawl API credit usage",
    currentPeriodStart: period.start,
    currentPeriodEnd: period.end,
    usageQuantity: period.totalCredits,
    usageUnit: "credits",
    rollupRole: "metadata",
    dateKind: "report_through",
  }));

  return {
    status: "complete",
    sync: {
      source: "firecrawl-team-credit-history",
      authoritative: true,
      records,
    },
  };
}

export async function fetchUsage(apiKey: string): Promise<UsageResult> {
  const token = apiKey.trim();
  if (!token) {
    configurationError("Firecrawl API key is required");
  }

  const response = await fetchJson(CREDIT_USAGE_URL, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    return errorResult(response.status, {
      note:
        response.status === 401 || response.status === 403
          ? "Firecrawl rejected the API key"
          : "Firecrawl team credit usage was unavailable",
    });
  }

  const body = responseObject(response.data);
  const data = responseObject(body?.data);
  if (body?.success !== true || !data) {
    throw new AdapterError(
      "Firecrawl returned an unsuccessful or invalid credit-usage response",
      { code: "INVALID_RESPONSE" }
    );
  }

  const remainingCredits = nonNegativeNumber(data.remainingCredits);
  const planCredits = nonNegativeNumber(data.planCredits);
  const billingPeriodStart = nullableIsoTimestamp(data.billingPeriodStart);
  const billingPeriodEnd = nullableIsoTimestamp(data.billingPeriodEnd);
  if (
    remainingCredits == null ||
    planCredits == null ||
    billingPeriodStart === undefined ||
    billingPeriodEnd === undefined ||
    (billingPeriodStart != null &&
      billingPeriodEnd != null &&
      Date.parse(billingPeriodEnd) <= Date.parse(billingPeriodStart))
  ) {
    throw new AdapterError(
      "Firecrawl returned invalid credit totals or billing-period dates",
      { code: "INVALID_RESPONSE" }
    );
  }

  const historicalCredits = await fetchHistoricalCredits(token);

  return {
    balance: null,
    totalCost: null,
    costScope: "unknown",
    totalRequests: null,
    credits: remainingCredits,
    rawData: {
      credits: {
        plan: planCredits,
        remaining: remainingCredits,
      },
      billingPeriod: {
        start: billingPeriodStart,
        end: billingPeriodEnd,
      },
      creditHistory: {
        status: historicalCredits.status,
        periodCount:
          historicalCredits.sync?.records.length ?? null,
      },
      capabilities: {
        currentCreditQuota: true,
        historicalCreditUsage: historicalCredits.status === "complete",
        billingPeriod:
          billingPeriodStart != null || billingPeriodEnd != null,
        providerReportedUsage: false,
        planTier: false,
        usdCost: false,
        renewalDate: false,
      },
    },
    externalBilling: {
      source: "firecrawl-team-credit-usage",
      authoritative: true,
      records: [
        {
          externalId: "team-credit-plan",
          kind: "plan",
          serviceName: "Firecrawl API",
          currentPeriodStart: billingPeriodStart,
          currentPeriodEnd: billingPeriodEnd,
          requestLimit: planCredits,
          requestLimitWindow: "billing period",
          remainingQuantity: remainingCredits,
          usageUnit: "credits",
          rollupRole: "metadata",
          dateKind: billingPeriodEnd == null ? null : "period_end",
        },
      ],
    },
    externalBillingSyncs: historicalCredits.sync
      ? [historicalCredits.sync]
      : undefined,
  };
}
