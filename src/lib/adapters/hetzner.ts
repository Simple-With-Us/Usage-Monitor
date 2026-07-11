import {
  AdapterError,
  errorResult,
  fetchJson,
  parseNumber,
  type AdapterExternalBillingRecord,
  type UsageResult,
} from "./helpers";

interface ServerPrice {
  location?: string;
  price_monthly?: { net?: string; gross?: string };
}

interface HetznerServer {
  id?: number;
  name?: string;
  status?: string;
  outgoing_traffic?: number | null;
  server_type?: { name?: string; prices?: ServerPrice[] };
  datacenter?: { location?: { name?: string } };
}

export async function fetchUsage(apiKey: string): Promise<UsageResult> {
  const response = await fetchJson("https://api.hetzner.cloud/v1/servers", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) return errorResult(response.status);

  const data = (response.data ?? {}) as { servers?: HetznerServer[] };
  if (!Array.isArray(data.servers)) {
    throw new AdapterError("Hetzner returned an invalid servers response", {
      code: "INVALID_RESPONSE",
    });
  }

  let monthlyRunRateUsd = 0;
  let foundPrice = false;
  let totalBandwidthBytes = 0;
  const records: AdapterExternalBillingRecord[] = [];
  const servers = data.servers.map((server) => {
    const location = server.datacenter?.location?.name;
    const prices = server.server_type?.prices ?? [];
    const price = prices.find((entry) => entry.location === location) ?? prices[0];
    const monthlyPriceUsd = parseNumber(price?.price_monthly?.net);
    if (monthlyPriceUsd != null) {
      monthlyRunRateUsd += monthlyPriceUsd;
      foundPrice = true;
    }
    if (typeof server.outgoing_traffic === "number") {
      totalBandwidthBytes += server.outgoing_traffic;
    }
    if (server.id != null) {
      records.push({
        externalId: String(server.id),
        kind: "service_plan",
        planName: server.server_type?.name ?? null,
        status: server.status ?? "unknown",
        amountUsd: monthlyPriceUsd,
        currency: "USD",
        billingInterval: "monthly",
      });
    }
    return {
      id: server.id ?? null,
      name: server.name ?? null,
      status: server.status ?? null,
      type: server.server_type?.name ?? null,
      location: location ?? null,
      outgoingTrafficBytes: server.outgoing_traffic ?? null,
      monthlyPlanPriceUsd: monthlyPriceUsd,
    };
  });

  return {
    balance: null,
    // Hetzner's API exposes current resource prices, not an invoice or accrued
    // month-to-date bill. Do not misclassify the monthly run-rate as spend.
    totalCost: null,
    totalRequests: null,
    credits: null,
    rawData: {
      servers,
      serverCount: servers.length,
      totalBandwidthBytes,
      monthlyRunRateUsd: foundPrice ? monthlyRunRateUsd : null,
      capabilities: {
        servicePlan: true,
        serviceStatus: true,
        monthlyRunRate: foundPrice,
        actualInvoiceCost: false,
      },
    },
    externalBilling: {
      source: "hetzner-cloud-server-plans",
      authoritative: true,
      records,
    },
  };
}
