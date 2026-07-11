import {
  errorResult,
  fetchJson,
  type UsageResult,
} from "./helpers";

export async function fetchUsage(
  apiKey: string,
  config?: Record<string, unknown>
): Promise<UsageResult> {
  const projectId = config?.projectId as string | undefined;
  const host =
    (config?.host as string | undefined) || "https://api.cloud.llamaindex.ai";
  const defaultHost = "https://api.cloud.llamaindex.ai";

  const url = projectId
    ? `${host.replace(/\/$/, "")}/api/v1/projects/${projectId}`
    : `${host.replace(/\/$/, "")}/api/v1/projects`;

  const res = await fetchJson(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  }, { security: host === defaultHost ? "trusted" : "untrusted" });

  if (!res.ok) {
    return errorResult(res.status, { response: res.data });
  }

  const data = res.data as
    | { projects?: unknown[] }
    | { project?: unknown }
    | unknown[];

  const projects = Array.isArray(data)
    ? data
    : Array.isArray((data as { projects?: unknown[] }).projects)
      ? (data as { projects: unknown[] }).projects
      : (data as { project?: unknown }).project
        ? [(data as { project: unknown }).project]
        : [];

  return {
    balance: null,
    totalCost: null,
    totalRequests: null,
    credits: null,
    rawData: {
      projectCount: projects.length,
      note: "LlamaIndex Cloud does not expose remaining credits or billing via API. Authentication was checked through the non-inference projects control plane.",
      capabilities: {
        nonBillableKeyValidation: true,
        billingCost: false,
        subscriptionStatus: false,
      },
    },
  };
}
