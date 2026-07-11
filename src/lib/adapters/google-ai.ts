import {
  errorResult,
  fetchJson,
  headerNumber,
  type UsageResult,
} from "./helpers";

export async function fetchUsage(apiKey: string): Promise<UsageResult> {
  // Listing model metadata is a non-inference control-plane read. Google AI
  // Studio does not expose billing or usage through the Gemini API key; actual
  // spend must come from Cloud Billing export/API in a separate connector.
  const response = await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
    { headers: { "Content-Type": "application/json" } }
  );
  if (!response.ok) {
    return errorResult(response.status, {
      note: "Gemini key validation failed; Google AI Studio has no billing API",
    });
  }

  const data = (response.data ?? {}) as { models?: unknown[] };
  const remaining = headerNumber(response.headers, ["x-ratelimit-remaining"]);
  const limit = headerNumber(response.headers, ["x-ratelimit-limit"]);
  const reset = response.headers.get("x-ratelimit-reset");

  return {
    balance: null,
    totalCost: null,
    totalRequests: null,
    credits: remaining,
    rawData: {
      availableModelCount: Array.isArray(data.models) ? data.models.length : null,
      rateLimit: { remaining, limit, reset },
      note: "Google AI Studio exposes no billing/usage API. Configure Google Cloud Billing export/API for direct spend.",
      capabilities: {
        nonBillableKeyValidation: true,
        billingCost: false,
        subscriptionStatus: false,
      },
    },
    externalBilling: limit != null
      ? {
          source: "google-gemini-rate-limits",
          authoritative: true,
          records: [
            {
              externalId: "gemini-api-key",
              kind: "account",
              planName: "Gemini API quota",
              status: "active",
              requestLimit: limit,
              requestLimitWindow: "provider-defined",
            },
          ],
        }
      : undefined,
  };
}
