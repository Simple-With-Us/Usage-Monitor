import {
  errorResult,
  fetchJson,
  parseNumber,
  type AdapterExternalBillingRecord,
  type AdapterExternalBillingSync,
  type UsageResult,
} from "./helpers";

const ADMIN_BASE_URL = "https://console.mistral.ai/api/admin";
const WORKSPACE_PAGE_SIZE = 100;
const MAX_WORKSPACE_PAGES = 10;
const MAX_WORKSPACE_INVENTORY_ITEMS =
  WORKSPACE_PAGE_SIZE * MAX_WORKSPACE_PAGES;
const MAX_WORKSPACE_COMPONENTS = 50;
const WORKSPACE_USAGE_CONCURRENCY = 5;

type FetchJsonResult = Awaited<ReturnType<typeof fetchJson>>;

type MistralUsageReport = {
  start_date?: unknown;
  end_date?: unknown;
  currency?: unknown;
  [key: string]: unknown;
};

type MistralWorkspace = {
  uuid?: unknown;
  name?: unknown;
};

type MistralWorkspacePage = {
  items?: unknown;
  total?: unknown;
  page?: unknown;
  page_size?: unknown;
};

type MistralSpendLimits = {
  limits?: {
    completion?: {
      no_monthly_limit?: unknown;
      monthly_limit_reached?: unknown;
      usage?: unknown;
      total_usage?: unknown;
      usage_limit?: unknown;
      usage_limit_organization?: unknown;
    };
    last_payment_failure?: unknown;
    currency?: unknown;
  };
};

type MistralRateLimits = {
  requests_per_second?: unknown;
  tokens_limits_by_model?: unknown;
};

function parseIsoDate(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? value
    : null;
}

function parseCurrency(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const currency = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function parsePaginationInteger(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseSpendLimitMetadata(report: MistralSpendLimits): {
  completion: NonNullable<NonNullable<MistralSpendLimits["limits"]>["completion"]>;
  currency: string;
  unlimited: boolean;
  spendLimitUsd: number | null;
} | null {
  const limits = report.limits;
  const completion = limits?.completion;
  if (!isRecord(limits) || !isRecord(completion)) return null;

  const currency = parseCurrency(limits.currency);
  if (!currency) return null;

  const unlimited = completion.no_monthly_limit === true;
  const parsedLimit =
    parseNumber(completion.usage_limit) ??
    parseNumber(completion.usage_limit_organization);
  const validLimit = parsedLimit != null && parsedLimit >= 0 ? parsedLimit : null;

  // A successful HTTP response is not enough to reconcile stored metadata.
  // Require either the provider's explicit unlimited marker or a valid
  // numeric cap. Otherwise a malformed/partial `{}` response would upsert a
  // null cap over a previously known-good value.
  if (!unlimited && validLimit == null) return null;

  return {
    completion,
    currency,
    unlimited,
    spendLimitUsd: !unlimited && currency === "USD" ? validLimit : null,
  };
}

/**
 * The usage endpoint is documented as billing usage, but its published schema
 * currently leaves per-category payloads open-ended and does not define a
 * numeric organization-cost aggregate. Therefore this only accepts its
 * reporting window, never an arbitrary numeric counter as cash. In
 * particular, `/spend-limit` counters are caps/consumption metadata, not USD.
 */
function validateCurrentUtcUsageWindow(
  report: MistralUsageReport,
  now: Date
): { start: string; end: string; currency: string | null } | null {
  const start = parseIsoDate(report.start_date);
  const end = parseIsoDate(report.end_date);
  if (!start || !end || !Object.hasOwn(report, "currency")) return null;
  const currency = report.currency == null ? null : parseCurrency(report.currency);
  if (report.currency != null && currency == null) return null;

  const expectedStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const nextMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (startMs !== expectedStart || endMs <= startMs || endMs > nextMonth) {
    return null;
  }

  return { start, end, currency };
}

async function isolatedFetchJson(
  url: string,
  headers: Record<string, string>
): Promise<{ response: FetchJsonResult | null; error: unknown | null }> {
  try {
    return { response: await fetchJson(url, { headers }), error: null };
  } catch (error) {
    return { response: null, error };
  }
}

function normalizeWorkspace(value: unknown): { uuid: string; name: string | null } | null {
  if (!value || typeof value !== "object") return null;
  const workspace = value as MistralWorkspace;
  if (typeof workspace.uuid !== "string" || workspace.uuid.trim() === "") {
    return null;
  }
  return {
    uuid: workspace.uuid.trim(),
    name: typeof workspace.name === "string" && workspace.name.trim()
      ? workspace.name.trim()
      : null,
  };
}

async function listWorkspaces(
  headers: Record<string, string>
): Promise<{
  attempted: boolean;
  complete: boolean;
  workspaces: Array<{ uuid: string; name: string | null }>;
}> {
  let first;
  try {
    first = await fetchJson(
      `${ADMIN_BASE_URL}/workspaces?page=1&page_size=${WORKSPACE_PAGE_SIZE}`,
      { headers }
    );
  } catch {
    return { attempted: true, complete: false, workspaces: [] };
  }
  if (!first.ok) return { attempted: true, complete: false, workspaces: [] };

  const deduped = new Map<string, { uuid: string; name: string | null }>();
  const addPageItems = (items: unknown[]): boolean => {
    if (items.length > WORKSPACE_PAGE_SIZE) return false;
    for (const item of items) {
      const workspace = normalizeWorkspace(item);
      if (!workspace || deduped.has(workspace.uuid)) return false;
      deduped.set(workspace.uuid, workspace);
    }
    return true;
  };
  const workspaces = () => [...deduped.values()];
  const validPage = (
    data: MistralWorkspacePage,
    expectedPage: number,
    expectedTotal: number
  ): data is MistralWorkspacePage & { items: unknown[] } => {
    if (
      !Array.isArray(data.items) ||
      parsePaginationInteger(data.page) !== expectedPage ||
      parsePaginationInteger(data.page_size) !== WORKSPACE_PAGE_SIZE ||
      parsePaginationInteger(data.total) !== expectedTotal
    ) {
      return false;
    }
    const offset = (expectedPage - 1) * WORKSPACE_PAGE_SIZE;
    const expectedItems = Math.max(
      0,
      Math.min(WORKSPACE_PAGE_SIZE, expectedTotal - offset)
    );
    return data.items.length === expectedItems;
  };

  const firstPage = (first.data ?? {}) as MistralWorkspacePage;
  const firstTotal = parsePaginationInteger(firstPage.total);
  if (
    firstTotal == null ||
    !validPage(firstPage, 1, firstTotal) ||
    !addPageItems(firstPage.items)
  ) {
    return { attempted: true, complete: false, workspaces: workspaces() };
  }

  const total = firstTotal;
  const pages = Math.max(1, Math.ceil(total / WORKSPACE_PAGE_SIZE));
  if (total > MAX_WORKSPACE_INVENTORY_ITEMS || pages > MAX_WORKSPACE_PAGES) {
    return { attempted: true, complete: false, workspaces: workspaces() };
  }
  if (total === 0) {
    return { attempted: true, complete: true, workspaces: [] };
  }

  for (let page = 2; page <= pages; page += 1) {
    let response;
    try {
      response = await fetchJson(
        `${ADMIN_BASE_URL}/workspaces?page=${page}&page_size=${WORKSPACE_PAGE_SIZE}`,
        { headers }
      );
    } catch {
      return { attempted: true, complete: false, workspaces: workspaces() };
    }
    const data = (response.data ?? {}) as MistralWorkspacePage;
    if (
      !response.ok ||
      !validPage(data, page, total) ||
      !addPageItems(data.items)
    ) {
      return { attempted: true, complete: false, workspaces: workspaces() };
    }
  }

  return {
    attempted: true,
    complete: deduped.size === total,
    workspaces: workspaces(),
  };
}

async function mapWithConcurrency<T, R>(
  values: T[],
  mapper: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(WORKSPACE_USAGE_CONCURRENCY, values.length) },
    async () => {
      while (next < values.length) {
        const index = next;
        next += 1;
        results[index] = await mapper(values[index]);
      }
    }
  );
  await Promise.all(workers);
  return results;
}

async function fetchWorkspaceUsageRecords(
  workspaces: Array<{ uuid: string; name: string | null }>,
  headers: Record<string, string>,
  now: Date
): Promise<{
  records: AdapterExternalBillingRecord[];
  attempted: number;
  failed: number;
  capped: boolean;
  complete: boolean;
}> {
  const bounded = workspaces.slice(0, MAX_WORKSPACE_COMPONENTS);
  const results = await mapWithConcurrency<
    { uuid: string; name: string | null },
    AdapterExternalBillingRecord | null
  >(bounded, async (workspace) => {
    const params = new URLSearchParams({
      month: String(now.getUTCMonth() + 1),
      year: String(now.getUTCFullYear()),
      workspace_id: workspace.uuid,
    });
    let response;
    try {
      response = await fetchJson(`${ADMIN_BASE_URL}/usage?${params}`, { headers });
    } catch {
      return null;
    }
    if (!response.ok) return null;
    const report = (response.data ?? {}) as MistralUsageReport;
    const window = validateCurrentUtcUsageWindow(report, now);
    if (!window) return null;

    return {
      externalId: workspace.uuid,
      kind: "billing_period" as const,
      serviceName: workspace.name ? `Mistral workspace: ${workspace.name}` : "Mistral workspace",
      planName: "Mistral workspace billing usage (cash total unavailable)",
      status: "cost_unavailable",
      amountUsd: null,
      currency: window.currency,
      currentPeriodStart: window.start,
      currentPeriodEnd: window.end,
      rollupRole: "component" as const,
      dateKind: "report_through" as const,
    };
  });

  const records = results.filter(
      (record): record is AdapterExternalBillingRecord => record != null
    );
  return {
    records,
    attempted: bounded.length,
    failed: bounded.length - records.length,
    capped: bounded.length < workspaces.length,
    complete:
      bounded.length === workspaces.length &&
      results.every((record) => record != null),
  };
}

export async function fetchUsage(
  apiKey: string,
  config?: Record<string, unknown>
): Promise<UsageResult> {
  const adminApiKey =
    (config?.adminApiKey as string | undefined)?.trim() || apiKey;
  const headers = { "x-api-key": adminApiKey };
  const now = new Date();
  const params = new URLSearchParams({
    month: String(now.getUTCMonth() + 1),
    year: String(now.getUTCFullYear()),
  });

  const [usageAttempt, limitsAttempt, rateAttempt, workspaceList] = await Promise.all([
    isolatedFetchJson(`${ADMIN_BASE_URL}/usage?${params}`, headers),
    isolatedFetchJson(`${ADMIN_BASE_URL}/spend-limit`, headers),
    isolatedFetchJson(`${ADMIN_BASE_URL}/rate-limit`, headers),
    listWorkspaces(headers),
  ]);
  const usageResponse = usageAttempt.response;
  const limitsResponse = limitsAttempt.response;
  const rateResponse = rateAttempt.response;

  if (!usageResponse?.ok && !limitsResponse?.ok && !rateResponse?.ok) {
    const transportError =
      usageAttempt.error ?? limitsAttempt.error ?? rateAttempt.error;
    if (transportError) throw transportError;
    return errorResult(
      usageResponse?.status || limitsResponse?.status || rateResponse?.status || 0,
      { note: "Mistral billing endpoints require a Backoffice Admin API key" }
    );
  }

  const usage = (usageResponse?.data ?? {}) as MistralUsageReport;
  const limits = (limitsResponse?.data ?? {}) as MistralSpendLimits;
  const rate = (rateResponse?.data ?? {}) as MistralRateLimits;
  const spendLimitMetadata = limitsResponse?.ok
    ? parseSpendLimitMetadata(limits)
    : null;
  const completion = spendLimitMetadata?.completion;
  const usageWindow = usageResponse?.ok
    ? validateCurrentUtcUsageWindow(usage, now)
    : null;
  const spendLimitUsd = spendLimitMetadata?.spendLimitUsd ?? null;
  const requestLimit = rateResponse?.ok ? parseNumber(rate.requests_per_second) : null;
  const status = spendLimitMetadata?.unlimited
    ? "unlimited"
    : limits.limits?.last_payment_failure === true
      ? "payment_failed"
      : completion?.monthly_limit_reached === true
        ? "limit_reached"
        : "active";
  const billingSyncs: AdapterExternalBillingSync[] = [];

  // This stable source identity intentionally clears the old false cash value.
  // A valid report lets the UI show its period/currency while stating that the
  // provider has not published a schema-safe numeric organization total.
  if (usageWindow) {
    billingSyncs.push({
      source: "mistral-usage-billing",
      authoritative: true,
      records: [
        {
          externalId: usageWindow.start.slice(0, 7),
          kind: "billing_period",
          planName: "Mistral organization billing usage (cash total unavailable)",
          status: "cost_unavailable",
          amountUsd: null,
          currency: usageWindow.currency,
          currentPeriodStart: usageWindow.start,
          currentPeriodEnd: usageWindow.end,
          rollupRole: "canonical",
          dateKind: "report_through",
        },
      ],
    });
  }
  if (spendLimitMetadata) {
    billingSyncs.push({
      source: "mistral-spend-limits",
      authoritative: true,
      records: [
        {
          externalId: "organization",
          kind: "account",
          planName: "Mistral organization spend limit",
          status,
          spendLimitUsd,
          spendLimitWindow: spendLimitMetadata.unlimited ? null : "month",
          rollupRole: "metadata",
        },
      ],
    });
  }
  if (requestLimit != null) {
    billingSyncs.push({
      source: "mistral-rate-limits",
      authoritative: true,
      records: [
        {
          externalId: "organization",
          kind: "account",
          planName: "Mistral organization rate limit",
          status: "active",
          requestLimit,
          requestLimitWindow: "second",
          rollupRole: "metadata",
        },
      ],
    });
  }

  let workspaceUsage: Awaited<ReturnType<typeof fetchWorkspaceUsageRecords>> = {
    records: [],
    attempted: 0,
    failed: 0,
    capped: false,
    complete: workspaceList.complete && workspaceList.workspaces.length === 0,
  };
  if (workspaceList.complete || workspaceList.workspaces.length > 0) {
    workspaceUsage = await fetchWorkspaceUsageRecords(
      workspaceList.workspaces,
      headers,
      now
    );
    billingSyncs.push({
      source: "mistral-workspace-usage",
      authoritative: workspaceList.complete && workspaceUsage.complete,
      records: workspaceUsage.records,
    });
  }

  return {
    balance: null,
    totalCost: null,
    costWindowStart: null,
    costWindowEnd: null,
    costScope: "unknown",
    costCoverageCaveat: {
      code: "mistral_usage_cash_total_schema_unavailable",
      message: "Mistral's Admin Usage endpoint reports billing usage, but its published schema does not define a numeric organization cash total. Spend-limit counters are shown only as cap metadata, never as cash spend.",
    },
    totalRequests: null,
    credits: null,
    rawData: {
      usage: usageResponse?.ok ? usage : null,
      spendLimit: limitsResponse?.ok ? limits : null,
      rateLimit: rateResponse?.ok ? rate : null,
      workspaceCoverage: {
        attempted: workspaceList.attempted,
        enumerated: workspaceList.workspaces.length,
        enumerationComplete: workspaceList.complete,
        reportsAttempted: workspaceUsage.attempted,
        reportsSucceeded: workspaceUsage.records.length,
        reportsFailed: workspaceUsage.failed,
        reportsCapped: workspaceUsage.capped,
        complete: workspaceList.complete && workspaceUsage.complete,
      },
      capabilities: {
        actualCost: false,
        usageBreakdown: usageWindow != null,
        spendLimit: spendLimitUsd != null,
        rateLimit: requestLimit != null,
        workspaceUsage: workspaceList.complete && workspaceUsage.complete,
        credential: "Mistral Backoffice Admin API key",
      },
    },
    externalBillingSyncs: billingSyncs.length > 0 ? billingSyncs : undefined,
  };
}
