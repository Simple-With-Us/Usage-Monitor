import { errorResult, fetchJson, type UsageResult } from "./helpers";

export async function fetchUsage(
  apiKey: string,
  config?: Record<string, unknown>
): Promise<UsageResult> {
  const defaultUrl = "https://agent-sync.jays.services/health";
  const url = (config?.endpoint as string) || defaultUrl;
  const res = await fetchJson(
    url,
    { headers: { "Content-Type": "application/json" } },
    {
      security: url === defaultUrl ? "trusted" : "untrusted",
      maxResponseBytes: 256 * 1024,
    }
  );
  if (!res.ok) {
    return errorResult(res.status, { note: "Agent Sync Relay health check failed" });
  }

  return {
    balance: null,
    totalCost: 0,
    totalRequests: null,
    credits: null,
    rawData: { status: "UP", data: res.data },
  };
}
