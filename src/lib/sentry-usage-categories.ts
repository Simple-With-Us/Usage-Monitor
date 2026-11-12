/**
 * Sentry Usage category labels and totals.
 *
 * Official stats_v2 / stats-summary expose event quantities by category and
 * outcome.  They do not expose prepaid credit, remaining sponsored balance,
 * reserved quota, PAYG, or invoice spend.  Do not invent those fields here.
 *
 * Spans and logs are not on the public stats_v2 category whitelist.  Do not
 * label Transactions as Spans.
 */

export const SENTRY_USAGE_UNITS = ["events", "bytes", "milliseconds"] as const;
export type SentryUsageUnit = (typeof SENTRY_USAGE_UNITS)[number];

export const SENTRY_USAGE_FAMILIES = [
  "Errors",
  "Transactions",
  "Replays",
  "Attachments",
  "Profiles",
  "Monitors",
] as const;
export type SentryUsageFamily = (typeof SENTRY_USAGE_FAMILIES)[number];

export interface SentryUsageGroup {
  project: string;
  category: string;
  outcome: string;
  quantity: number;
  unit: SentryUsageUnit;
}

export interface SentryCategoryTotal {
  category: string;
  label: string;
  family: SentryUsageFamily | "Other";
  unit: SentryUsageUnit;
  accepted: number;
  rateLimited: number;
  filtered: number;
  other: number;
  total: number;
}

const CATEGORY_FAMILY: Record<string, SentryUsageFamily> = {
  error: "Errors",
  transaction: "Transactions",
  replay: "Replays",
  replays: "Replays",
  attachment: "Attachments",
  profile: "Profiles",
  profiles: "Profiles",
  profile_duration: "Profiles",
  profile_duration_ui: "Profiles",
  profile_chunk: "Profiles",
  profile_chunk_ui: "Profiles",
  monitor: "Monitors",
};

const OUTCOME_LABELS: Record<string, string> = {
  accepted: "Accepted",
  filtered: "Filtered",
  rate_limited: "Rate Limited",
  invalid: "Invalid",
  abuse: "Abuse",
  client_discard: "Client Discard",
  cardinality_limited: "Cardinality Limited",
};

const BLOCKED_INVENTED_LABELS = new Set(["span", "spans", "log", "logs"]);

export function sentryUsageUnitForCategory(category: string): SentryUsageUnit {
  if (category === "attachment") return "bytes";
  if (category === "profile_duration" || category === "profile_duration_ui") {
    return "milliseconds";
  }
  return "events";
}

function titleCaseToken(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "Other";
  return trimmed[0].toUpperCase() + trimmed.slice(1).toLowerCase();
}

function humanizeSnakeCase(value: string): string {
  return value
    .trim()
    .split(/[_-]+/)
    .filter(Boolean)
    .map(titleCaseToken)
    .join(" ");
}

export function sentryCategoryFamily(
  category: string
): SentryUsageFamily | "Other" {
  const key = category.trim().toLowerCase();
  if (BLOCKED_INVENTED_LABELS.has(key)) return "Other";
  return CATEGORY_FAMILY[key] ?? "Other";
}

export function sentryCategoryLabel(category: string): string {
  const key = category.trim().toLowerCase();
  if (BLOCKED_INVENTED_LABELS.has(key)) return "Other";
  const family = CATEGORY_FAMILY[key];
  if (family) return family;
  return humanizeSnakeCase(key) || "Other";
}

export function sentryOutcomeLabel(outcome: string): string {
  const key = outcome.trim().toLowerCase();
  return OUTCOME_LABELS[key] ?? humanizeSnakeCase(key);
}

export function sentryUsageServiceName(
  projectId: string,
  category: string,
  outcome: string
): string {
  return `Project ${projectId}: ${sentryCategoryLabel(category)} (${sentryOutcomeLabel(outcome)})`;
}

function emptyCategoryTotal(
  category: string,
  unit: SentryUsageUnit
): SentryCategoryTotal {
  return {
    category,
    label: sentryCategoryLabel(category),
    family: sentryCategoryFamily(category),
    unit,
    accepted: 0,
    rateLimited: 0,
    filtered: 0,
    other: 0,
    total: 0,
  };
}

function addQuantity(current: number, quantity: number): number {
  const next = current + quantity;
  if (!Number.isSafeInteger(next) || next < 0) {
    throw new RangeError("Sentry usage quantity total exceeded safe integer precision");
  }
  return next;
}

export function aggregateSentryByCategory(
  groups: readonly SentryUsageGroup[]
): SentryCategoryTotal[] {
  const byKey = new Map<string, SentryCategoryTotal>();

  for (const group of groups) {
    const key = `${group.category}\0${group.unit}`;
    const current = byKey.get(key) ?? emptyCategoryTotal(group.category, group.unit);
    const outcome = group.outcome.trim().toLowerCase();
    if (outcome === "accepted") {
      current.accepted = addQuantity(current.accepted, group.quantity);
    } else if (outcome === "rate_limited") {
      current.rateLimited = addQuantity(current.rateLimited, group.quantity);
    } else if (outcome === "filtered") {
      current.filtered = addQuantity(current.filtered, group.quantity);
    } else {
      current.other = addQuantity(current.other, group.quantity);
    }
    current.total = addQuantity(current.total, group.quantity);
    byKey.set(key, current);
  }

  const familyOrder = new Map<string, number>(
    SENTRY_USAGE_FAMILIES.map((family, index) => [family, index])
  );
  return [...byKey.values()].sort((left, right) => {
    const leftFamily = familyOrder.get(left.family) ?? SENTRY_USAGE_FAMILIES.length;
    const rightFamily = familyOrder.get(right.family) ?? SENTRY_USAGE_FAMILIES.length;
    if (leftFamily !== rightFamily) return leftFamily - rightFamily;
    if (left.category !== right.category) {
      return left.category.localeCompare(right.category);
    }
    return left.unit.localeCompare(right.unit);
  });
}

export interface SentryUsageCategoriesView {
  byCategory: SentryCategoryTotal[];
  blocked: {
    prepaidBalance: false;
    reservedQuotaRemaining: false;
    paygInvoice: false;
    spans: false;
    logs: false;
  };
}

export const SENTRY_USAGE_BLOCKED = {
  prepaidBalance: false,
  reservedQuotaRemaining: false,
  paygInvoice: false,
  spans: false,
  logs: false,
} as const;

export function sentryUsageCategoriesView(
  groups: readonly SentryUsageGroup[]
): SentryUsageCategoriesView {
  return {
    byCategory: aggregateSentryByCategory(groups),
    blocked: { ...SENTRY_USAGE_BLOCKED },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonNegativeInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return null;
  }
  return value;
}

function parseCategoryTotal(value: unknown): SentryCategoryTotal | null {
  if (!isRecord(value)) return null;
  if (typeof value.category !== "string" || value.category.trim() === "") return null;
  if (typeof value.label !== "string" || value.label.trim() === "") return null;
  const family =
    value.family === "Other" ||
    (SENTRY_USAGE_FAMILIES as readonly string[]).includes(String(value.family))
      ? (value.family as SentryCategoryTotal["family"])
      : null;
  if (!family) return null;
  if (
    value.unit !== "events" &&
    value.unit !== "bytes" &&
    value.unit !== "milliseconds"
  ) {
    return null;
  }
  const accepted = readNonNegativeInteger(value.accepted);
  const rateLimited = readNonNegativeInteger(value.rateLimited);
  const filtered = readNonNegativeInteger(value.filtered);
  const other = readNonNegativeInteger(value.other);
  const total = readNonNegativeInteger(value.total);
  if (
    accepted == null ||
    rateLimited == null ||
    filtered == null ||
    other == null ||
    total == null
  ) {
    return null;
  }
  return {
    category: value.category,
    label: value.label,
    family,
    unit: value.unit,
    accepted,
    rateLimited,
    filtered,
    other,
    total,
  };
}

export function parseSentryCategoriesFromRawData(
  rawData: unknown
): SentryUsageCategoriesView | null {
  if (!isRecord(rawData) || !isRecord(rawData.categories)) return null;
  const rows = rawData.categories.byCategory;
  if (!Array.isArray(rows)) return null;
  const byCategory: SentryCategoryTotal[] = [];
  for (const row of rows) {
    const parsed = parseCategoryTotal(row);
    if (!parsed) return null;
    byCategory.push(parsed);
  }
  return {
    byCategory,
    blocked: { ...SENTRY_USAGE_BLOCKED },
  };
}

export function sentryStatsBillingCost(rawData: unknown): false | null {
  if (!isRecord(rawData) || !isRecord(rawData.stats)) return null;
  if (!isRecord(rawData.stats.capabilities)) return null;
  return rawData.stats.capabilities.billingCost === false ? false : null;
}
