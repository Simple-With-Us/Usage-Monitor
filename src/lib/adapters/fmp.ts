import { blindProviderResult, type UsageResult } from "./helpers";

export async function fetchUsage(apiKey: string): Promise<UsageResult> {
  void apiKey;
  return blindProviderResult(
    "fmp",
    "FMP documents usage and billing in its dashboard, not an account API. No quote request was sent merely to validate the key."
  );
}
