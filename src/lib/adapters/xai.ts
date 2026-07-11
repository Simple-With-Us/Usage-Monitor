import {
  configurationError,
  errorResult,
  fetchJson,
  parseNumber,
  type AdapterExternalBillingRecord,
  type UsageResult,
} from "./helpers";

interface MoneyCents {
  val?: string | number;
}

function cents(value: unknown): number | null {
  const parsed = parseNumber(value);
  return parsed == null ? null : parsed / 100;
}

function billingWindow(cycle: { year?: number; month?: number } | undefined) {
  if (!cycle || !Number.isInteger(cycle.year) || !Number.isInteger(cycle.month)) {
    return null;
  }
  const start = new Date(Date.UTC(cycle.year!, cycle.month! - 1, 1));
  const end = new Date(Date.UTC(cycle.year!, cycle.month!, 1));
  return {
    id: `${cycle.year}-${String(cycle.month).padStart(2, "0")}`,
    start: start.toISOString(),
    end: end.toISOString(),
  };
}

export async function fetchUsage(
  apiKey: string,
  config?: Record<string, unknown>
): Promise<UsageResult> {
  const managementKey =
    (config?.managementKey as string | undefined)?.trim() || apiKey;
  const teamId = (config?.teamId as string | undefined)?.trim();
  if (!teamId) {
    configurationError("teamId is required in config for xAI billing tracking");
  }

  const headers = { Authorization: `Bearer ${managementKey}` };
  const base = `https://management-api.x.ai/v1/billing/teams/${encodeURIComponent(teamId)}`;
  const [balanceResponse, invoiceResponse, limitsResponse] = await Promise.all([
    fetchJson(`${base}/prepaid/balance`, { headers }),
    fetchJson(`${base}/postpaid/invoice/preview`, { headers }),
    fetchJson(`${base}/postpaid/spending-limits`, { headers }),
  ]);

  const successful = [balanceResponse, invoiceResponse, limitsResponse].filter(
    (response) => response.ok
  ).length;
  if (successful === 0) {
    return errorResult(
      balanceResponse.status || invoiceResponse.status || limitsResponse.status,
      { note: "xAI billing endpoints require a Management API key" }
    );
  }

  const balanceData = (balanceResponse.data ?? {}) as {
    total?: MoneyCents;
    changes?: unknown[];
  };
  const invoiceData = (invoiceResponse.data ?? {}) as {
    coreInvoice?: { totalWithCorr?: MoneyCents };
    effectiveSpendingLimit?: string | number;
    billingCycle?: { year?: number; month?: number };
  };
  const limitsData = (limitsResponse.data ?? {}) as {
    spendingLimits?: {
      effectiveSl?: MoneyCents;
      effectiveHardSl?: MoneyCents;
      softSl?: MoneyCents;
    };
  };

  const balanceCents = parseNumber(balanceData.total?.val);
  const balance = balanceResponse.ok && balanceCents != null
    ? Math.abs(balanceCents) / 100
    : null;
  const previewCost = invoiceResponse.ok
    ? cents(invoiceData.coreInvoice?.totalWithCorr?.val)
    : null;
  const totalCost = previewCost == null ? null : Math.max(0, previewCost);
  const spendLimitUsd =
    cents(limitsData.spendingLimits?.effectiveSl?.val) ??
    cents(limitsData.spendingLimits?.softSl?.val) ??
    cents(invoiceData.effectiveSpendingLimit);
  const window = billingWindow(invoiceData.billingCycle);

  const records: AdapterExternalBillingRecord[] = [
    {
      externalId: teamId,
      kind: "account",
      planName: "xAI API billing account",
      status: "active",
      spendLimitUsd,
      spendLimitWindow: "month",
    },
  ];
  if (window && invoiceResponse.ok) {
    records.push({
      externalId: `${teamId}:${window.id}`,
      kind: "invoice",
      planName: "xAI postpaid invoice preview",
      status: "open",
      amountUsd: totalCost,
      currency: "USD",
      currentPeriodStart: window.start,
      currentPeriodEnd: window.end,
      nextRenewalAt: window.end,
      spendLimitUsd,
      spendLimitWindow: "month",
    });
  }

  return {
    balance,
    totalCost,
    totalRequests: null,
    credits: balance,
    rawData: {
      prepaid: balanceResponse.ok
        ? { balanceUsd: balance, changeCount: balanceData.changes?.length ?? 0 }
        : { available: false, status: balanceResponse.status },
      postpaid: invoiceResponse.ok
        ? {
            invoicePreviewUsd: totalCost,
            effectiveSpendingLimitUsd: spendLimitUsd,
            billingCycle: invoiceData.billingCycle ?? null,
          }
        : { available: false, status: invoiceResponse.status },
      spendingLimits: limitsResponse.ok
        ? {
            effectiveUsd: spendLimitUsd,
            hardUsd: cents(limitsData.spendingLimits?.effectiveHardSl?.val),
          }
        : { available: false, status: limitsResponse.status },
      capabilities: {
        prepaidBalance: balanceResponse.ok,
        postpaidInvoicePreview: invoiceResponse.ok,
        spendingLimits: limitsResponse.ok,
        credential: "xAI Management API key",
      },
    },
    externalBilling: {
      source: "xai-billing",
      authoritative: true,
      records,
    },
  };
}
