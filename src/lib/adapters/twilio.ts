import {
  AdapterError,
  configurationError,
  errorResult,
  fetchJson,
  parseNumber,
  type UsageResult,
} from "./helpers";

interface TwilioUsageRecord {
  category?: string;
  count?: string;
  count_unit?: string;
  usage?: string;
  usage_unit?: string;
  price?: number | string;
  price_unit?: string;
  start_date?: string;
  end_date?: string;
}

const MAX_USAGE_PAGES = 100;

async function fetchUsageBreakdown(
  accountSid: string,
  headers: Record<string, string>
): Promise<{ records: TwilioUsageRecord[]; pages: number } | null> {
  const expectedPath = `/2010-04-01/Accounts/${accountSid}/Usage/Records/ThisMonth.json`;
  let url = `https://api.twilio.com${expectedPath}?PageSize=1000`;
  const records: TwilioUsageRecord[] = [];

  for (let page = 1; page <= MAX_USAGE_PAGES; page += 1) {
    const response = await fetchJson(url, { headers });
    if (!response.ok) return null;
    if (!response.data || typeof response.data !== "object") {
      throw new AdapterError("Twilio Usage Records returned an invalid response", {
        code: "INVALID_RESPONSE",
      });
    }
    const data = response.data as {
      usage_records?: TwilioUsageRecord[];
      next_page_uri?: string | null;
    };
    if (!Array.isArray(data.usage_records)) {
      throw new AdapterError("Twilio Usage Records omitted usage_records[]", {
        code: "INVALID_RESPONSE",
      });
    }
    records.push(...data.usage_records);
    if (!data.next_page_uri) return { records, pages: page };

    const next = new URL(data.next_page_uri, "https://api.twilio.com");
    if (next.origin !== "https://api.twilio.com" || next.pathname !== expectedPath) {
      throw new AdapterError("Twilio Usage Records returned an unsafe pagination URL", {
        code: "INVALID_RESPONSE",
      });
    }
    url = next.toString();
  }

  throw new AdapterError("Twilio Usage Records exceeded the pagination limit", {
    code: "INVALID_RESPONSE",
  });
}

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
  const [balanceResponse, usageResponse, usageBreakdown] = await Promise.all([
    fetchJson(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Balance.json`,
      { headers }
    ),
    fetchJson(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Usage/Records/ThisMonth.json?Category=totalprice`,
      { headers }
    ),
    fetchUsageBreakdown(accountSid, headers),
  ]);

  if (!balanceResponse.ok && !usageResponse.ok && !usageBreakdown) {
    return errorResult(usageResponse.status || balanceResponse.status, {
      note: "Twilio balance and Usage Records were both unavailable",
    });
  }

  const balanceData = balanceResponse.data as {
    balance?: string;
    currency?: string;
  };
  const usageData = usageResponse.data as { usage_records?: TwilioUsageRecord[] };
  const balance = balanceResponse.ok ? parseNumber(balanceData.balance) : null;
  const totalPrice = usageResponse.ok
    ? usageData.usage_records?.find((row) => row.category === "totalprice")
    : usageBreakdown?.records.find((row) => row.category === "totalprice");
  const parsedPrice = parseNumber(totalPrice?.price);
  const totalPriceCurrency = totalPrice?.price_unit?.trim().toUpperCase() || null;
  const totalCost =
    parsedPrice != null &&
    totalPriceCurrency === "USD"
      ? Math.abs(parsedPrice)
      : null;
  const detailRecords = (usageBreakdown?.records ?? [])
    .filter((row) => row.category && row.category !== "totalprice")
    .map((row) => ({
      externalId: `${totalPrice?.start_date?.slice(0, 7) ?? "current-month"}:${row.category}`,
      kind: "billing_period" as const,
      serviceName: row.category!.replace(/[_-]+/g, " "),
      planName: "Twilio usage category",
      status: "open",
      amountUsd: (() => {
        const price = parseNumber(row.price);
        return price == null || !row.price_unit?.trim() ? null : Math.abs(price);
      })(),
      currency: row.price_unit?.toUpperCase() ?? null,
      currentPeriodStart: row.start_date ?? null,
      currentPeriodEnd: row.end_date ?? null,
      usageQuantity: parseNumber(row.usage) ?? parseNumber(row.count),
      usageUnit: row.usage_unit ?? row.count_unit ?? null,
      rollupRole: "component" as const,
      dateKind: "report_through" as const,
    }));
  const canonicalRecord = totalPrice
    ? [{
        externalId: totalPrice.start_date?.slice(0, 7) ?? "current-month",
        kind: "billing_period" as const,
        serviceName: "Twilio",
        planName: "Canonical ThisMonth total price",
        status: "open",
        amountUsd:
          parsedPrice == null || totalPriceCurrency == null
            ? null
            : Math.abs(parsedPrice),
        currency: totalPriceCurrency,
        currentPeriodStart: totalPrice.start_date ?? null,
        currentPeriodEnd: totalPrice.end_date ?? null,
        rollupRole: "canonical" as const,
        dateKind: "report_through" as const,
      }]
    : [];

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
        ? { balance: balanceData.balance ?? null, currency: balanceData.currency ?? null }
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
      usageBreakdown: usageBreakdown
        ? {
            pages: usageBreakdown.pages,
            categories: usageBreakdown.records.map((row) => ({
              category: row.category ?? null,
              count: row.count ?? null,
              countUnit: row.count_unit ?? null,
              usage: row.usage ?? null,
              usageUnit: row.usage_unit ?? null,
              price: row.price ?? null,
              priceUnit: row.price_unit ?? null,
              startDate: row.start_date ?? null,
              endDate: row.end_date ?? null,
            })),
          }
        : null,
      capabilities: {
        actualCost: totalCost != null,
        accountBalance: balanceResponse.ok,
        billingPeriod: usageResponse.ok,
        productBreakdown: usageBreakdown != null,
        requiredRestrictedKeyPermission: "/twilio/billing/usage/read",
        authMode: authUsername === accountSid ? "account-auth-token" : "api-key",
      },
    },
    externalBilling: canonicalRecord.length > 0 || detailRecords.length > 0
      ? {
          source: "twilio-usage-records",
          authoritative: usageBreakdown != null,
          records: [...canonicalRecord, ...detailRecords],
        }
      : undefined,
  };
}
