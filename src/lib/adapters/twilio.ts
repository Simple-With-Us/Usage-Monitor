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
  const accountSid = (config?.accountId as string | undefined)?.trim();

  if (!accountSid) {
    configurationError("accountId (Account SID) is required in config");
  }

  // Restricted API keys authenticate with their API Key SID as the Basic
  // username while the Account SID remains the REST resource path.
  const authUsername =
    (config?.apiKeySid as string | undefined)?.trim() ||
    (config?.authUsername as string | undefined)?.trim() ||
    accountSid;
  const auth = Buffer.from(`${authUsername}:${apiKey}`).toString("base64");
  const headers = { Authorization: `Basic ${auth}` };
  const [balanceResponse, usageResponse] = await Promise.all([
    fetchJson(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Balance.json`,
      { headers }
    ),
    fetchJson(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Usage/Records/ThisMonth.json?Category=totalprice`,
      { headers }
    ),
  ]);

  if (!balanceResponse.ok && !usageResponse.ok) {
    return errorResult(usageResponse.status || balanceResponse.status, {
      note: "Twilio balance and Usage Records were both unavailable",
    });
  }

  const balanceData = balanceResponse.data as {
    balance?: string;
    currency?: string;
  };
  const usageData = usageResponse.data as {
    usage_records?: Array<{
      category?: string;
      count?: string;
      price?: number | string;
      price_unit?: string;
      start_date?: string;
      end_date?: string;
    }>;
  };
  const balanceCurrency = balanceData.currency?.trim().toUpperCase() ?? null;
  const balance = balanceResponse.ok && balanceCurrency === "USD"
    ? parseNumber(balanceData.balance)
    : null;
  const totalPrice = usageResponse.ok
    ? usageData.usage_records?.find((row) => row.category === "totalprice")
    : undefined;
  const parsedPrice = parseNumber(totalPrice?.price);
  const totalCost =
    parsedPrice != null &&
    (totalPrice?.price_unit ?? "usd").toLowerCase() === "usd"
      ? Math.abs(parsedPrice)
      : null;

  return {
    balance,
    totalCost,
    costWindowStart: totalCost != null ? totalPrice?.start_date ?? null : null,
    costWindowEnd: totalCost != null ? totalPrice?.end_date ?? null : null,
    costScope: totalCost != null ? "calendar_month_to_date" : "unknown",
    costIncludesUnknownFixed: totalCost != null,
    totalRequests: null,
    credits: null,
    rawData: {
      balance: balanceResponse.ok
        ? {
            amount: parseNumber(balanceData.balance),
            currency: balanceCurrency,
            normalizedAsUsd: balanceCurrency === "USD",
          }
        : null,
      usage: usageResponse.ok
        ? {
            category: totalPrice?.category ?? null,
            count: totalPrice?.count ?? null,
            price: totalPrice?.price ?? null,
            priceUnit: totalPrice?.price_unit ?? null,
            startDate: totalPrice?.start_date ?? null,
            endDate: totalPrice?.end_date ?? null,
          }
        : null,
      capabilities: {
        actualCost: usageResponse.ok,
        accountBalance: balanceResponse.ok,
        billingPeriod: usageResponse.ok,
        requiredRestrictedKeyPermission: "/twilio/billing/usage/read",
        authMode: authUsername === accountSid ? "account-auth-token" : "api-key",
      },
    },
    externalBilling: totalPrice
      ? {
          source: "twilio-usage-records",
          authoritative: true,
          records: [
            {
              externalId:
                totalPrice.start_date?.slice(0, 7) ?? "current-month",
              kind: "billing_period",
              status: "open",
              amountUsd: totalCost,
              currency: totalPrice.price_unit ?? "USD",
              currentPeriodStart: totalPrice.start_date ?? null,
              currentPeriodEnd: totalPrice.end_date ?? null,
            },
          ],
        }
      : undefined,
  };
}
