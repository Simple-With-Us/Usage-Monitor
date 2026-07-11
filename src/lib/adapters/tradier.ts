import {
  configurationError,
  errorResult,
  fetchJson,
  headerNumber,
  parseNumber,
  type UsageResult,
} from "./helpers";

export async function fetchUsage(
  apiKey: string,
  config?: Record<string, unknown>
): Promise<UsageResult> {
  const accountId = config?.accountId as string | undefined;

  if (!accountId) {
    const profileRes = await fetchJson("https://api.tradier.com/v1/user/profile", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    });

    if (!profileRes.ok) {
      return errorResult(profileRes.status, { profile: profileRes.data });
    }

    const profile = profileRes.data as {
      profile?: { account?: { account_number?: string } | Array<{ account_number?: string }> };
    };

    const account = profile.profile?.account;
    const firstAccount = Array.isArray(account) ? account[0] : account;
    const resolvedAccountId = firstAccount?.account_number;

    if (!resolvedAccountId) {
      configurationError("accountId is required when the Tradier profile has no account");
    }

    return fetchAccountBalance(apiKey, resolvedAccountId, true);
  }

  return fetchAccountBalance(apiKey, accountId);
}

async function fetchAccountBalance(
  apiKey: string,
  accountId: string,
  resolvedFromProfile = false
): Promise<UsageResult> {
  const res = await fetchJson(
    `https://api.tradier.com/v1/accounts/${accountId}/balances`,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    }
  );

  if (!res.ok) {
    return errorResult(res.status, { note: "Tradier balances were unavailable" });
  }

  const data = res.data as {
    balances?: {
      total_equity?: number;
      total_cash?: number;
      open_pl?: number;
      margin?: { stock_buying_power?: number };
      cash?: { cash_available?: number };
    };
  };

  const balances = data.balances;
  const balance =
    parseNumber(balances?.total_equity) ?? parseNumber(balances?.total_cash);
  const allowed = headerNumber(res.headers, ["x-ratelimit-allowed"]);
  const used = headerNumber(res.headers, ["x-ratelimit-used"]);
  const available = headerNumber(res.headers, ["x-ratelimit-available"]);
  const expiry = res.headers.get("x-ratelimit-expiry");
  const parsedExpiry = expiry == null
    ? Number.NaN
    : /^\d+$/.test(expiry)
      ? Number(expiry) * 1000
      : Date.parse(expiry);
  const expiryAt = Number.isFinite(parsedExpiry)
    ? new Date(parsedExpiry).toISOString()
    : null;

  return {
    balance,
    // Brokerage P/L is not API spend and must never enter provider budgets.
    totalCost: null,
    totalRequests: used,
    credits: available,
    rawData: {
      resolvedFromProfile,
      account: {
        totalEquity: balance,
        openProfitLoss: parseNumber(balances?.open_pl),
        buyingPower:
          parseNumber(balances?.margin?.stock_buying_power) ??
          parseNumber(balances?.cash?.cash_available),
      },
      rateLimit: { allowed, used, available, expiryAt },
      capabilities: {
        accountPortfolio: true,
        apiRateLimit: allowed != null || available != null,
        billingCost: false,
      },
    },
    externalBilling: allowed != null
      ? {
          source: "tradier-api-limits",
          authoritative: true,
          records: [
            {
              externalId: "account-api-limit",
              kind: "account",
              planName: "Tradier API rate limit",
              status: "active",
              requestLimit: allowed,
              requestLimitWindow: "minute",
              currentPeriodEnd: expiryAt,
            },
          ],
        }
      : undefined,
  };
}
