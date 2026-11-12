import {
  errorResult,
  fetchJson,
  parseNumber,
  type AdapterExternalBillingRecord,
  type AdapterExternalBillingSync,
  type UsageResult,
} from "./helpers";

export type { UsageResult };

const COSTS_API_KEY_REQUIREMENT =
  "OpenAI organization Admin API key (created by an Organization Owner)";
const MAX_COST_PAGES = 100;
const MAX_COST_COMPONENT_PAGES = 20;
const MAX_COST_COMPONENTS_PER_DIMENSION = 100;
const MAX_COMPONENT_LABEL_LENGTH = 160;

type CostComponentDimension = "project_id" | "line_item" | "api_key_id";

interface OrganizationCostsResult {
  ok: boolean;
  status: number;
  totalCost: number | null;
  pageCount: number;
  error?: string;
}

interface OrganizationCostComponentsResult {
  ok: boolean;
  status: number;
  pageCount: number;
  components: AdapterExternalBillingRecord[];
  error?: string;
}

function parseCostsPagination(
  page: Record<string, unknown>
): { hasMore: boolean; nextPage: string | null } | null {
  if (typeof page.has_more !== "boolean") return null;
  if (page.has_more) {
    const nextPage =
      typeof page.next_page === "string" && page.next_page.trim()
        ? page.next_page.trim()
        : null;
    return nextPage ? { hasMore: true, nextPage } : null;
  }
  // A cursor on a final page is contradictory; accepting it could silently
  // turn an incomplete Costs response into an authoritative total or sync.
  return page.next_page == null ? { hasMore: false, nextPage: null } : null;
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
          : null;
      const value = parseNumber(amountRecord.value);
      if (value == null || value < 0 || currency !== "usd") return null;
      costUsd += value;
    }
  }
  const pagination = parseCostsPagination(page);
  return pagination ? { costUsd, ...pagination } : null;
}

function componentLabel(value: unknown): string | null {
  if (value == null) return "Unattributed";
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_COMPONENT_LABEL_LENGTH) return null;
  return trimmed;
}

function parseCostComponentPage(
  data: unknown,
  dimension: CostComponentDimension
): {
  components: Map<string, { amountUsd: number; quantity: number | null }>;
  hasMore: boolean;
  nextPage: string | null;
} | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const page = data as Record<string, unknown>;
  if (!Array.isArray(page.data)) return null;
  const components = new Map<string, { amountUsd: number; quantity: number | null }>();
  for (const rawBucket of page.data) {
    if (!rawBucket || typeof rawBucket !== "object" || Array.isArray(rawBucket)) return null;
    const bucket = rawBucket as Record<string, unknown>;
    if (!Array.isArray(bucket.results)) return null;
    for (const rawResult of bucket.results) {
      if (!rawResult || typeof rawResult !== "object" || Array.isArray(rawResult)) return null;
      const result = rawResult as Record<string, unknown>;
      const label = componentLabel(result[dimension]);
      const amount = result.amount;
      if (!label || !amount || typeof amount !== "object" || Array.isArray(amount)) return null;
      const amountRecord = amount as Record<string, unknown>;
      const currency =
        typeof amountRecord.currency === "string"
          ? amountRecord.currency.toLowerCase()
          : null;
      const amountUsd = parseNumber(amountRecord.value);
      if (amountUsd == null || amountUsd < 0 || currency !== "usd") return null;
      const quantity = result.quantity == null ? null : parseNumber(result.quantity);
      if (result.quantity != null && (quantity == null || quantity < 0)) return null;
      const existing = components.get(label);
      components.set(label, {
        amountUsd: (existing?.amountUsd ?? 0) + amountUsd,
        // Quantity is meaningful only for the line-item view. Keep it only
        // when it is present for every bucket that contributes to a component.
        quantity: existing
          ? existing.quantity == null || quantity == null
            ? null
            : existing.quantity + quantity
          : quantity,
      });
    }
  }
  const pagination = parseCostsPagination(page);
  // Never mark a component collection authoritative unless its pagination
  // contract is complete enough to safely prune prior component rows.
  return pagination ? { components, ...pagination } : null;
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

async function fetchOrganizationCostComponents(
  apiKey: string,
  startTime: number,
  endTime: number,
  dimension: CostComponentDimension,
  periodStart: Date,
  periodEnd: Date
): Promise<OrganizationCostComponentsResult> {
  const headers = { Authorization: `Bearer ${apiKey}` };
  const baseUrl = new URL("https://api.openai.com/v1/organization/costs");
  baseUrl.searchParams.set("start_time", String(startTime));
  baseUrl.searchParams.set("end_time", String(endTime));
  baseUrl.searchParams.set("bucket_width", "1d");
  baseUrl.searchParams.set("limit", "180");
  baseUrl.searchParams.set("group_by", dimension);
  const seenCursors = new Set<string>();
  const totals = new Map<string, { amountUsd: number; quantity: number | null }>();
  let cursor: string | null = null;

  for (let pageNumber = 1; pageNumber <= MAX_COST_COMPONENT_PAGES; pageNumber += 1) {
    let response: Awaited<ReturnType<typeof fetchJson>>;
    try {
      const url = new URL(baseUrl);
      if (cursor) url.searchParams.set("page", cursor);
      response = await fetchJson(url.toString(), { headers });
    } catch {
      return {
        ok: false,
        status: 502,
        pageCount: pageNumber,
        components: [],
        error: "Organization cost component request failed",
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        pageCount: pageNumber,
        components: [],
      };
    }
    const parsed = parseCostComponentPage(response.data, dimension);
    if (!parsed) {
      return {
        ok: false,
        status: 502,
        pageCount: pageNumber,
        components: [],
        error: "Malformed or non-USD organization cost component response",
      };
    }
    for (const [label, component] of parsed.components) {
      const existing = totals.get(label);
      totals.set(label, {
        amountUsd: (existing?.amountUsd ?? 0) + component.amountUsd,
        quantity: existing
          ? existing.quantity == null || component.quantity == null
            ? null
            : existing.quantity + component.quantity
          : component.quantity,
      });
      if (totals.size > MAX_COST_COMPONENTS_PER_DIMENSION) {
        return {
          ok: false,
          status: 502,
          pageCount: pageNumber,
          components: [],
          error: `Organization cost ${dimension} breakdown exceeded ${MAX_COST_COMPONENTS_PER_DIMENSION} components`,
        };
      }
    }
    if (!parsed.hasMore) {
      const month = periodStart.toISOString().slice(0, 7);
      return {
        ok: true,
        status: response.status,
        pageCount: pageNumber,
        components: [...totals.entries()].map(([label, component]) => ({
          externalId: `${month}:${dimension}:${label}`,
          kind: "billing_period",
          serviceName:
            dimension === "project_id"
              ? `OpenAI project: ${label}`
              : dimension === "line_item"
                ? `OpenAI line item: ${label}`
                : `OpenAI API key ID: ${label}`,
          planName: "Organization Costs breakdown",
          status: "open",
          amountUsd: component.amountUsd,
          currency: "USD",
          currentPeriodStart: periodStart.toISOString(),
          currentPeriodEnd: periodEnd.toISOString(),
          usageQuantity: dimension === "line_item" ? component.quantity : null,
          usageUnit: dimension === "line_item" && component.quantity != null ? "provider units" : null,
          rollupRole: "component",
          dateKind: "report_through",
        })),
      };
    }
    if (!parsed.nextPage || seenCursors.has(parsed.nextPage)) {
      return {
        ok: false,
        status: 502,
        pageCount: pageNumber,
        components: [],
        error: "Invalid organization cost component pagination cursor",
      };
    }
    seenCursors.add(parsed.nextPage);
    cursor = parsed.nextPage;
  }

  return {
    ok: false,
    status: 502,
    pageCount: MAX_COST_COMPONENT_PAGES,
    components: [],
    error: `Organization cost component pagination exceeded ${MAX_COST_COMPONENT_PAGES} pages`,
  };
}

export async function fetchUsage(
  apiKey: string,
  config: Record<string, unknown> = {}
): Promise<UsageResult> {
  const now = new Date();
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

  // Wave E / E8: resolve organization Costs first. When it succeeds, skip the
  // legacy month-range billing/usage endpoint (only used as totalCost fallback).
  // Keep today's /v1/usage for request-count diagnostics; keep grants/subscription
  // and cost component breakdowns either way.
  const costsRes = await fetchOrganizationCosts(
    costsApiKey,
    monthStartUnix,
    endTimeUnix
  );
  const costsSucceeded = costsRes.ok && costsRes.totalCost != null;

  const skippedLegacyMonthRange = {
    ok: false as const,
    status: 0,
    data: null as unknown,
  };

  const [
    usageRes,
    billingRes,
    grantsRes,
    usageRangeRes,
    projectCostsRes,
    lineItemCostsRes,
    apiKeyCostsRes,
  ] = await Promise.all([
    fetchJson(`https://api.openai.com/v1/usage?date=${today}`, { headers }),
    fetchJson("https://api.openai.com/dashboard/billing/subscription", {
      headers,
    }),
    fetchJson("https://api.openai.com/dashboard/billing/credit_grants", {
      headers,
    }),
    costsSucceeded
      ? Promise.resolve(skippedLegacyMonthRange)
      : fetchJson(
          `https://api.openai.com/dashboard/billing/usage?start_date=${monthStart}&end_date=${today}`,
          { headers }
        ),
    fetchOrganizationCostComponents(
      costsApiKey,
      monthStartUnix,
      endTimeUnix,
      "project_id",
      monthStartDate,
      now
    ),
    fetchOrganizationCostComponents(
      costsApiKey,
      monthStartUnix,
      endTimeUnix,
      "line_item",
      monthStartDate,
      now
    ),
    fetchOrganizationCostComponents(
      costsApiKey,
      monthStartUnix,
      endTimeUnix,
      "api_key_id",
      monthStartDate,
      now
    ),
  ]);

  const rawData: Record<string, unknown> = {
    organizationCosts: {
      available: costsRes.ok,
      status: costsRes.status,
      totalCostUsd: costsRes.totalCost,
      pageCount: costsRes.pageCount,
    },
    // Diagnostic: when true, legacy month-range billing/usage was not called
    // because organization Costs already supplied MTD cash (E8).
    legacyMonthRangeSkipped: costsSucceeded,
    organizationCostBreakdowns: {
      project_id: {
        available: projectCostsRes.ok,
        status: projectCostsRes.status,
        pageCount: projectCostsRes.pageCount,
        componentCount: projectCostsRes.components.length,
      },
      line_item: {
        available: lineItemCostsRes.ok,
        status: lineItemCostsRes.status,
        pageCount: lineItemCostsRes.pageCount,
        componentCount: lineItemCostsRes.components.length,
      },
      api_key_id: {
        available: apiKeyCostsRes.ok,
        status: apiKeyCostsRes.status,
        pageCount: apiKeyCostsRes.pageCount,
        componentCount: apiKeyCostsRes.components.length,
      },
    },
    ...(costsRes.error ? { organizationCostsError: costsRes.error } : {}),
    ...(projectCostsRes.error
      ? { organizationCostProjectBreakdownError: projectCostsRes.error }
      : {}),
    ...(lineItemCostsRes.error
      ? { organizationCostLineItemBreakdownError: lineItemCostsRes.error }
      : {}),
    ...(apiKeyCostsRes.error
      ? { organizationCostApiKeyBreakdownError: apiKeyCostsRes.error }
      : {}),
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
  let hardLimitUsd: number | null = null;
  let softLimitUsd: number | null = null;

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
    hardLimitUsd = parseNumber(billing.hard_limit_usd);
    softLimitUsd = parseNumber(billing.soft_limit_usd);
    rawData.billingLimits = { hardLimitUsd, softLimitUsd };
    if (balance == null) {
      if (hardLimitUsd != null && totalCost != null) {
        balance = Math.max(0, hardLimitUsd - totalCost);
        rawData.remainingFromLimit = true;
      } else {
        balance = hardLimitUsd ?? softLimitUsd;
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

  const organizationCostBreakdownSyncs: AdapterExternalBillingSync[] = [
    ...(projectCostsRes.ok
      ? [{
          source: "openai-organization-costs-projects",
          authoritative: true,
          records: projectCostsRes.components,
        }]
      : []),
    ...(lineItemCostsRes.ok
      ? [{
          source: "openai-organization-costs-line-items",
          authoritative: true,
          records: lineItemCostsRes.components,
        }]
      : []),
    ...(apiKeyCostsRes.ok
      ? [{
          source: "openai-organization-costs-api-keys",
          authoritative: true,
          records: apiKeyCostsRes.components,
        }]
      : []),
  ];

  return {
    balance,
    totalCost,
    costWindowStart: totalCost == null ? null : monthStartDate,
    costWindowEnd: totalCost == null ? null : now,
    costScope: totalCost == null ? "unknown" : "calendar_month_to_date",
    totalRequests,
    credits: null,
    rawData,
    externalBilling:
      totalCost != null || hardLimitUsd != null || softLimitUsd != null
        ? {
            source: "openai-organization-costs",
            authoritative: true,
            records: [
              {
                externalId: monthStart,
                kind: "billing_period",
                serviceName: "OpenAI API",
                planName:
                  rawData.costSource === "organization_costs"
                    ? "Organization costs"
                    : "Legacy billing usage",
                status: "open",
                amountUsd: totalCost,
                currency: "USD",
                currentPeriodStart: monthStartDate.toISOString(),
                currentPeriodEnd: now.toISOString(),
                spendLimitUsd: hardLimitUsd ?? softLimitUsd,
                spendLimitWindow:
                  hardLimitUsd != null || softLimitUsd != null ? "month" : null,
                usageQuantity: totalRequests,
                usageUnit: "requests today",
                rollupRole: "canonical",
                dateKind: "report_through",
              },
            ],
          }
        : undefined,
    externalBillingSyncs:
      organizationCostBreakdownSyncs.length > 0 ? organizationCostBreakdownSyncs : undefined,
  };
}
