import { blindProviderResult, type UsageResult } from "./helpers";

export async function fetchUsage(apiKey: string): Promise<UsageResult> {
  void apiKey;
  return blindProviderResult(
    "fred",
    "FRED is free and exposes no account billing state. No economic-data request is sent merely to validate the key."
  );
}
