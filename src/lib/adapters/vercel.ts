import {
  AdapterError,
  errorResult,
  fetchJson,
  parseNumber,
  type UsageResult,
} from "./helpers";

interface FocusCharge {
  BilledCost?: string | number;
  BillingCurrency?: string;
  ChargeCategory?: string;
  ChargePeriodStart?: string;
  ChargePeriodEnd?: string;
  ConsumedQuantity?: string | number | null;
  ConsumedUnit?: string | null;
  ServiceName?: string;
  ServiceCategory?: string;
}

function parseCharges(data: unknown): FocusCharge[] {
  if (Array.isArray(data)) return data as FocusCharge[];
  if (typeof data === "object" && data !== null) return [data as FocusCharge];
  if (typeof data !== "string") return [];

  const charges: FocusCharge[] = [];
  for (const line of data.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === "object") charges.push(parsed as FocusCharge);
    } catch (error) {
      throw new AdapterError("Vercel returned invalid FOCUS JSONL", {
        code: "INVALID_RESPONSE",
        cause: error,
      });
    }
  }
  return charges;
}

export async function fetchUsage(
  apiKey: string,
  config?: Record<string, unknown>
): Promise<UsageResult> {
  const teamId = (config?.teamId as string | undefined)?.trim();
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const params = new URLSearchParams({
    from: monthStart.toISOString(),
    to: now.toISOString(),
  });
  if (teamId) params.set("teamId", teamId);

  const response = await fetchJson(
    `https://api.vercel.com/v1/billing/charges?${params}`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
    { maxResponseBytes: 8 * 1024 * 1024 }
  );
  if (!response.ok) {
    return errorResult(response.status, {
      note: "Vercel FOCUS billing requires billing access on a Pro or Enterprise team",
    });
  }

  const charges = parseCharges(response.data);
  let totalCost = 0;
  let foundUsd = false;
  const byService = new Map<string, { billedCostUsd: number; quantity: number }>();
  for (const charge of charges) {
    const currency = (charge.BillingCurrency ?? "USD").toUpperCase();
    const amount = parseNumber(charge.BilledCost);
    if (currency === "USD" && amount != null) {
      totalCost += amount;
      foundUsd = true;
    }
    const key = charge.ServiceName ?? "unknown";
    const aggregate = byService.get(key) ?? { billedCostUsd: 0, quantity: 0 };
    if (currency === "USD") aggregate.billedCostUsd += amount ?? 0;
    aggregate.quantity += parseNumber(charge.ConsumedQuantity) ?? 0;
    byService.set(key, aggregate);
  }
  const month = monthStart.toISOString().slice(0, 7);
  const owner = teamId ?? "personal";

  return {
    balance: null,
    totalCost: foundUsd ? totalCost : null,
    totalRequests: null,
    credits: null,
    rawData: {
      owner,
      month,
      chargeCount: charges.length,
      byService: Object.fromEntries(byService),
      capabilities: {
        actualBilledCost: true,
        format: "FOCUS 1.3 JSONL",
        requiredAccess: "Vercel billing read (Pro or Enterprise)",
      },
    },
    externalBilling: {
      source: "vercel-focus-billing",
      authoritative: true,
      records: [
        {
          externalId: `${owner}:${month}`,
          kind: "billing_period",
          planName: "Vercel FOCUS charges",
          status: "open",
          amountUsd: foundUsd ? totalCost : null,
          currency: "USD",
          currentPeriodStart: monthStart.toISOString(),
          currentPeriodEnd: monthEnd.toISOString(),
        },
      ],
    },
  };
}
