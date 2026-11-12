import {
  errorResult,
  fetchJson,
  headerNumber,
  type AdapterExternalBillingRecord,
  type UsageResult,
} from "./helpers";

// Unusual Whales publishes no account/plan/billing endpoint. Every successful
// API response instead carries this header with the account's cumulative
// request count for the current provider day (resets 8:00pm ET, not
// midnight UTC/local - the provider does not return a countdown or reset
// timestamp, so a reset time is never invented here). See
// https://unusualwhales.com/information/how-to-check-your-api-usage.
const DAILY_REQUEST_COUNT_HEADER = "x-uw-daily-req-count";

// The header is a same-day cumulative counter, not a byte/dollar quantity, so
// there is no plausible reason it should ever reach seven figures in one
// provider day. A value at or beyond this magnitude indicates a misparsed or
// corrupted upstream header (unit drift, a proxy echoing an unrelated
// counter, etc.) and must degrade to "unknown" rather than ever reach
// persistence - the same defensive spirit as the Tradier expiry-header fix.
const MAX_PLAUSIBLE_DAILY_REQUESTS = 1_000_000;

function plausibleDailyRequestCount(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (value < 0 || value >= MAX_PLAUSIBLE_DAILY_REQUESTS) return null;
  return Math.trunc(value);
}

export async function fetchUsage(apiKey: string): Promise<UsageResult> {
  // Congress recent-trades is the one endpoint this monitor has confirmed
  // documented and working (it is the same endpoint Congress.Trade's own
  // ingestion already calls). `limit=1` requests the smallest page Unusual
  // Whales allows so this poll stays a minimal, neutral read: it exists only
  // to observe the usage header, not to fetch congressional-trade data, and
  // it consumes exactly one request against the same daily counter as any
  // other authenticated call - there is no documented lower-cost endpoint.
  const res = await fetchJson(
    "https://api.unusualwhales.com/api/congress/recent-trades?limit=1",
    { headers: { Authorization: `Bearer ${apiKey}` } }
  );

  if (!res.ok) {
    // Unusual Whales 401 bodies name a stable reason (`malformed_token`,
    // `unrecognized_token`) and set retryable=false. Keep that reason, and
    // nothing else, so a standing auth rejection is visible on the provider
    // without copying the token or the free-form message.
    const reason =
      res.data &&
      typeof res.data === "object" &&
      typeof (res.data as { reason?: unknown }).reason === "string"
        ? (res.data as { reason: string }).reason.trim()
        : "";
    const safeReason = /^[a-z0-9_]{1,40}$/.test(reason) ? reason : "";
    return errorResult(res.status, safeReason ? { note: safeReason } : {});
  }

  const dailyRequestCount = plausibleDailyRequestCount(
    headerNumber(res.headers, [DAILY_REQUEST_COUNT_HEADER])
  );

  const records: AdapterExternalBillingRecord[] =
    dailyRequestCount != null
      ? [
          {
            externalId: "daily-request-count",
            kind: "account",
            serviceName: "Unusual Whales API",
            planName: "Daily request count",
            status: "active",
            requestLimit: null,
            requestLimitWindow: "day",
            usageQuantity: dailyRequestCount,
            remainingQuantity: null,
            usageUnit: "requests",
            rollupRole: "metadata",
            dateKind: "quota_reset",
          },
        ]
      : [];

  return {
    balance: null,
    totalCost: null,
    costScope: "unknown",
    totalRequests: dailyRequestCount,
    credits: null,
    rawData: {
      dailyRequestCount,
      resetWindow: "Resets 8:00pm ET daily (provider-documented; no reset timestamp is returned)",
      pollConsumesRequest: true,
      note: "Unusual Whales exposes no account, plan, or billing endpoint. Each poll of /api/congress/recent-trades (limit=1) consumes exactly one request against the same daily counter reported by x-uw-daily-req-count; there is no documented request limit, USD cost, or renewal date.",
      capabilities: {
        dailyRequestCount: dailyRequestCount != null,
        requestLimit: false,
        billingCost: false,
        subscriptionPrice: false,
        renewalDate: false,
      },
    },
    externalBilling:
      records.length > 0
        ? {
            source: "unusual-whales-daily-request-count",
            authoritative: true,
            records,
          }
        : undefined,
  };
}
