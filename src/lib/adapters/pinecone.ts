import { AdapterError, errorResult, fetchJson, type UsageResult } from "./helpers";

interface PineconeIndex {
  name: string;
  host?: string;
}

export function isAllowedPineconeIndexHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/\.$/, "");
  if (
    !normalized ||
    normalized.includes(":") ||
    normalized.includes("/") ||
    normalized.includes("@")
  ) {
    return false;
  }
  const labels = normalized.split(".");
  return (
    labels.length >= 5 &&
    labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) &&
    normalized.endsWith(".pinecone.io") &&
    labels.includes("svc")
  );
}

export async function fetchUsage(apiKey: string): Promise<UsageResult> {
  // Fetch list of indexes, then get stats for each
  const indexesRes = await fetchJson("https://api.pinecone.io/indexes", {
    headers: {
      "Api-Key": apiKey,
      "Content-Type": "application/json",
    },
  });

  if (!indexesRes.ok) {
    return errorResult(indexesRes.status);
  }

  const { indexes = [] } = (indexesRes.data ?? {}) as {
    indexes?: PineconeIndex[];
  };
  const rawData: Record<string, unknown> = { indexes };

  let totalVectorCount = 0;
  const stats: unknown[] = [];

  for (const idx of indexes) {
    try {
      const host = idx.host;
      if (!host) continue;
      if (!isAllowedPineconeIndexHost(host)) {
        throw new AdapterError(
          "Pinecone returned an index host outside the allowed *.svc.*.pinecone.io domain",
          { code: "UNSAFE_OUTBOUND_URL" }
        );
      }
      const statsRes = await fetchJson(
        `https://${host}/describe_index_stats`,
        {
          headers: {
            "Api-Key": apiKey,
            "Content-Type": "application/json",
          },
          method: "POST",
          body: JSON.stringify({}),
        },
        { security: "untrusted" }
      );

      if (statsRes.ok) {
        const indexStats = statsRes.data as { totalVectorCount?: number };
        stats.push({ name: idx.name, stats: indexStats });
        if (typeof indexStats.totalVectorCount === "number") {
          totalVectorCount += indexStats.totalVectorCount;
        }
      } else {
        stats.push({ name: idx.name, error: `HTTP ${statsRes.status}` });
      }
    } catch (err) {
      stats.push({
        name: idx.name,
        error: err instanceof Error ? err.message : "Unknown",
      });
    }
  }

  rawData.stats = stats;

  return {
    balance: null,
    totalCost: null,
    totalRequests: null,
    credits: null,
    rawData: {
      ...rawData,
      totalVectorCount,
      capabilities: {
        indexInventory: true,
        vectorCount: true,
        billingCost: false,
        subscriptionStatus: false,
      },
    },
  };
}
