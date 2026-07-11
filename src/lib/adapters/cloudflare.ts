import {
  configurationError,
  errorResult,
  fetchJson,
  parseNumber,
  type AdapterExternalBillingSync,
  type UsageResult,
  type AdapterExternalBillingRecord,
} from "./helpers";

interface AnalyticsDashboardResponse {
  result?: {
    totals?: {
      requests?: number;
      bandwidth?: number;
    };
  };
}

function makeHeaders(
  apiKey: string,
  accountEmail?: string
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (accountEmail) {
    headers["X-Auth-Email"] = accountEmail;
    headers["X-Auth-Key"] = apiKey;
  } else {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

export async function fetchUsage(
  apiKey: string,
  config?: Record<string, unknown>
): Promise<UsageResult> {
  const accountId = config?.accountId as string | undefined;

  if (!accountId) {
    configurationError("accountId is required in config");
  }

  const accountEmail = config?.accountEmail as string | undefined;
  const headers = makeHeaders(apiKey, accountEmail);
  const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
  const rawData: Record<string, unknown> = {};

  let totalRequests: number | null = null;
  let totalCost: number | null = null;
  let successfulCalls = 0;
  const billingSyncs: AdapterExternalBillingSync[] = [];
  const failedStatuses: number[] = [];

  // 1. Analytics dashboard (general stats)
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const analyticsParams = new URLSearchParams({
    since: thirtyDaysAgo.toISOString(),
    until: now.toISOString(),
    continuous: "true",
  });

  try {
    const analyticsRes = await fetchJson(
      `${baseUrl}/analytics/dashboard?${analyticsParams}`,
      { headers }
    );
    if (analyticsRes.ok) {
      const analytics = analyticsRes.data as AnalyticsDashboardResponse;
      rawData.analytics = analytics;
      successfulCalls++;
      if (analytics.result?.totals?.requests != null) {
        totalRequests = analytics.result.totals.requests;
      }
      if (analytics.result?.totals?.bandwidth != null) {
        rawData.totalBandwidth_bytes = analytics.result.totals.bandwidth;
      }
    } else {
      failedStatuses.push(analyticsRes.status);
      rawData.analyticsError = `HTTP ${analyticsRes.status}`;
    }
  } catch (err) {
    rawData.analyticsError = err instanceof Error ? err.message : "Failed";
  }

  // 2. Workers analytics
  try {
    const workersRes = await fetchJson(
      `${baseUrl}/workers/analytics/dashboard?${analyticsParams}`,
      { headers }
    );
    if (workersRes.ok) {
      const workersData = workersRes.data as AnalyticsDashboardResponse;
      rawData.workers = workersData;
      successfulCalls++;
      if (workersData.result?.totals?.requests != null) {
        totalRequests =
          (totalRequests ?? 0) + workersData.result.totals.requests;
      }
    } else {
      failedStatuses.push(workersRes.status);
      rawData.workersError = `HTTP ${workersRes.status}`;
    }
  } catch (err) {
    rawData.workersError = err instanceof Error ? err.message : "Failed";
  }

  // 3. Fixed subscriptions and renewal/status metadata. Billing Read is the
  // least-privilege Cloudflare token permission for this endpoint. Usage
  // overages are intentionally not inferred from analytics (Cloudflare states
  // that analytics datasets are not billing-grade).
  try {
    const subscriptionsRes = await fetchJson(`${baseUrl}/subscriptions`, {
      headers,
    });
    if (subscriptionsRes.ok) {
      successfulCalls++;
      const subscriptions = subscriptionsRes.data as {
        result?: Array<{
          id?: string;
          currency?: string;
          current_period_start?: string;
          current_period_end?: string;
          frequency?: string;
          price?: number;
          rate_plan?: { id?: string; public_name?: string };
          state?: string;
        }>;
      };
      const rows = Array.isArray(subscriptions.result)
        ? subscriptions.result
        : [];
      rawData.subscriptions = rows;

      const nowMs = now.getTime();
      const monthStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
      let billedThisMonthUsd = 0;
      let foundBilledSubscription = false;
      const billingRecords: AdapterExternalBillingRecord[] = [];
      for (const subscription of rows) {
        const price = parseNumber(subscription.price);
        const periodStart = subscription.current_period_start
          ? Date.parse(subscription.current_period_start)
          : Number.NaN;
        const isLive = !["Cancelled", "Failed", "Expired"].includes(
          subscription.state ?? ""
        );
        if (
          price != null &&
          (subscription.currency ?? "USD").toUpperCase() === "USD" &&
          isLive &&
          periodStart >= monthStartMs &&
          periodStart <= nowMs
        ) {
          billedThisMonthUsd += price;
          foundBilledSubscription = true;
        }
        if (subscription.id) {
          const normalizedState = (subscription.state ?? "unknown")
            .trim()
            .toLowerCase();
          billingRecords.push({
            externalId: subscription.id,
            kind: "subscription",
            planName:
              subscription.rate_plan?.public_name ??
              subscription.rate_plan?.id ??
              null,
            status: normalizedState || "unknown",
            amountUsd:
              price != null &&
              (subscription.currency ?? "USD").toUpperCase() === "USD"
                ? price
                : null,
            currency: subscription.currency ?? "USD",
            billingInterval: subscription.frequency ?? null,
            currentPeriodStart: subscription.current_period_start ?? null,
            currentPeriodEnd: subscription.current_period_end ?? null,
            nextRenewalAt: isLive
              ? subscription.current_period_end ?? null
              : null,
          });
        }
      }
      billingSyncs.push({
        source: "cloudflare-subscriptions",
        authoritative: true,
        records: billingRecords,
      });
      if (foundBilledSubscription) totalCost = billedThisMonthUsd;
      rawData.billing = {
        fixedSubscriptionBilledThisMonthUsd:
          foundBilledSubscription ? billedThisMonthUsd : null,
        subscriptionCount: rows.length,
        capabilities: {
          fixedSubscriptionPrice: true,
          subscriptionStatus: true,
          renewalDate: true,
          usageOverageCost: false,
        },
      };
    } else {
      failedStatuses.push(subscriptionsRes.status);
      rawData.subscriptionsCapability = {
        available: false,
        status: subscriptionsRes.status,
        requiredPermission: "Account Billing Read",
      };
    }
  } catch (error) {
    rawData.subscriptionsCapability = {
      available: false,
      error: error instanceof Error ? error.message : "Failed",
      requiredPermission: "Account Billing Read",
    };
  }

  // 4. PayGo billable usage is Cloudflare's billing-grade alpha endpoint.
  // It is restricted to select self-serve accounts; a 403/404 is a capability
  // miss, not a reason to discard otherwise valid subscription/analytics data.
  try {
    const paygoResponse = await fetchJson(`${baseUrl}/paygo-usage`, { headers });
    if (paygoResponse.ok) {
      successfulCalls++;
      const paygo = (paygoResponse.data ?? {}) as {
        result?: Array<{
          BillingCurrency?: string;
          BillingPeriodStart?: string;
          ChargePeriodEnd?: string;
          ConsumedQuantity?: number;
          ConsumedUnit?: string;
          ContractedCost?: number;
          ServiceName?: string;
        }>;
      };
      const rows = Array.isArray(paygo.result) ? paygo.result : [];
      let paygoCostUsd = 0;
      let foundPaygoCost = false;
      const byService = new Map<string, { contractedCostUsd: number; quantity: number }>();
      for (const row of rows) {
        const cost = parseNumber(row.ContractedCost);
        const currency = (row.BillingCurrency ?? "USD").toUpperCase();
        if (currency === "USD" && cost != null) {
          paygoCostUsd += cost;
          foundPaygoCost = true;
        }
        const key = row.ServiceName ?? "unknown";
        const aggregate = byService.get(key) ?? { contractedCostUsd: 0, quantity: 0 };
        if (currency === "USD") aggregate.contractedCostUsd += cost ?? 0;
        aggregate.quantity += parseNumber(row.ConsumedQuantity) ?? 0;
        byService.set(key, aggregate);
      }
      if (foundPaygoCost) totalCost = (totalCost ?? 0) + paygoCostUsd;
      const periodStart = rows[0]?.BillingPeriodStart ??
        new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
      const periodEnd = rows.reduce<string | null>((latest, row) => {
        if (!row.ChargePeriodEnd) return latest;
        return latest == null || row.ChargePeriodEnd > latest
          ? row.ChargePeriodEnd
          : latest;
      }, null) ?? now.toISOString();
      rawData.paygoBilling = {
        currentPeriodCostUsd: foundPaygoCost ? paygoCostUsd : null,
        recordCount: rows.length,
        byService: Object.fromEntries(byService),
        alpha: true,
      };
      billingSyncs.push({
        source: "cloudflare-paygo-usage",
        authoritative: true,
        records: [
          {
            externalId: `${accountId}:${periodStart.slice(0, 7)}`,
            kind: "billing_period",
            planName: "Cloudflare PayGo billable usage",
            status: "open",
            amountUsd: foundPaygoCost ? paygoCostUsd : null,
            currency: "USD",
            currentPeriodStart: periodStart,
            currentPeriodEnd: periodEnd,
          },
        ],
      });
    } else {
      rawData.paygoBillingCapability = {
        available: false,
        status: paygoResponse.status,
        note: "Alpha endpoint is restricted to select PayGo accounts",
      };
    }
  } catch (error) {
    rawData.paygoBillingCapability = {
      available: false,
      error: error instanceof Error ? error.message : "Failed",
    };
  }

  // 5. D1 database metrics
  const databaseId = config?.databaseId as string | undefined;
  if (databaseId) {
    try {
      const d1Res = await fetchJson(`${baseUrl}/d1/database/${databaseId}`, {
        headers,
      });
      if (d1Res.ok) {
        successfulCalls++;
        rawData.d1 = d1Res.data;
      }
    } catch {
      // best effort
    }
  }

  // 6. R2 storage bytes
  const r2BucketName = config?.r2BucketName as string | undefined;
  if (r2BucketName) {
    try {
      const r2Res = await fetchJson(
        `${baseUrl}/r2/buckets/${r2BucketName}`,
        { headers }
      );
      if (r2Res.ok) {
        successfulCalls++;
        rawData.r2 = r2Res.data;
      }
    } catch {
      // best effort
    }
  }

  // 7. KV namespace
  const kvNamespaceId = config?.kvNamespaceId as string | undefined;
  if (kvNamespaceId) {
    try {
      const kvRes = await fetchJson(
        `${baseUrl}/storage/kv/namespaces/${kvNamespaceId}`,
        { headers }
      );
      if (kvRes.ok) {
        successfulCalls++;
        rawData.kv = kvRes.data;
      }
    } catch {
      // best effort
    }
  }

  // 8. Queue message counts
  const queueId = config?.queueId as string | undefined;
  if (queueId) {
    try {
      const queueRes = await fetchJson(`${baseUrl}/queues/${queueId}`, {
        headers,
      });
      if (queueRes.ok) {
        successfulCalls++;
        rawData.queue = queueRes.data;
      }
    } catch {
      // best effort
    }
  }

  if (successfulCalls === 0) {
    return errorResult(failedStatuses[0] ?? 502, {
      note: "No Cloudflare account usage or billing capability was readable",
    });
  }

  return {
    balance: null,
    totalCost,
    totalRequests,
    credits: null,
    rawData,
    externalBillingSyncs: billingSyncs.length > 0 ? billingSyncs : undefined,
  };
}
