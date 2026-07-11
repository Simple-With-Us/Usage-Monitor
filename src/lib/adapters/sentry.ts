import {
  configurationError,
  errorResult,
  fetchJson,
  parseNumber,
  type UsageResult,
} from "./helpers";

const EVENT_COUNT_CATEGORIES = new Set([
  "error",
  "transaction",
  "replay",
  "profile",
  "profile_chunk",
  "profile_chunk_ui",
  "monitor",
]);

const INCOMPATIBLE_QUANTITY_UNITS: Record<string, string> = {
  attachment: "bytes",
  profile_duration: "milliseconds",
  profile_duration_ui: "milliseconds",
};

export async function fetchUsage(
  apiKey: string,
  config?: Record<string, unknown>
): Promise<UsageResult> {
  const orgSlug = config?.orgSlug as string | undefined;

  if (!orgSlug) {
    configurationError("orgSlug is required in config");
  }

  const res = await fetchJson(
    `https://sentry.io/api/0/organizations/${orgSlug}/stats_v2/?field=sum(quantity)&groupBy=category&project=-1&statsPeriod=30d`,
    { headers: { Authorization: `Bearer ${apiKey}` } }
  );

  if (!res.ok) {
    return errorResult(res.status, { response: res.data });
  }

  const data = res.data as {
    start?: string;
    end?: string;
    groups?: Array<{
      by?: { category?: string };
      totals?: Record<string, number>;
    }>;
  };

  if (!Array.isArray(data.groups)) {
    return errorResult(502, { note: "Sentry stats response omitted groups[]" });
  }

  let totalEvents = 0;
  let foundEventCount = false;
  const categories: Record<string, { quantity: number; unit: string; included: boolean }> = {};

  for (const group of data.groups) {
    const category = group.by?.category?.trim();
    const quantity = parseNumber(group.totals?.["sum(quantity)"]);
    if (!category || quantity == null) continue;

    const included = EVENT_COUNT_CATEGORIES.has(category);
    const unit = INCOMPATIBLE_QUANTITY_UNITS[category] ?? "events";
    categories[category] = { quantity, unit, included };
    if (included) {
      totalEvents += quantity;
      foundEventCount = true;
    }
  }

  return {
    balance: null,
    totalCost: null,
    totalRequests: foundEventCount ? totalEvents : null,
    credits: null,
    rawData: {
      period: { start: data.start ?? null, end: data.end ?? null },
      categories,
      note: "Only event-count categories are aggregated; attachment bytes and profile-duration milliseconds remain separate.",
    },
  };
}
