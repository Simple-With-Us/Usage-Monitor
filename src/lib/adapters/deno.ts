import { blindProviderResult, fetchJson, type UsageResult } from "./helpers";

export interface DenoUserResponse {
  id: string;
  name: string;
  email: string;
  avatarUrl?: string;
}

export async function fetchUsage(
  apiKey: string,
  config?: Record<string, unknown>
): Promise<UsageResult> {
  const token = apiKey?.trim();
  if (!token) {
    return blindProviderResult(
      "deno",
      "Deno Deploy analytics and quotas (HTTP requests, CPU time, memory time, traffic, KV reads/writes) are tracked via Deno Deploy API or pushed telemetry."
    );
  }

  try {
    const res = await fetchJson(
      "https://api.deno.com/v1/user",
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      }
    );

    if (!res.ok || !res.data) {
      return blindProviderResult(
        "deno",
        "Deno Deploy analytics and quotas (HTTP requests, CPU time, memory time, traffic, KV reads/writes) are tracked via Deno Deploy API or pushed telemetry."
      );
    }

    const user = res.data as DenoUserResponse;

    return {
      balance: null,
      totalCost: null,
      totalRequests: null,
      credits: null,
      rawData: res.data,
      externalBilling: {
        source: "deno-deploy",
        authoritative: true,
        records: [
          {
            externalId: user.id || "user",
            kind: "account",
            planName: "Deno Deploy Plan",
            status: "active",
          },
        ],
      },
    };
  } catch {
    return blindProviderResult(
      "deno",
      "Deno Deploy analytics and quotas (HTTP requests, CPU time, memory time, traffic, KV reads/writes) are tracked via Deno Deploy API or pushed telemetry."
    );
  }
}
