import { blindProviderResult, type UsageResult } from "./helpers";

export async function fetchUsage(apiKey: string): Promise<UsageResult> {
  void apiKey;
  return blindProviderResult(
    "quiver",
    "Quiver Quantitative does not expose a billing or usage quota API endpoint. Usage tracked via dashboard."
  );
}
