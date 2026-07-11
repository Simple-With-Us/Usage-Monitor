import {
  centsToDollars,
  errorResult,
  fetchJson,
  type UsageResult,
} from "./helpers";

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

  const transactions: StripeBalanceTransaction[] = [];
  let startingAfter: string | null = null;
  let pageCount = 0;
  let truncated = false;

  do {
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

    const page = (response.data ?? {}) as StripeTransactionPage;
    const rows = Array.isArray(page.data) ? page.data : [];
    transactions.push(...rows);
    startingAfter = page.has_more && rows.length > 0
      ? rows[rows.length - 1].id ?? null
      : null;
    pageCount++;
    if (startingAfter && pageCount >= 10) truncated = true;
  } while (startingAfter && pageCount < 10);

  if (!balanceResponse.ok && transactions.length === 0) {
    return errorResult(balanceResponse.status, {
      note: "Stripe balance and balance transactions were unavailable",
    });
  }

  const balanceData = (balanceResponse.data ?? {}) as StripeBalance;
  let feeCents = 0;
  let feeTransactionCount = 0;
  for (const transaction of transactions) {
    if (transaction.currency === "usd" && typeof transaction.fee === "number") {
      feeCents += transaction.fee;
      if (transaction.fee !== 0) feeTransactionCount++;
    }
  }

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
        transactionCount: transactions.length,
        transactionsWithFees: feeTransactionCount,
        pages: pageCount,
        truncated,
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
          status: truncated ? "partial" : "open",
          amountUsd: feeCents / 100,
          currency: "USD",
          currentPeriodStart: new Date(monthStartSeconds * 1000).toISOString(),
          currentPeriodEnd: now.toISOString(),
        },
      ],
    },
  };
}
