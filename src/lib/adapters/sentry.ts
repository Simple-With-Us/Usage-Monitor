import {
  configurationError,
  errorResult,
  fetchJson,
  parseNumber,
  type UsageResult,
} from "./helpers";

export async function fetchUsage(
  apiKey: string,
  config?: Record<string, unknown>
): Promise<UsageResult> {
  const orgSlug = config?.orgSlug as string | undefined;

  if (!orgSlug) {
    configurationError("orgSlug is required in config");
  }

  const res = await fetchJson(
    `https://sentry.io/api/0/organizations/${orgSlug}/stats-summary/?field=sum(quantity)&statsPeriod=30d`,
    { headers: { Authorization: `Bearer ${apiKey}` } }
  );

  if (!res.ok) {
    return errorResult(res.status, { response: res.data });
  }

  const data = res.data as {
    projects?: Array<{
      stats?: Array<{
        totals?: Record<string, number>;
      }>;
    }>;
  };

  let totalRequests = 0;
  let found = false;

  for (const project of data.projects || []) {
    for (const stat of project.stats || []) {
      const quantity = parseNumber(stat.totals?.["sum(quantity)"]);
      if (quantity != null) {
        totalRequests += quantity;
        found = true;
      }
    }
  }

  return {
    balance: null,
    totalCost: null,
    totalRequests: found ? totalRequests : null,
    credits: null,
    rawData: data,
  };
}
