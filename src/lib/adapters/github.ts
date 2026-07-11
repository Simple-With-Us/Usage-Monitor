import {
  configurationError,
  errorResult,
  fetchJson,
  parseNumber,
  type UsageResult,
} from "./helpers";

interface GitHubUsageItem {
  product?: string;
  sku?: string;
  unitType?: string;
  quantity?: number;
  netQuantity?: number;
  netAmount?: number;
}

export async function fetchUsage(
  apiKey: string,
  config?: Record<string, unknown>
): Promise<UsageResult> {
  const org =
    ((config?.org ?? config?.orgSlug) as string | undefined)?.trim();
  if (!org) configurationError("org is required for GitHub billing usage");

  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const params = new URLSearchParams({
    year: String(now.getUTCFullYear()),
    month: String(now.getUTCMonth() + 1),
  });
  const response = await fetchJson(
    `https://api.github.com/organizations/${encodeURIComponent(org)}/settings/billing/usage?${params}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${apiKey}`,
        "X-GitHub-Api-Version": "2026-03-10",
        "User-Agent": "api-usage-monitor/1.0",
      },
    }
  );
  if (!response.ok) {
    return errorResult(response.status, {
      note: "GitHub enhanced billing requires organization Administration read permission",
    });
  }

  const data = (response.data ?? {}) as { usageItems?: GitHubUsageItem[] };
  const items = Array.isArray(data.usageItems) ? data.usageItems : [];
  let totalCost = 0;
  let foundCost = false;
  const byProduct = new Map<string, { quantity: number; netAmountUsd: number }>();
  for (const item of items) {
    const amount = parseNumber(item.netAmount);
    if (amount != null) {
      totalCost += amount;
      foundCost = true;
    }
    const key = [item.product ?? "unknown", item.sku ?? "unknown"].join(" / ");
    const aggregate = byProduct.get(key) ?? { quantity: 0, netAmountUsd: 0 };
    aggregate.quantity += parseNumber(item.netQuantity ?? item.quantity) ?? 0;
    aggregate.netAmountUsd += amount ?? 0;
    byProduct.set(key, aggregate);
  }
  const month = monthStart.toISOString().slice(0, 7);

  return {
    balance: null,
    totalCost: foundCost ? totalCost : null,
    totalRequests: null,
    credits: null,
    rawData: {
      organization: org,
      month,
      itemCount: items.length,
      byProduct: Object.fromEntries(byProduct),
      capabilities: {
        actualBilledUsage: true,
        enhancedBillingPlatformRequired: true,
        requiredPermission: "Organization Administration read",
      },
    },
    externalBilling: {
      source: "github-enhanced-billing",
      authoritative: true,
      records: [
        {
          externalId: `${org.toLowerCase()}:${month}`,
          kind: "billing_period",
          planName: "GitHub enhanced billing usage",
          status: "open",
          amountUsd: foundCost ? totalCost : null,
          currency: "USD",
          currentPeriodStart: monthStart.toISOString(),
          currentPeriodEnd: monthEnd.toISOString(),
        },
      ],
    },
  };
}
