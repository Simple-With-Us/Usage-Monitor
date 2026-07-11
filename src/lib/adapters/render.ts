import {
  configurationError,
  errorResult,
  fetchJson,
  type UsageResult,
} from "./helpers";

interface RenderService {
  id?: string;
  name?: string;
  type?: string;
  plan?: string;
  suspended?: string | boolean;
  updatedAt?: string;
}

export async function fetchUsage(
  apiKey: string,
  config?: Record<string, unknown>
): Promise<UsageResult> {
  const serviceId = (config?.serviceId as string | undefined)?.trim();
  if (!serviceId) configurationError("serviceId is required for Render plan tracking");

  const response = await fetchJson(
    `https://api.render.com/v1/services/${encodeURIComponent(serviceId)}`,
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
    }
  );
  if (!response.ok) return errorResult(response.status);

  const body = (response.data ?? {}) as RenderService & { service?: RenderService };
  const service = body.service ?? body;
  const suspended = service.suspended;
  const status = suspended === false || suspended === "not_suspended" || suspended == null
    ? "active"
    : "suspended";

  return {
    balance: null,
    totalCost: null,
    totalRequests: null,
    credits: null,
    rawData: {
      service: {
        id: service.id ?? serviceId,
        name: service.name ?? null,
        type: service.type ?? null,
        plan: service.plan ?? null,
        status,
        updatedAt: service.updatedAt ?? null,
      },
      capabilities: {
        servicePlan: service.plan != null,
        serviceStatus: true,
        actualInvoiceCost: false,
      },
    },
    externalBilling: {
      source: "render-service-plans",
      authoritative: true,
      records: [
        {
          externalId: service.id ?? serviceId,
          kind: "service_plan",
          planName: service.plan ?? null,
          status,
        },
      ],
    },
  };
}
