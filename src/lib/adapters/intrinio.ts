import {
  errorResult,
  fetchJson,
  parseNumber,
  type UsageResult,
  type AdapterExternalBillingRecord,
} from "./helpers";

interface IntrinioUsageRow {
  access_code?: string;
  restriction?: string;
  count?: string | number;
  limit?: string | number;
  seconds_until_reset?: string | number;
  percentage_used?: string | number;
}

export async function fetchUsage(apiKey: string): Promise<UsageResult> {
  const response = await fetchJson(
    "https://api-v2.intrinio.com/account/current_usage",
    { headers: { Authorization: `Bearer ${apiKey}` } }
  );
  if (!response.ok) return errorResult(response.status);

  const data = (response.data ?? {}) as {
    usage?: IntrinioUsageRow[];
    account?: { email?: string };
  };
  const usage = Array.isArray(data.usage) ? data.usage : [];
  let used = 0;
  let remaining = 0;
  let foundUsed = false;
  let foundRemaining = false;
  const records: AdapterExternalBillingRecord[] = [];
  const now = Date.now();
  for (const row of usage) {
    const count = parseNumber(row.count);
    const limit = parseNumber(row.limit);
    if (count != null) {
      used += count;
      foundUsed = true;
    }
    if (count != null && limit != null) {
      remaining += Math.max(0, limit - count);
      foundRemaining = true;
    }
    const externalId = row.access_code ?? row.restriction;
    if (externalId) {
      const resetSeconds = parseNumber(row.seconds_until_reset);
      records.push({
        externalId,
        kind: "account",
        serviceName: row.restriction ?? row.access_code ?? "Intrinio feed",
        planName: row.restriction ?? row.access_code ?? null,
        status: "active",
        requestLimit: limit,
        requestLimitWindow: "provider-defined",
        usageQuantity: count,
        remainingQuantity:
          count != null && limit != null ? Math.max(0, limit - count) : null,
        usageUnit: "calls",
        currentPeriodEnd: resetSeconds != null
          ? new Date(now + resetSeconds * 1000).toISOString()
          : null,
        rollupRole: "metadata",
        dateKind: "quota_reset",
      });
    }
  }

  return {
    balance: null,
    totalCost: null,
    totalRequests: foundUsed ? used : null,
    credits: foundRemaining ? remaining : null,
    rawData: {
      usage,
      // Do not persist the account email returned by this endpoint.
      capabilities: {
        currentUsage: true,
        perFeedLimits: true,
        resetWindow: true,
        billingCost: false,
        subscriptionPrice: false,
      },
    },
    externalBilling: {
      source: "intrinio-account-usage",
      authoritative: true,
      records,
    },
  };
}
