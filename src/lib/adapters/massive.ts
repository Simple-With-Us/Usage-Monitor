import { blindProviderResult, type UsageResult } from "./helpers";

export async function fetchUsage(apiKey: string): Promise<UsageResult> {
  void apiKey;
  return blindProviderResult(
    "massive",
    "Massive exposes account and invoice information in its dashboard, not a documented billing API. No aggregate-data request was consumed merely to validate the key."
  );
}
