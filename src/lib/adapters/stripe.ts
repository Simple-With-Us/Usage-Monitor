import {
  AdapterError,
  centsToDollars,
  errorResult,
  fetchJson,
  type UsageResult,
} from "./helpers";

const MAX_TRANSACTION_PAGES = 10_000;

interface StripeAmount {
  amount?: number;
  currency?: string;
}

interface StripeBalance {
  available?: StripeAmount[];
  pending?: StripeAmount[];
  livemode?: boolean;
}

interface StripeBalanceTransaction {
  id?: string;
  created?: number;
  currency?: string;
  fee?: number;
  type?: string;
  reporting_category?: string;
}

interface StripeTransactionPage {
  data?: StripeBalanceTransaction[];
  has_more?: boolean;
}

function invalidResponse(message: string): never {
  throw new AdapterError(`Stripe balance transactions: ${message}`, {
    code: "INVALID_RESPONSE",
  });
}

function usdTotal(rows: StripeAmount[] | undefined): number | null {
  const usd = (rows ?? []).filter((row) => row.currency === "usd");
  if (usd.length === 0) return null;
  return usd.reduce((sum, row) => sum + (row.amount ?? 0), 0) / 100;
}

export async function fetchUsage(apiKey: string): Promise<UsageResult> {
  const headers = {
    Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`,
  };
  const now = new Date();
  const monthStartSeconds = Math.floor(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000
  );

  const balanceResponse = await fetchJson("https://api.stripe.com/v1/balance", {
    headers,
  });

  let startingAfter: string | null = null;
  let pageCount = 0;
  const feeCentsByCurrency = new Map<string, number>();
  const feeTransactionsByCurrency = new Map<string, number>();
  const feeBreakdown = new Map<string, {
    currency: string;
    category: string;
    feeCents: number;
    transactions: number;
  }>();
  let feeTransactionCount = 0;
  let transactionCount = 0;
  const seenCursors = new Set<string>();

  while (true) {
    if (pageCount >= MAX_TRANSACTION_PAGES) {
      invalidResponse(
        `pagination exceeded the ${MAX_TRANSACTION_PAGES}-page safety limit`
      );
    }
    const params = new URLSearchParams({
      "created[gte]": String(monthStartSeconds),
      limit: "100",
    });
    if (startingAfter) params.set("starting_after", startingAfter);
    const response = await fetchJson(
      `https://api.stripe.com/v1/balance_transactions?${params}`,
      { headers }
    );
    if (!response.ok) {
      return errorResult(response.status, {
        note: "Stripe balance transactions require read access",
      });
    }

    if (!response.data || typeof response.data !== "object") {
      invalidResponse("expected a response object");
    }
    const page = response.data as StripeTransactionPage;
    if (!Array.isArray(page.data) || typeof page.has_more !== "boolean") {
      invalidResponse("expected data[] and boolean has_more fields");
    }
    const rows = page.data;
    transactionCount += rows.length;
    for (const transaction of rows) {
      if (!transaction || typeof transaction !== "object") {
        invalidResponse("transaction entry was not an object");
      }
      if (
        typeof transaction.id !== "string" || !transaction.id.trim() ||
        typeof transaction.currency !== "string" ||
        typeof transaction.fee !== "number" || !Number.isFinite(transaction.fee)
      ) {
        invalidResponse("transaction id, currency, or fee was missing or invalid");
      }
      const currency = transaction.currency.trim().toLowerCase();
      feeCentsByCurrency.set(
        currency,
        (feeCentsByCurrency.get(currency) ?? 0) + transaction.fee
      );
      feeTransactionsByCurrency.set(
        currency,
        (feeTransactionsByCurrency.get(currency) ?? 0) + 1
      );
      const category =
        transaction.reporting_category?.trim() ||
        transaction.type?.trim() ||
        "uncategorized";
      const breakdownKey = `${currency}\u0000${category}`;
      const currentBreakdown = feeBreakdown.get(breakdownKey) ?? {
        currency,
        category,
        feeCents: 0,
        transactions: 0,
      };
      currentBreakdown.feeCents += transaction.fee;
      currentBreakdown.transactions += 1;
      feeBreakdown.set(breakdownKey, currentBreakdown);
      if (transaction.fee !== 0) feeTransactionCount++;
    }
    pageCount++;

    if (!page.has_more) break;
    const lastId = rows.at(-1)?.id;
    const nextCursor = typeof lastId === "string" ? lastId.trim() : "";
    if (!nextCursor) {
      invalidResponse("has_more was true but the next cursor was missing");
    }
    if (seenCursors.has(nextCursor)) {
      invalidResponse(`pagination repeated cursor ${nextCursor}`);
    }
    seenCursors.add(nextCursor);
    startingAfter = nextCursor;
  }

  const balanceData = (balanceResponse.data ?? {}) as StripeBalance;
  const canonicalUsdAvailable =
    feeCentsByCurrency.has("usd") || transactionCount === 0;
  const canonicalUsdCents = canonicalUsdAvailable
    ? feeCentsByCurrency.get("usd") ?? 0
    : null;
  const month = new Date(monthStartSeconds * 1000).toISOString().slice(0, 7);
  const externalRecords = [];
  const canonicalCurrencyTotals =
    transactionCount === 0
      ? [["usd", 0] as const]
      : [...feeCentsByCurrency.entries()].sort(([left], [right]) => left.localeCompare(right));
  for (const [currency, cents] of canonicalCurrencyTotals) {
    externalRecords.push({
      externalId: `${month}:${currency}`,
      kind: "billing_period" as const,
      serviceName: "Stripe processing fees",
      planName: `${currency.toUpperCase()} canonical total`,
      status: "open",
      amountUsd: cents / 100,
      currency: currency.toUpperCase(),
      currentPeriodStart: new Date(monthStartSeconds * 1000).toISOString(),
      currentPeriodEnd: now.toISOString(),
      usageQuantity: feeTransactionsByCurrency.get(currency) ?? 0,
      usageUnit: "transactions",
      rollupRole: "canonical" as const,
      dateKind: "report_through" as const,
    });
  }
  if (feeBreakdown.size > 0) {
    for (const breakdown of [...feeBreakdown.values()].sort((left, right) =>
      left.currency.localeCompare(right.currency) ||
      left.category.localeCompare(right.category)
    )) {
      externalRecords.push({
        externalId: `${month}:${breakdown.currency}:${breakdown.category}`,
        kind: "billing_period" as const,
        serviceName: breakdown.category.replace(/[_-]+/g, " "),
        planName: "Stripe processing fee category",
        status: "open",
        amountUsd: breakdown.feeCents / 100,
        currency: breakdown.currency.toUpperCase(),
        currentPeriodStart: new Date(monthStartSeconds * 1000).toISOString(),
        currentPeriodEnd: now.toISOString(),
        usageQuantity: breakdown.transactions,
        usageUnit: "transactions",
        rollupRole: "component" as const,
        dateKind: "report_through" as const,
      });
    }
  }

  return {
    balance: balanceResponse.ok ? usdTotal(balanceData.available) : null,
    totalCost:
      canonicalUsdCents == null ? null : centsToDollars(canonicalUsdCents),
    costWindowStart:
      canonicalUsdCents == null ? null : new Date(monthStartSeconds * 1000),
    costWindowEnd: canonicalUsdCents == null ? null : now,
    costScope:
      canonicalUsdCents == null ? "unknown" : "calendar_month_to_date",
    totalRequests: null,
    credits: null,
    rawData: {
      balance: balanceResponse.ok
        ? {
            availableUsd: usdTotal(balanceData.available),
            pendingUsd: usdTotal(balanceData.pending),
            livemode: balanceData.livemode ?? null,
          }
        : null,
      fees: {
        monthStart: new Date(monthStartSeconds * 1000).toISOString(),
        totalUsd:
          canonicalUsdCents == null ? null : canonicalUsdCents / 100,
        byCurrency: Object.fromEntries(
          [...feeCentsByCurrency.entries()].sort().map(([currency, cents]) => [
            currency.toUpperCase(),
            {
              amount: cents / 100,
              transactions: feeTransactionsByCurrency.get(currency) ?? 0,
            },
          ])
        ),
        transactionCount,
        transactionsWithFees: feeTransactionCount,
        pages: pageCount,
      },
      capabilities: {
        actualProcessingFees: true,
        canonicalUsdCost: canonicalUsdAvailable,
        nonUsdFeesPreserved: feeCentsByCurrency.size > Number(feeCentsByCurrency.has("usd")),
        merchantBalance: balanceResponse.ok,
        stripeAccountSubscription: false,
        note: "Customer subscriptions are merchant revenue, not the Stripe account's own plan.",
      },
    },
    externalBilling: {
      source: "stripe-processing-fees",
      authoritative: true,
      records: externalRecords,
    },
  };
}
