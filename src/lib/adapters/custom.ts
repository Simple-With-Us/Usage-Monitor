import {
  configurationError,
  errorResult,
  fetchJson,
  type UsageResult,
} from "./helpers";

function resolveJsonPath(obj: unknown, path: string): unknown {
  // Simple JSONPath-like resolution: $.balance -> obj.balance
  const parts = path
    .replace(/^\$\./, "")
    .split(".")
    .filter(Boolean);
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export async function fetchUsage(
  apiKey: string,
  config?: Record<string, unknown>
): Promise<UsageResult> {
  const endpoint = config?.endpoint as string | undefined;
  const authType = (config?.authType as string) || "bearer";
  const authHeaderName = (config?.authHeaderName as string) || "Authorization";
  const balancePath = (config?.balancePath as string) || "$.balance";
  const costPath = (config?.costPath as string) || "$.cost";
  const requestsPath = (config?.requestsPath as string) || "$.requests";
  const creditsPath = (config?.creditsPath as string) || "$.credits";
  const extraHeaders = (config?.extraHeaders as Record<string, string>) || {};

  if (!endpoint) {
    configurationError("endpoint is required in config");
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...extraHeaders,
  };

  switch (authType) {
    case "bearer":
      headers[authHeaderName] = `Bearer ${apiKey}`;
      break;
    case "api-key":
      headers[authHeaderName] = apiKey;
      break;
    case "basic": {
      const encoded = Buffer.from(`${apiKey}:`).toString("base64");
      headers[authHeaderName] = `Basic ${encoded}`;
      break;
    }
  }

  const res = await fetchJson(endpoint, { headers }, { security: "untrusted" });

  if (!res.ok) {
    return errorResult(res.status);
  }

  const data = res.data;

  const balance = resolveJsonPath(data, balancePath);
  const totalCost = resolveJsonPath(data, costPath);
  const totalRequests = resolveJsonPath(data, requestsPath);
  const credits = resolveJsonPath(data, creditsPath);

  return {
    balance: typeof balance === "number" ? balance : null,
    totalCost: typeof totalCost === "number" ? totalCost : null,
    totalRequests: typeof totalRequests === "number" ? totalRequests : null,
    credits: typeof credits === "number" ? credits : null,
    rawData: data,
  };
}
