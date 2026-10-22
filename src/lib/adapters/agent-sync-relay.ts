import { errorResult, fetchJson, type UsageResult } from "./helpers";

export async function fetchUsage(
  apiKey: string,
  config?: Record<string, unknown>
): Promise<UsageResult> {
  const defaultUrl = "https://agents.simplewithus.com/health";
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

  // Health-only provider: never report complete $0 cash. A totalCost of 0 with
  // no MTD scope was previously eligible for budget math as authoritative free.
  return {
    balance: null,
    totalCost: null,
    totalRequests: null,
    credits: null,
    costScope: "unknown",
    rawData: { status: "UP", data: res.data },
  };
}
