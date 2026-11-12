import {
  AdapterError,
  configurationError,
  errorResult,
  fetchJson,
  parseNumber,
  type AdapterExternalBillingRecord,
  type UsageResult,
} from "./helpers";
import {
  sentryUsageCategoriesView,
  sentryUsageServiceName,
  sentryUsageUnitForCategory,
  type SentryCategoryTotal,
  type SentryUsageGroup,
} from "@/lib/sentry-usage-categories";

interface SentryProjectDiscovery {
  projectIds: string[];
  pages: number;
}

const SENTRY_API_ORIGIN = "https://sentry.io";
const MAX_PROJECT_PAGES = 100;

function invalidResponse(message: string): never {
  throw new AdapterError(`Sentry returned an invalid API response: ${message}`, {
    code: "INVALID_RESPONSE",
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readDimension(value: unknown, field: string): string {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  invalidResponse(`${field} must be a non-empty string or number`);
}

function readQuantity(value: unknown): number {
  const parsed = parseNumber(value);
  if (parsed == null || !Number.isSafeInteger(parsed) || parsed < 0) {
    invalidResponse("sum(quantity) must be a non-negative integer");
  }
  return parsed;
}

function unitForCategory(category: string): SentryUsageGroup["unit"] {
  return sentryUsageUnitForCategory(category);
}

function readLinkAttribute(
  attributes: string,
  name: "rel" | "results"
): string | null {
  let found: string | null = null;
  for (const attribute of attributes.split(";")) {
    const separator = attribute.indexOf("=");
    if (separator < 0) continue;
    const key = attribute.slice(0, separator).trim().toLowerCase();
    if (key !== name) continue;
    if (found != null) {
      invalidResponse(`project pagination repeated its ${name} attribute`);
    }
    const rawValue = attribute.slice(separator + 1).trim();
    found = rawValue.startsWith('"') && rawValue.endsWith('"')
      ? rawValue.slice(1, -1)
      : rawValue;
  }
  return found;
}

function readNextProjectCursor(headers: Headers, expectedPath: string): string | null {
  const linkHeader = headers.get("link");
  if (!linkHeader) {
    invalidResponse("project pagination omitted the Link header");
  }

  const nextLinks: Array<{ target: string; attributes: string }> = [];
  for (const segment of linkHeader.split(/,\s*(?=<)/)) {
    const match = segment.match(/^\s*<([^>]+)>(.*)$/);
    if (!match) {
      invalidResponse("project pagination contained a malformed Link entry");
    }
    if (readLinkAttribute(match[2], "rel") === "next") {
      nextLinks.push({ target: match[1], attributes: match[2] });
    }
  }

  if (nextLinks.length !== 1) {
    invalidResponse("project pagination must contain exactly one next Link");
  }

  const [{ target, attributes }] = nextLinks;
  const results = readLinkAttribute(attributes, "results");
  if (results !== "true" && results !== "false") {
    invalidResponse("project pagination next Link omitted a valid results flag");
  }

  let nextUrl: URL;
  try {
    nextUrl = new URL(target);
  } catch {
    invalidResponse("project pagination next Link URL was invalid");
  }
  if (
    nextUrl.origin !== SENTRY_API_ORIGIN ||
    nextUrl.pathname !== expectedPath ||
    nextUrl.username ||
    nextUrl.password ||
    nextUrl.hash
  ) {
    invalidResponse("project pagination next Link URL was unsafe");
  }

  if (results === "false") return null;

  const cursors = nextUrl.searchParams.getAll("cursor");
  if (cursors.length !== 1 || cursors[0].trim() === "") {
    invalidResponse("project pagination next Link omitted a unique cursor");
  }
  return cursors[0];
}

async function discoverAccessibleProjects(
  orgSlug: string,
  headers: Record<string, string>
): Promise<SentryProjectDiscovery> {
  const expectedPath = `/api/0/organizations/${encodeURIComponent(orgSlug)}/projects/`;
  const projectIds: string[] = [];
  const seenProjectIds = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  for (let page = 1; page <= MAX_PROJECT_PAGES; page += 1) {
    const url = new URL(expectedPath, SENTRY_API_ORIGIN);
    url.searchParams.set("per_page", "100");
    if (cursor) url.searchParams.set("cursor", cursor);

    const response = await fetchJson(url.toString(), { headers });
    if (!response.ok) {
      return errorResult(response.status, {
        note: "Sentry project discovery failed",
      });
    }
    if (!Array.isArray(response.data)) {
      invalidResponse("projects must be an array");
    }

    for (const project of response.data) {
      if (!isRecord(project)) {
        invalidResponse("each project must be an object");
      }
      if (project.hasAccess === false) continue;

      const projectId = readDimension(project.id, "project.id");
      if (seenProjectIds.has(projectId)) {
        invalidResponse(`project pagination repeated project ${projectId}`);
      }
      seenProjectIds.add(projectId);
      projectIds.push(projectId);
    }

    const nextCursor = readNextProjectCursor(response.headers, expectedPath);
    if (nextCursor == null) return { projectIds, pages: page };
    if (seenCursors.has(nextCursor)) {
      invalidResponse("project pagination repeated a cursor");
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  invalidResponse(`project pagination exceeded ${MAX_PROJECT_PAGES} pages`);
}

function parseProjectGroups(data: unknown, projectId: string): SentryUsageGroup[] {
  if (!isRecord(data) || !Array.isArray(data.groups)) {
    invalidResponse("stats_v2 groups must be an array");
  }

  const seenGroups = new Set<string>();
  return data.groups.map((group) => {
    if (!isRecord(group) || !isRecord(group.by) || !isRecord(group.totals)) {
      invalidResponse("each stats_v2 group must contain by and totals objects");
    }
    const category = readDimension(group.by.category, "group.by.category");
    const outcome = readDimension(group.by.outcome, "group.by.outcome");
    const groupKey = JSON.stringify([projectId, category, outcome]);
    if (seenGroups.has(groupKey)) {
      invalidResponse(
        `stats_v2 repeated category/outcome group for project ${projectId}`
      );
    }
    seenGroups.add(groupKey);
    return {
      project: projectId,
      category,
      outcome,
      quantity: readQuantity(group.totals["sum(quantity)"]),
      unit: unitForCategory(category),
    };
  });
}

async function fetchProjectGroups(
  projectIds: string[],
  monthStart: string,
  periodEnd: string,
  orgSlug: string,
  headers: Record<string, string>
): Promise<SentryUsageGroup[]> {
  const groups: SentryUsageGroup[] = [];

  // Keep these requests sequential: large Sentry organizations can have many
  // projects, and a concurrent fan-out would needlessly amplify rate limiting.
  for (const projectId of projectIds) {
    const query = new URLSearchParams({
      field: "sum(quantity)",
      project: projectId,
      start: monthStart,
      end: periodEnd,
    });
    query.append("groupBy", "category");
    query.append("groupBy", "outcome");

    const response = await fetchJson(
      `${SENTRY_API_ORIGIN}/api/0/organizations/${encodeURIComponent(orgSlug)}/stats_v2/?${query.toString()}`,
      { headers }
    );
    if (!response.ok) {
      return errorResult(response.status, {
        note: "Sentry stats_v2 project query failed",
      });
    }
    groups.push(...parseProjectGroups(response.data, projectId));
  }

  return groups;
}

function sumUnit(groups: SentryUsageGroup[], unit: SentryUsageGroup["unit"]): number {
  let sum = 0;
  for (const group of groups) {
    if (group.unit !== unit) continue;
    sum += group.quantity;
    if (!Number.isSafeInteger(sum)) {
      invalidResponse(`${unit} quantity total exceeded safe integer precision`);
    }
  }
  return sum;
}

function readOptionalQuantity(value: unknown): number | null {
  const parsed = parseNumber(value);
  if (parsed == null || !Number.isSafeInteger(parsed) || parsed < 0) return null;
  return parsed;
}

interface SentryStatsSummaryView {
  available: boolean;
  status?: number;
  byCategory?: SentryCategoryTotal[];
}

function parseStatsSummary(data: unknown): SentryCategoryTotal[] | null {
  if (!isRecord(data) || !Array.isArray(data.projects)) return null;
  const groups: SentryUsageGroup[] = [];
  for (const project of data.projects) {
    if (!isRecord(project) || !Array.isArray(project.stats)) return null;
    const projectId = typeof project.id === "string" || typeof project.id === "number"
      ? String(project.id)
      : "unknown";
    for (const stat of project.stats) {
      if (!isRecord(stat) || typeof stat.category !== "string" || !isRecord(stat.outcomes)) {
        return null;
      }
      for (const [outcome, quantity] of Object.entries(stat.outcomes)) {
        const parsed = readOptionalQuantity(quantity);
        if (parsed == null) return null;
        if (parsed === 0) continue;
        groups.push({
          project: projectId,
          category: stat.category,
          outcome,
          quantity: parsed,
          unit: unitForCategory(stat.category),
        });
      }
    }
  }
  return sentryUsageCategoriesView(groups).byCategory;
}

async function fetchOptionalStatsSummary(
  monthStart: string,
  periodEnd: string,
  orgSlug: string,
  headers: Record<string, string>
): Promise<SentryStatsSummaryView> {
  const query = new URLSearchParams({
    field: "sum(quantity)",
    start: monthStart,
    end: periodEnd,
  });
  try {
    const response = await fetchJson(
      `${SENTRY_API_ORIGIN}/api/0/organizations/${encodeURIComponent(orgSlug)}/stats-summary/?${query.toString()}`,
      { headers }
    );
    if (!response.ok) {
      return { available: false, status: response.status };
    }
    const byCategory = parseStatsSummary(response.data);
    if (!byCategory) return { available: false, status: 200 };
    return { available: true, status: 200, byCategory };
  } catch {
    return { available: false };
  }
}

export async function fetchUsage(
  apiKey: string,
  config?: Record<string, unknown>
): Promise<UsageResult> {
  const orgSlug = config?.orgSlug;

  if (typeof orgSlug !== "string" || orgSlug.trim() === "") {
    configurationError("orgSlug is required in config");
  }

  const headers = { Authorization: `Bearer ${apiKey}` };
  const now = new Date();
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  ).toISOString();
  const periodEnd = now.toISOString();
  const discovery = await discoverAccessibleProjects(orgSlug, headers);
  const groups = await fetchProjectGroups(
    discovery.projectIds,
    monthStart,
    periodEnd,
    orgSlug,
    headers
  );

  const eventCount = sumUnit(groups, "events");
  const byteCount = sumUnit(groups, "bytes");
  const millisecondCount = sumUnit(groups, "milliseconds");
  const categories = sentryUsageCategoriesView(groups);
  const statsSummary = await fetchOptionalStatsSummary(
    monthStart,
    periodEnd,
    orgSlug,
    headers
  );
  const records: AdapterExternalBillingRecord[] = groups.map((group) => ({
    externalId: [
      "mtd",
      monthStart.slice(0, 10),
      group.project,
      group.category,
      group.outcome,
    ]
      .map(encodeURIComponent)
      .join(":"),
    kind: "billing_period",
    serviceName: sentryUsageServiceName(group.project, group.category, group.outcome),
    status: "usage_reported",
    currentPeriodStart: monthStart,
    currentPeriodEnd: periodEnd,
    usageQuantity: group.quantity,
    usageUnit: group.unit,
    rollupRole: "metadata",
    dateKind: "report_through",
  }));

  return {
    balance: null,
    // stats_v2 exposes telemetry quantities, not Sentry invoice spend.
    // Unknown vendor cost must remain null rather than appearing as $0.
    totalCost: null,
    costScope: "unknown",
    totalRequests: eventCount,
    credits: null,
    rawData: {
      period: {
        scope: "calendar_month_to_date",
        start: monthStart,
        end: periodEnd,
      },
      categories,
      stats: {
        field: "sum(quantity)",
        groupedBy: ["category", "outcome", "project"],
        queryStrategy: "per_project",
        projectDiscovery: {
          accessibleProjects: discovery.projectIds.length,
          pages: discovery.pages,
        },
        totals: {
          events: eventCount,
          bytes: byteCount,
          milliseconds: millisecondCount,
        },
        capabilities: {
          usageByCategoryOutcomeProject: true,
          billingCost: false,
          prepaidBalance: false,
          requestQuota: false,
          subscriptionStatus: false,
        },
        statsSummary,
      },
    },
    externalBilling: {
      source: "sentry-stats-v2",
      authoritative: true,
      records,
    },
  };
}
