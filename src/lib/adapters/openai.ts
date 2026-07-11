import {
  errorResult,
  fetchJson,
  isoDateDaysAgo,
  parseNumber,
  type UsageResult,
} from "./helpers";

export type { UsageResult };

export async function fetchUsage(apiKey: string): Promise<UsageResult> {
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = isoDateDaysAgo(30);
  const headers = { Authorization: `Bearer ${apiKey}` };

  const [usageRes, billingRes, grantsRes, usageRangeRes] = await Promise.all([
    fetchJson(`https://api.openai.com/v1/usage?date=${today}`, { headers }),
    fetchJson("https://api.openai.com/dashboard/billing/subscription", {
      headers,
    }),
    fetchJson("https://api.openai.com/dashboard/billing/credit_grants", {
      headers,
    }),
    fetchJson(
      `https://api.openai.com/dashboard/billing/usage?start_date=${monthStart}&end_date=${today}`,
      { headers }
    ),
  ]);

  const rawData: Record<string, unknown> = {
    usage: usageRes.data,
    billing: billingRes.data,
    creditGrants: grantsRes.data,
    usageRange: usageRangeRes.data,
  };

  if (!usageRes.ok && !billingRes.ok && !grantsRes.ok) {
    return errorResult(usageRes.status || billingRes.status, rawData);
  }

  let balance: number | null = null;
  let totalCost: number | null = null;
  let totalRequests: number | null = null;

  if (grantsRes.ok && grantsRes.data && typeof grantsRes.data === "object") {
    const grants = grantsRes.data as Record<string, unknown>;
    balance =
      parseNumber(grants.total_available) ??
      parseNumber(grants.total_available_usd);
  }

  if (billingRes.ok && billingRes.data && typeof billingRes.data === "object") {
    const billing = billingRes.data as Record<string, unknown>;
    if (balance == null) {
      const hardLimit = parseNumber(billing.hard_limit_usd);
      const totalUsage = parseNumber(
        (usageRangeRes.data as Record<string, unknown> | null)?.total_usage
      );
      if (hardLimit != null && totalUsage != null) {
        balance = Math.max(0, hardLimit - totalUsage / 100);
        rawData.remainingFromLimit = true;
      } else {
        balance =
          hardLimit ?? parseNumber(billing.soft_limit_usd);
        rawData.balanceIsLimit = true;
      }
    }
  }

  if (usageRes.ok && usageRes.data && typeof usageRes.data === "object") {
    const usage = usageRes.data as Record<string, unknown>;
    let dailyCostCents = 0;
    let foundDailyCost = false;
    let requestCount = 0;
    const data = Array.isArray(usage.data) ? usage.data : [usage];

    for (const day of data) {
      if (day && typeof day === "object") {
        const row = day as Record<string, unknown>;
        if (typeof row.cost === "number") {
          dailyCostCents += row.cost;
          foundDailyCost = true;
        }
        if (typeof row.n_requests === "number") requestCount += row.n_requests;
      }
    }

    // `/v1/usage?date=today` is one day, not a month-to-date billing total.
    // Keep its cost diagnostic-only so it can never overwrite MTD spend.
    rawData.dailyCostUsd = foundDailyCost ? dailyCostCents / 100 : null;
    totalRequests = requestCount;
  }

  if (
    usageRangeRes.ok &&
    usageRangeRes.data &&
    typeof usageRangeRes.data === "object"
  ) {
    const usageRange = usageRangeRes.data as Record<string, unknown>;
    const totalUsage = parseNumber(usageRange.total_usage);
    if (totalUsage != null) totalCost = totalUsage / 100;
  }

  return { balance, totalCost, totalRequests, credits: null, rawData };
}
