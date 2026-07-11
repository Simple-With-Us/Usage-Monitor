import {
  errorResult,
  fetchJson,
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

  const data = res.data as { data?: unknown[] };
  const keyCount = Array.isArray(data.data) ? data.data.length : 0;

  return {
    balance: null,
    totalCost: null,
    totalRequests: null,
    credits: null,
    rawData: {
      apiKeyCount: keyCount,
      note: "Resend does not expose remaining email quota, plan, or billing cost via API. Authentication was checked through the non-sending API-key control plane.",
      capabilities: {
        nonBillableKeyValidation: true,
        billingCost: false,
        subscriptionStatus: false,
      },
    },
  };
}
