import { blindProviderResult, type UsageResult } from "./helpers";

export async function fetchUsage(apiKey: string): Promise<UsageResult> {
  void apiKey;
  return blindProviderResult(
    "fintech-studios",
    "No documented Fintech Studios account usage or billing API was found. No market-status request was consumed merely to validate the key."
  );
}
