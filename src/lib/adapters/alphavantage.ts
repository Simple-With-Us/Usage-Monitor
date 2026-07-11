import { blindProviderResult, type UsageResult } from "./helpers";

export async function fetchUsage(apiKey: string): Promise<UsageResult> {
  void apiKey;
  return blindProviderResult(
    "alphavantage",
    "Alpha Vantage has no documented account usage or billing endpoint. No quote request was consumed merely to validate the key."
  );
}
