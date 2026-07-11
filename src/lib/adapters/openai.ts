import {
  errorResult,
  fetchJson,
  parseNumber,
  type UsageResult,
} from "./helpers";

export type { UsageResult };

const COSTS_API_KEY_REQUIREMENT =
  "OpenAI organization Admin API key (created by an Organization Owner)";
const MAX_COST_PAGES = 100;

interface OrganizationCostsResult {
  ok: boolean;
  status: number;
  totalCost: number | null;
  pageCount: number;
  error?: string;
}

function parseCostsPage(data: unknown): {
  costUsd: number;
  hasMore: boolean;
  nextPage: string | null;
} | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const page = data as Record<string, unknown>;
  if (!Array.isArray(page.data)) return null;
  let costUsd = 0;
  for (const rawBucket of page.data) {
    if (!rawBucket || typeof rawBucket !== "object" || Array.isArray(rawBucket)) return null;
    const bucket = rawBucket as Record<string, unknown>;
    if (!Array.isArray(bucket.results)) return null;
    for (const rawResult of bucket.results) {
      if (!rawResult || typeof rawResult !== "object" || Array.isArray(rawResult)) return null;
      const amount = (rawResult as Record<string, unknown>).amount;
      if (!amount || typeof amount !== "object" || Array.isArray(amount)) return null;
      const amountRecord = amount as Record<string, unknown>;
      const currency =
        typeof amountRecord.currency === "string"
          ? amountRecord.currency.toLowerCase()
          : "usd";
      const value = parseNumber(amountRecord.value);
      if (value == null || value < 0 || currency !== "usd") return null;
      costUsd += value;
    }
  }
  const hasMore = page.has_more === true;
  const nextPage =
    typeof page.next_page === "string" && page.next_page.trim()
      ? page.next_page.trim()
      : null;
  if (hasMore && !nextPage) return null;
  return { costUsd, hasMore, nextPage };
}

async function fetchOrganizationCosts(
  apiKey: string,
  startTime: number,
  endTime: number
): Promise<OrganizationCostsResult> {
  const headers = { Authorization: `Bearer ${apiKey}` };
  const baseUrl = new URL("https://api.openai.com/v1/organization/costs");
  baseUrl.searchParams.set("start_time", String(startTime));
  baseUrl.searchParams.set("end_time", String(endTime));
  baseUrl.searchParams.set("bucket_width", "1d");
  baseUrl.searchParams.set("limit", "180");
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  let totalCost = 0;

  for (let pageNumber = 1; pageNumber <= MAX_COST_PAGES; pageNumber += 1) {
    const url = new URL(baseUrl);
    if (cursor) url.searchParams.set("page", cursor);
    const response = await fetchJson(url.toString(), { headers });
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        totalCost: null,
        pageCount: pageNumber,
      };
    }
    const parsed = parseCostsPage(response.data);
    if (!parsed) {
      return {
        ok: false,
        status: 502,
        totalCost: null,
        pageCount: pageNumber,
        error: "Malformed or non-USD organization costs response",
      };
    }
    totalCost += parsed.costUsd;
    if (!parsed.hasMore) {
      return {
        ok: true,
        status: response.status,
        totalCost,
        pageCount: pageNumber,
      };
    }
    if (!parsed.nextPage || seenCursors.has(parsed.nextPage)) {
      return {
        ok: false,
        status: 502,
        totalCost: null,
        pageCount: pageNumber,
        error: "Invalid organization costs pagination cursor",
      };
    }
    seenCursors.add(parsed.nextPage);
    cursor = parsed.nextPage;
  }

  return {
    ok: false,
    status: 502,
    totalCost: null,
    pageCount: MAX_COST_PAGES,
    error: `Organization costs pagination exceeded ${MAX_COST_PAGES} pages`,
  };
}

export async function fetchUsage(
  apiKey: string,
  config: Record<string, unknown> = {}
): Promise<UsageResult> {
  const now = new Date();
  const dayStartDate = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  const today = now.toISOString().slice(0, 10);
  const monthStartDate = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  );
  const monthStart = monthStartDate.toISOString().slice(0, 10);
  const monthStartUnix = Math.floor(monthStartDate.getTime() / 1000);
  const endTimeUnix = Math.floor(now.getTime() / 1000) + 1;
  const headers = { Authorization: `Bearer ${apiKey}` };
  const configuredAdminKey =
    typeof config.adminApiKey === "string" ? config.adminApiKey.trim() : "";
  const costsApiKey = configuredAdminKey || apiKey;

  const [costsRes, usageRes, billingRes, grantsRes, usageRangeRes] = await Promise.all([
    fetchOrganizationCosts(costsApiKey, monthStartUnix, endTimeUnix),
    fetchJson(`https://api.openai.com/v1/usage?date=${today}`, { headers }),
    fetchJson("https://api.openai.com/dashboard/billing/subscription", { headers }),
    fetchJson("https://api.openai.com/dashboard/billing/credit_grants", { headers }),
    fetchJson(
      `https://api.openai.com/dashboard/billing/usage?start_date=${monthStart}&end_date=${today}`,
      { headers }
    ),
  ]);

  const rawData: Record<string, unknown> = {
    organizationCosts: {
      available: costsRes.ok,
      status: costsRes.status,
      totalCostUsd: costsRes.totalCost,
      pageCount: costsRes.pageCount,
    },
    ...(costsRes.error ? { organizationCostsError: costsRes.error } : {}),
    costsApiKeyRequirement: COSTS_API_KEY_REQUIREMENT,
    costsCredentialSource: configuredAdminKey
      ? "secretConfig.adminApiKey"
      : "provider.apiKey",
  };

  if (!costsRes.ok && !usageRes.ok && !billingRes.ok && !grantsRes.ok && !usageRangeRes.ok) {
    return errorResult(
      costsRes.status ||
        usageRes.status ||
        billingRes.status ||
        grantsRes.status ||
        usageRangeRes.status,
      { note: "No OpenAI organization cost, usage, billing, or grant capability was readable" }
    );
  }

  let balance: number | null = null;
  let totalCost: number | null = null;
  let totalRequests: number | null = null;

  if (costsRes.ok && costsRes.totalCost != null) {
    totalCost = costsRes.totalCost;
    rawData.costSource = "organization_costs";
  } else if (
    usageRangeRes.ok &&
    usageRangeRes.data &&
    typeof usageRangeRes.data === "object"
  ) {
    const totalUsage = parseNumber(
      (usageRangeRes.data as Record<string, unknown>).total_usage
    );
    if (totalUsage != null && totalUsage >= 0) {
      totalCost = totalUsage / 100;
      rawData.costSource = "legacy_billing_usage";
      rawData.legacyMonthToDateUsd = totalCost;
    }
  }

  if (grantsRes.ok && grantsRes.data && typeof grantsRes.data === "object") {
    const grants = grantsRes.data as Record<string, unknown>;
    balance =
      parseNumber(grants.total_available) ??
      parseNumber(grants.total_available_usd);
    rawData.creditGrantsBalanceUsd = balance;
  }

  if (billingRes.ok && billingRes.data && typeof billingRes.data === "object") {
    const billing = billingRes.data as Record<string, unknown>;
    const hardLimit = parseNumber(billing.hard_limit_usd);
    const softLimit = parseNumber(billing.soft_limit_usd);
    rawData.billingLimits = { hardLimitUsd: hardLimit, softLimitUsd: softLimit };
    if (balance == null) {
      if (hardLimit != null && totalCost != null) {
        balance = Math.max(0, hardLimit - totalCost);
        rawData.remainingFromLimit = true;
      } else {
        balance = hardLimit ?? softLimit;
        rawData.balanceIsLimit = true;
      }
    }
  }

  if (usageRes.ok && usageRes.data && typeof usageRes.data === "object") {
    let dailyCostCents = 0;
    let foundDailyCost = false;
    let requestCount = 0;
    const usage = usageRes.data as Record<string, unknown>;
    const data = Array.isArray(usage.data) ? usage.data : [usage];
    for (const day of data) {
      if (!day || typeof day !== "object" || Array.isArray(day)) continue;
      const row = day as Record<string, unknown>;
      const cost = parseNumber(row.cost);
      const requests = parseNumber(row.n_requests);
      if (cost != null && cost >= 0) {
        dailyCostCents += cost;
        foundDailyCost = true;
      }
      if (requests != null && requests >= 0) requestCount += Math.trunc(requests);
    }
    // This endpoint is one day, not month-to-date. It is diagnostic only and
    // must never be promoted into the monthly budget total.
    rawData.dailyUsage = {
      costUsd: foundDailyCost ? dailyCostCents / 100 : null,
      requests: requestCount,
    };
    totalRequests = requestCount;
  }

  return {
    balance,
    totalCost,
    costWindowStart: totalCost == null ? null : monthStartDate,
    costWindowEnd: totalCost == null ? null : now,
    costScope: totalCost == null ? "unknown" : "calendar_month_to_date",
    totalRequests,
    requestUnit: totalRequests == null ? null : "requests",
    requestWindow:
      totalRequests == null ? null : "calendar_day_to_date",
    requestWindowStart: totalRequests == null ? null : dayStartDate,
    requestWindowEnd: totalRequests == null ? null : now,
    credits: null,
    rawData,
  };
}
