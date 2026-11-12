import {
  AdapterError,
  configurationError,
  errorResult,
  fetchJson,
  type AdapterExternalBillingRecord,
  type FetchJsonOptions,
  type UsageResult,
} from "./helpers";

const DEFAULT_HOST = "https://api.cloud.llamaindex.ai";
const PAGE_SIZE = 100;
const MAX_PAGES = 100;

interface Organization {
  id: string;
  name: string;
}

interface OrganizationUsage {
  creditsConsumed: number | null;
  creditsConsumedKnownLowerBound: number;
  creditCoverage: "complete" | "partial" | "unknown";
  metricCount: number;
  metricsWithCredits: number;
  valuesByEventType: Record<string, number>;
  creditsByEventType: Record<string, number>;
}

function invalidResponse(message: string): never {
  throw new AdapterError(`LlamaIndex Cloud returned an invalid response: ${message}`, {
    code: "INVALID_RESPONSE",
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRequiredString(
  value: unknown,
  field: string
): string {
  if (typeof value !== "string" || value.trim() === "") {
    invalidResponse(`${field} must be a non-empty string`);
  }
  return value;
}

function readNextPageToken(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string" || value === "") {
    invalidResponse("next_page_token must be a non-empty string or null");
  }
  return value;
}

function readNonnegativeNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    invalidResponse(`${field} must be a finite non-negative number`);
  }
  return value;
}

function readNonnegativeInteger(value: unknown, field: string): number {
  const parsed = readNonnegativeNumber(value, field);
  if (!Number.isSafeInteger(parsed)) {
    invalidResponse(`${field} must be a non-negative integer`);
  }
  return parsed;
}

function resolveHost(config?: Record<string, unknown>): string {
  const configured = config?.host;
  if (configured != null && typeof configured !== "string") {
    configurationError("host must be a string");
  }
  return (configured || DEFAULT_HOST).replace(/\/+$/, "");
}

function resolveProjectId(config?: Record<string, unknown>): string | null {
  const configured = config?.projectId;
  if (configured == null || configured === "") return null;
  if (typeof configured !== "string") {
    configurationError("projectId must be a string");
  }
  return configured;
}

function fetchOptions(host: string): FetchJsonOptions {
  return { security: host === DEFAULT_HOST ? "trusted" : "untrusted" };
}

async function discoverOrganizations(
  apiKey: string,
  host: string
): Promise<Organization[]> {
  const organizations: Organization[] = [];
  const organizationIds = new Set<string>();
  const seenPageTokens = new Set<string>();
  let pageToken: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    if (pageToken) {
      if (seenPageTokens.has(pageToken)) {
        invalidResponse("organization pagination repeated a page token");
      }
      seenPageTokens.add(pageToken);
    }

    const query = new URLSearchParams({ page_size: String(PAGE_SIZE) });
    if (pageToken) query.set("page_token", pageToken);
    const response = await fetchJson(
      `${host}/api/v2/organizations?${query.toString()}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
      fetchOptions(host)
    );

    if (!response.ok) {
      errorResult(response.status, { response: response.data });
    }
    if (!isRecord(response.data) || !Array.isArray(response.data.items)) {
      invalidResponse("organization page must contain an items array");
    }

    for (const item of response.data.items) {
      if (!isRecord(item)) {
        invalidResponse("organization item must be an object");
      }
      const id = readRequiredString(item.id, "organization.id");
      const name = readRequiredString(item.name, "organization.name");
      if (organizationIds.has(id)) {
        invalidResponse(`organization ${id} was returned more than once`);
      }
      organizationIds.add(id);
      organizations.push({ id, name });
    }

    pageToken = readNextPageToken(response.data.next_page_token);
    if (!pageToken) return organizations;
  }

  invalidResponse(`organization pagination exceeded ${MAX_PAGES} pages`);
}

async function fetchOrganizationUsage(
  apiKey: string,
  host: string,
  organizationId: string,
  projectId: string | null,
  monthStart: string,
  throughDay: string
): Promise<OrganizationUsage> {
  const seenPageTokens = new Set<string>();
  const valuesByEventType: Record<string, number> = {};
  const creditsByEventType: Record<string, number> = {};
  let creditsConsumed = 0;
  let metricCount = 0;
  let metricsWithCredits = 0;
  let pageToken: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    if (pageToken) {
      if (seenPageTokens.has(pageToken)) {
        invalidResponse(`usage pagination repeated a page token for organization ${organizationId}`);
      }
      seenPageTokens.add(pageToken);
    }

    const query = new URLSearchParams({
      organization_id: organizationId,
      page_size: String(PAGE_SIZE),
      day_on_or_after: monthStart,
      day_on_or_before: throughDay,
    });
    if (projectId) query.set("project_id", projectId);
    if (pageToken) query.set("page_token", pageToken);

    const response = await fetchJson(
      `${host}/api/v1/beta/usage-metrics?${query.toString()}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
      fetchOptions(host)
    );

    if (!response.ok) {
      // Throwing means no snapshot or authoritative external-billing sync is
      // committed from a partial multi-organization result.
      errorResult(response.status, { response: response.data });
    }
    if (!isRecord(response.data) || !Array.isArray(response.data.items)) {
      invalidResponse("usage page must contain an items array");
    }

    for (const item of response.data.items) {
      if (!isRecord(item)) {
        invalidResponse("usage metric must be an object");
      }
      const eventType = readRequiredString(item.event_type, "usage_metric.event_type");
      const metricOrganizationId = readRequiredString(
        item.organization_id,
        "usage_metric.organization_id"
      );
      if (metricOrganizationId !== organizationId) {
        invalidResponse("usage metric belongs to a different organization");
      }

      const metricProjectId = readRequiredString(item.project_id, "usage_metric.project_id");
      if (projectId && metricProjectId !== projectId) {
        invalidResponse("usage metric belongs to a different project");
      }

      const day = readRequiredString(item.day, "usage_metric.day");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < monthStart || day > throughDay) {
        invalidResponse("usage metric day is outside the requested UTC month-to-date window");
      }

      const value = readNonnegativeInteger(item.value, "usage_metric.value");
      valuesByEventType[eventType] = (valuesByEventType[eventType] ?? 0) + value;

      if (item.credits != null) {
        const credits = readNonnegativeNumber(item.credits, "usage_metric.credits");
        creditsConsumed += credits;
        creditsByEventType[eventType] =
          (creditsByEventType[eventType] ?? 0) + credits;
        metricsWithCredits++;
      }
      metricCount++;
    }

    pageToken = readNextPageToken(response.data.next_page_token);
    if (!pageToken) {
      const creditCoverage =
        metricsWithCredits === metricCount
          ? "complete"
          : metricsWithCredits > 0
            ? "partial"
            : "unknown";
      return {
        creditsConsumed: creditCoverage === "complete" ? creditsConsumed : null,
        creditsConsumedKnownLowerBound: creditsConsumed,
        creditCoverage,
        metricCount,
        metricsWithCredits,
        valuesByEventType,
        creditsByEventType,
      };
    }
  }

  invalidResponse(`usage pagination exceeded ${MAX_PAGES} pages for organization ${organizationId}`);
}

export async function fetchUsage(
  apiKey: string,
  config?: Record<string, unknown>
): Promise<UsageResult> {
  const host = resolveHost(config);
  const projectId = resolveProjectId(config);
  const now = new Date();
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  ).toISOString().slice(0, 10);
  const throughDay = now.toISOString().slice(0, 10);
  const periodStart = `${monthStart}T00:00:00.000Z`;
  const periodEnd = now.toISOString();

  const organizations = await discoverOrganizations(apiKey, host);
  const organizationUsage: Array<Organization & OrganizationUsage> = [];

  for (const organization of organizations) {
    organizationUsage.push({
      ...organization,
      ...(await fetchOrganizationUsage(
        apiKey,
        host,
        organization.id,
        projectId,
        monthStart,
        throughDay
      )),
    });
  }

  const creditsConsumedKnownLowerBound = organizationUsage.reduce(
    (sum, usage) => sum + usage.creditsConsumedKnownLowerBound,
    0
  );
  const creditCoverage = organizationUsage.every(
    (usage) => usage.creditCoverage === "complete"
  )
    ? "complete"
    : organizationUsage.some((usage) => usage.metricsWithCredits > 0)
      ? "partial"
      : "unknown";
  const totalCreditsConsumed =
    creditCoverage === "complete" ? creditsConsumedKnownLowerBound : null;
  const externalRecords: AdapterExternalBillingRecord[] = organizationUsage.map(
    (usage) => ({
      externalId: `organization:${usage.id}:${monthStart}`,
      kind: "billing_period",
      serviceName: usage.name,
      status:
        usage.creditCoverage === "complete"
          ? "usage_reported"
          : "usage_partial",
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      usageQuantity: usage.creditsConsumed,
      usageUnit: "credits_consumed",
      rollupRole: "metadata",
      dateKind: "report_through",
    })
  );

  return {
    balance: null,
    // LlamaIndex reports product credits consumed, not dollars or a remaining
    // prepaid balance. Keep vendor cost unknown rather than fabricating $0.
    totalCost: null,
    totalRequests: null,
    // UsageSnapshot.credits is rendered as a remaining balance throughout the
    // app. LlamaIndex returns credits consumed, so exposing that value here
    // would invert the dashboard meaning. Preserve it only as usage metadata
    // and in the provider-billing records below.
    credits: null,
    rawData: {
      period: {
        scope: "calendar_month_to_date",
        start: periodStart,
        end: periodEnd,
      },
      projectId,
      organizationCount: organizationUsage.length,
      creditsConsumed: totalCreditsConsumed,
      creditsConsumedKnownLowerBound,
      creditCoverage,
      organizations: organizationUsage,
      capabilities: {
        usageCredits: totalCreditsConsumed != null,
        usageCreditsComplete: creditCoverage === "complete",
        creditBalance: false,
        billingCost: false,
        subscriptionStatus: false,
      },
    },
    externalBilling: {
      source: "llamaindex-usage-metrics",
      authoritative: true,
      records: externalRecords,
    },
  };
}
