import { blindProviderResult, type UsageResult } from "./helpers";

export async function fetchUsage(apiKey: string): Promise<UsageResult> {
  void apiKey;
  return blindProviderResult(
    "finnhub",
    "Finnhub has no documented account usage or billing endpoint. No market-data request was consumed merely to validate the key."
  );
}
