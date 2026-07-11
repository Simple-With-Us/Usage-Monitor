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
  let feeCents = 0;
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
      if (transaction.currency === "usd" && typeof transaction.fee === "number") {
        feeCents += transaction.fee;
        if (transaction.fee !== 0) feeTransactionCount++;
      }
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

  return {
    balance: balanceResponse.ok ? usdTotal(balanceData.available) : null,
    totalCost: centsToDollars(feeCents),
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
        totalUsd: feeCents / 100,
        transactionCount,
        transactionsWithFees: feeTransactionCount,
        pages: pageCount,
      },
      capabilities: {
        actualProcessingFees: true,
        merchantBalance: balanceResponse.ok,
        stripeAccountSubscription: false,
        note: "Customer subscriptions are merchant revenue, not the Stripe account's own plan.",
      },
    },
    externalBilling: {
      source: "stripe-processing-fees",
      authoritative: true,
      records: [
        {
          externalId: new Date(monthStartSeconds * 1000)
            .toISOString()
            .slice(0, 7),
          kind: "billing_period",
          planName: "Stripe processing fees",
          status: "open",
          amountUsd: feeCents / 100,
          currency: "USD",
          currentPeriodStart: new Date(monthStartSeconds * 1000).toISOString(),
          currentPeriodEnd: now.toISOString(),
        },
      ],
    },
  };
}
