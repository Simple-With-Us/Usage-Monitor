import {
  AdapterError,
  errorResult,
  fetchJson,
  parseNumber,
  type UsageResult,
} from "./helpers";

export async function fetchUsage(apiKey: string): Promise<UsageResult> {
  const res = await fetchJson("https://api.deepseek.com/user/balance", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!res.ok) {
    return errorResult(res.status, { response: res.data });
  }

  if (!res.data || typeof res.data !== "object") {
    throw new AdapterError("DeepSeek returned an invalid balance response", {
      code: "INVALID_RESPONSE",
    });
  }

  const data = res.data as {
    is_available?: boolean;
    balance_infos?: Array<{
      currency?: string;
      total_balance?: string;
      granted_balance?: string;
      topped_up_balance?: string;
    }>;
  };

  let balance: number | null = null;
  let credits: number | null = null;
  const balances = (data.balance_infos ?? []).map((info) => ({
    currency: info.currency?.trim().toUpperCase() || null,
    total: parseNumber(info.total_balance),
    granted: parseNumber(info.granted_balance),
    toppedUp: parseNumber(info.topped_up_balance),
  }));

  for (const info of balances) {
    if (info.currency === "USD") {
      balance = info.total;
      credits = info.granted;
      break;
    }
  }

  return {
    balance,
    totalCost: null,
    totalRequests: null,
    credits,
    rawData: {
      available: data.is_available ?? null,
      balances,
      capabilities: {
        multiCurrencyBalance: true,
        canonicalUsdBalance: balances.some((entry) => entry.currency === "USD"),
        billingHistory: false,
      },
    },
    externalBilling: {
      source: "deepseek-account-balance",
      authoritative: true,
      records: balances.length > 0
        ? balances.map((entry, index) => ({
          externalId: entry.currency ?? `unknown-${index}`,
          kind: "account",
          serviceName: "DeepSeek API balance",
          planName: entry.currency ? `${entry.currency} balance` : "Account balance",
          status: data.is_available === false ? "unavailable" : "active",
          remainingQuantity: entry.total,
          usageUnit: entry.currency,
          rollupRole: "metadata" as const,
        }))
        : [{
          externalId: "api-account",
          kind: "account" as const,
          serviceName: "DeepSeek API account",
          planName: null,
          status: data.is_available === false ? "unavailable" : "active",
          rollupRole: "metadata" as const,
        }],
    },
  };
}
