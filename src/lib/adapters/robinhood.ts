import { blindProviderResult, type UsageResult } from "./helpers";

export async function fetchUsage(apiKey: string): Promise<UsageResult> {
  void apiKey;
  return blindProviderResult(
    "robinhood",
    "Robinhood does not offer a public retail usage or billing API."
  );
}
