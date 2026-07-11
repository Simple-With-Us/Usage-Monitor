import { blindProviderResult, type UsageResult } from "./helpers";

export async function fetchUsage(apiKey: string): Promise<UsageResult> {
  // Voyage exposes inference APIs but no documented, non-billable account,
  // usage, credit, invoice, or subscription endpoint. Never create an
  // embedding merely to validate a key: that produced billable activity on
  // every monitor poll. Voyage is push-primary until an official account API
  // exists.
  void apiKey;
  return blindProviderResult(
    "voyage",
    "No documented non-billable usage or billing API exists; no inference probe was sent."
  );
}
