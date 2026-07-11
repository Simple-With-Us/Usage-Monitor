import {
  configurationError,
  errorResult,
  fetchJson,
  parseNumber,
  type UsageResult,
} from "./helpers";

export async function fetchUsage(
  apiKey: string,
  config?: Record<string, unknown>
): Promise<UsageResult> {
  const publicKey = (config?.publicKey as string | undefined) || apiKey;
  const secretKey = config?.secretKey as string | undefined;
  const host =
    (config?.host as string | undefined) || "https://cloud.langfuse.com";
  const defaultHost = "https://cloud.langfuse.com";

  if (!secretKey) {
    configurationError("secretKey is required in config (Langfuse secret key)");
  }

  const auth = Buffer.from(`${publicKey}:${secretKey}`).toString("base64");
  const res = await fetchJson(
    `${host.replace(/\/$/, "")}/api/public/metrics/daily?page=1&limit=31`,
    { headers: { Authorization: `Basic ${auth}` } },
    { security: host === defaultHost ? "trusted" : "untrusted" }
  );

  if (!res.ok) {
    return errorResult(res.status, { response: res.data });
  }

  const data = res.data as {
    data?: Array<{
      countTraces?: number;
      countObservations?: number;
      totalCost?: number;
    }>;
  };

  let totalCost = 0;
  let totalRequests = 0;
  let foundCost = false;
  let foundRequests = false;

  for (const day of data.data || []) {
    if (typeof day.totalCost === "number") {
      totalCost += day.totalCost;
      foundCost = true;
    }
    if (typeof day.countObservations === "number") {
      totalRequests += day.countObservations;
      foundRequests = true;
    }
  }

  return {
    balance: null,
    // Langfuse reports the cost of observed model calls, not the price of the
    // Langfuse subscription itself. Do not attribute that spend to Langfuse
    // or double-count it alongside the underlying model provider.
    totalCost: null,
    totalRequests: foundRequests ? totalRequests : null,
    credits: null,
    rawData: {
      trackedLlmCostUsd: foundCost ? totalCost : null,
      observationCount: foundRequests ? totalRequests : null,
      capabilities: {
        trackedLlmCost: foundCost,
        langfuseInvoiceCost: false,
        subscriptionStatus: false,
      },
    },
  };
}
