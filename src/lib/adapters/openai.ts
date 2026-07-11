import {
  errorResult,
  fetchJson,
  parseNumber,
  type UsageResult,
} from "./helpers";

export type { UsageResult };

const COSTS_API_KEY_REQUIREMENT =
  "OpenAI organization Admin API key (created by an Organization Owner)";

interface OrganizationCostsResult {
  ok: boolean;
  status: number;
  totalCost: number | null;
  pages: unknown[];
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
      if (!amount || typeof amount !== "object" || Array.isArray(amount)) continue;
      const amountRecord = amount as Record<string, unknown>;
      const currency = typeof amountRecord.currency === "string"
        ? amountRecord.currency.toLowerCase()
        : "usd";
      const value = parseNumber(amountRecord.value);
      if (value == null || value < 0 || currency !== "usd") return null;
      costUsd += value;
    }
  }
  const hasMore = page.has_more === true;
  const nextPage = typeof page.next_page === "string" && page.next_page ? page.next_page : null;
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
  const pages: unknown[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  let totalCost = 0;

  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const url = new URL(baseUrl);
    if (cursor) url.searchParams.set("page", cursor);
    const response = await fetchJson(url.toString(), { headers });
    pages.push(response.data);
    if (!response.ok) {
      return { ok: false, status: response.status, totalCost: null, pages };
    }
    const parsed = parseCostsPage(response.data);
    if (!parsed) {
      return {
        ok: false,
        status: 502,
        totalCost: null,
        pages,
        error: "Malformed or non-USD organization costs response",
      };
    }
    totalCost += parsed.costUsd;
    if (!parsed.hasMore) {
      return { ok: true, status: response.status, totalCost, pages };
    }
    if (!parsed.nextPage || seenCursors.has(parsed.nextPage)) {
      return {
        ok: false,
        status: 502,
        totalCost: null,
        pages,
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
    pages,
    error: "Organization costs pagination exceeded 100 pages",
  };
}

export async function fetchUsage(
  apiKey: string,
  config: Record<string, unknown> = {}
): Promise<UsageResult> {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  )
    .toISOString()
    .slice(0, 10);
  const monthStartUnix = Math.floor(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000
  );
  const endTimeUnix = Math.floor(now.getTime() / 1000) + 1;
  const headers = { Authorization: `Bearer ${apiKey}` };
  // Provider.secretConfig.adminApiKey is decrypted and merged into config by
  // the adapter registry. Keep the normal project key for inference/legacy
  // endpoints and use the narrower Admin credential only for org Costs.
  const configuredAdminKey =
    typeof config.adminApiKey === "string" ? config.adminApiKey.trim() : "";
  const costsApiKey = configuredAdminKey || apiKey;

  const [costsRes, usageRes, billingRes, grantsRes, usageRangeRes] = await Promise.all([
    // This is OpenAI's current reconciliation-grade cost source. It requires
    // an organization Admin API key; standard project keys commonly return
    // 401/403, in which case the legacy endpoints below remain a compatibility
    // fallback for existing provider rows. Reference:
    // https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/costs
    fetchOrganizationCosts(costsApiKey, monthStartUnix, endTimeUnix),
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
    organizationCosts: costsRes.pages,
    ...(costsRes.error ? { organizationCostsError: costsRes.error } : {}),
    costsApiKeyRequirement: COSTS_API_KEY_REQUIREMENT,
    costsCredentialSource: configuredAdminKey ? "secretConfig.adminApiKey" : "provider.apiKey",
    usage: usageRes.data,
    billing: billingRes.data,
    creditGrants: grantsRes.data,
    usageRange: usageRangeRes.data,
  };

  if (!costsRes.ok && !usageRes.ok && !billingRes.ok && !grantsRes.ok && !usageRangeRes.ok) {
    return errorResult(
      costsRes.status ||
        usageRes.status ||
        billingRes.status ||
        grantsRes.status ||
        usageRangeRes.status,
      rawData
    );
  }

  let balance: number | null = null;
  let totalCost: number | null = null;
  let totalRequests: number | null = null;

  // The current organization Costs API reports monetary values in dollars and
  // is authoritative when every page validates. The legacy range endpoint
  // reports cents and remains only for non-admin-key compatibility.
  if (costsRes.ok && costsRes.totalCost != null) {
    totalCost = costsRes.totalCost;
    rawData.costSource = "organization_costs";
  } else if (
    usageRangeRes.ok &&
    usageRangeRes.data &&
    typeof usageRangeRes.data === "object"
  ) {
    const usageRange = usageRangeRes.data as Record<string, unknown>;
    const totalUsage = parseNumber(usageRange.total_usage);
    if (totalUsage != null) {
      totalCost = totalUsage / 100;
      rawData.costSource = "legacy_billing_usage";
    }
  }

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
      if (hardLimit != null && totalCost != null) {
        balance = Math.max(0, hardLimit - totalCost);
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
    let totalCostCents = 0;
    let foundCost = false;
    let requestCount = 0;
    const data = Array.isArray(usage.data) ? usage.data : [usage];

    for (const day of data) {
      if (day && typeof day === "object") {
        const row = day as Record<string, unknown>;
        if (typeof row.cost === "number") {
          totalCostCents += row.cost;
          foundCost = true;
        }
        if (typeof row.n_requests === "number") requestCount += row.n_requests;
      }
    }

    if (totalCost == null && foundCost) {
      totalCost = totalCostCents / 100;
      rawData.costSource = "legacy_daily_usage";
    }
    totalRequests = requestCount;
  }

  return { balance, totalCost, totalRequests, credits: null, rawData };
}
