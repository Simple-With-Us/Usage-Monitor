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

  for (const info of data.balance_infos || []) {
    if (info.currency === "USD") {
      balance = parseNumber(info.total_balance);
      credits = parseNumber(info.granted_balance);
      break;
    }
  }

  if (balance == null && data.balance_infos?.[0]) {
    balance = parseNumber(data.balance_infos[0].total_balance);
    credits = parseNumber(data.balance_infos[0].granted_balance);
  }

  return {
    balance,
    totalCost: null,
    totalRequests: null,
    credits,
    rawData: data,
    externalBilling: {
      source: "deepseek-account-balance",
      authoritative: true,
      records: [
        {
          externalId: "api-account",
          kind: "account",
          planName: "DeepSeek API account",
          status: data.is_available === false ? "unavailable" : "active",
        },
      ],
    },
  };
}
