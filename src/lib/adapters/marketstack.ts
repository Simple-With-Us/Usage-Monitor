import { blindProviderResult, type UsageResult } from "./helpers";

export async function fetchUsage(apiKey: string): Promise<UsageResult> {
  void apiKey;
  return blindProviderResult(
    "marketstack",
    "Marketstack exposes plan usage in its dashboard, not a documented account API. No market-data request was consumed merely to validate the key."
  );
}
