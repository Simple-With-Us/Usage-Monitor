import { blindProviderResult, type UsageResult } from "./helpers";

export async function fetchUsage(apiKey: string): Promise<UsageResult> {
  void apiKey;
  return blindProviderResult(
    "tiingo",
    "Tiingo has no documented account usage or billing endpoint. The monitor no longer spends an API call on /api/test every poll."
  );
}
