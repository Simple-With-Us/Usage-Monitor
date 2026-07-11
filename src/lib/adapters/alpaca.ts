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
  const apiSecret = config?.apiSecret as string | undefined;
  const environment = (config?.environment as string | undefined) || "paper";
  const baseUrl =
    environment === "live"
      ? "https://api.alpaca.markets"
      : "https://paper-api.alpaca.markets";

  if (!apiSecret) {
    configurationError("apiSecret is required in config for Alpaca");
  }

  const res = await fetchJson(`${baseUrl}/v2/account`, {
    headers: {
      "APCA-API-KEY-ID": apiKey,
      "APCA-API-SECRET-KEY": apiSecret,
    },
  });

  if (!res.ok) {
    return errorResult(res.status, { response: res.data });
  }

  const data = res.data as {
    equity?: string;
    cash?: string;
    buying_power?: string;
    portfolio_value?: string;
    status?: string;
  };

  return {
    balance:
      parseNumber(data.equity) ??
      parseNumber(data.portfolio_value) ??
      parseNumber(data.cash),
    totalCost: null,
    totalRequests: null,
    credits: null,
    rawData: {
      status: data.status ?? null,
      equity: parseNumber(data.equity),
      cash: parseNumber(data.cash),
      buyingPower: parseNumber(data.buying_power),
      portfolioValue: parseNumber(data.portfolio_value),
      capabilities: {
        brokerageAccount: true,
        apiBillingCost: false,
      },
    },
  };
}
