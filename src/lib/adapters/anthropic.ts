import {
  AdapterError,
  errorResult,
  fetchJson,
  parseNumber,
  type UsageResult,
} from "./helpers";

const MAX_COST_REPORT_PAGES = 10_000;

interface AnthropicCostResult {
  amount?: string | number;
  currency?: string;
  [key: string]: unknown;
}

interface AnthropicCostBucket {
  starting_at?: string;
  ending_at?: string;
  results?: AnthropicCostResult[];
}

interface AnthropicCostPage {
  data?: AnthropicCostBucket[];
  has_more?: boolean;
  next_page?: string | null;
}

function invalidResponse(message: string): never {
  throw new AdapterError(`Anthropic cost report: ${message}`, {
    code: "INVALID_RESPONSE",
  });
}

function monthWindow(now: Date): { startingAt: string; endingAt: string } {
  return {
    startingAt: new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
    ).toISOString(),
    endingAt: now.toISOString(),
  };
}

export async function fetchUsage(
  apiKey: string,
  config?: Record<string, unknown>
): Promise<UsageResult> {
  // The Usage & Cost API requires an Admin API key (sk-ant-admin01-*), not a
  // standard Messages API key. Keep an optional secondary key in encrypted
  // provider config so existing inference credentials need not be replaced.
  const adminApiKey =
    (config?.adminApiKey as string | undefined)?.trim() || apiKey;
  const { startingAt, endingAt } = monthWindow(new Date());
  const headers = {
    "x-api-key": adminApiKey,
    "anthropic-version": "2023-06-01",
    "User-Agent": "api-usage-monitor/1.0",
  };

  const buckets: AnthropicCostBucket[] = [];
  let page: string | null = null;
  let pageCount = 0;
  const seenPages = new Set<string>();

  while (true) {
    if (pageCount >= MAX_COST_REPORT_PAGES) {
      invalidResponse(
        `pagination exceeded the ${MAX_COST_REPORT_PAGES}-page safety limit`
      );
    }
    const params = new URLSearchParams({
      starting_at: startingAt,
      ending_at: endingAt,
      limit: "31",
    });
    if (page) params.set("page", page);

    const response = await fetchJson(
      `https://api.anthropic.com/v1/organizations/cost_report?${params}`,
      { headers }
    );
    if (!response.ok) {
      return errorResult(response.status, {
        note: "Anthropic Usage & Cost API requires an organization Admin API key",
      });
    }

    if (!response.data || typeof response.data !== "object") {
      invalidResponse("expected a response object");
    }
    const data = response.data as AnthropicCostPage;
    if (!Array.isArray(data.data) || typeof data.has_more !== "boolean") {
      invalidResponse("expected data[] and boolean has_more fields");
    }
    buckets.push(...data.data);
    pageCount++;

    if (!data.has_more) break;
    const nextPage = typeof data.next_page === "string"
      ? data.next_page.trim()
      : "";
    if (!nextPage) {
      invalidResponse("has_more was true but next_page was missing");
    }
    if (seenPages.has(nextPage)) {
      invalidResponse(`pagination repeated cursor ${nextPage}`);
    }
    seenPages.add(nextPage);
    page = nextPage;
  }

  let totalCents = 0;
  let foundUsd = false;
  for (const bucket of buckets) {
    for (const result of bucket.results ?? []) {
      if ((result.currency ?? "USD").toUpperCase() !== "USD") continue;
      const amount = parseNumber(result.amount);
      if (amount != null) {
        totalCents += amount;
        foundUsd = true;
      }
    }
  }

  return {
    balance: null,
    totalCost: foundUsd ? totalCents / 100 : null,
    totalRequests: null,
    credits: null,
    rawData: {
      costReport: {
        bucketCount: buckets.length,
        totalUsd: foundUsd ? totalCents / 100 : null,
      },
      reportingWindow: { startingAt, endingAt },
      capabilities: {
        actualCost: true,
        usageReport: true,
        subscriptionStatus: false,
        credential: "Anthropic organization Admin API key",
      },
    },
    externalBilling: {
      source: "anthropic-cost-report",
      authoritative: true,
      records: [
        {
          externalId: startingAt.slice(0, 7),
          kind: "billing_period",
          status: "open",
          amountUsd: foundUsd ? totalCents / 100 : null,
          currency: "USD",
          currentPeriodStart: startingAt,
          currentPeriodEnd: endingAt,
        },
      ],
    },
  };
}
