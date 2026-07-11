import {
  configurationError,
  errorResult,
  fetchJson,
  type UsageResult,
} from "./helpers";
import {
  deriveRequestWindowBounds,
  normalizeRequestWindow,
  parseRequestBoundary,
} from "@/lib/request-provenance";

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

function requestBoundary(value: unknown): Date | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Most JSON APIs expose Unix seconds; preserve millisecond timestamps too.
    return parseRequestBoundary(value < 10_000_000_000 ? value * 1000 : value);
  }
  return parseRequestBoundary(value);
}

function cleanConfigString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
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
  const requestWindow = normalizeRequestWindow(config?.requestWindow);
  const requestUnit = cleanConfigString(config?.requestUnit) ?? "requests";
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
  const hasRequests = typeof totalRequests === "number";
  const requestWindowStartPath = cleanConfigString(config?.requestWindowStartPath);
  const requestWindowEndPath = cleanConfigString(config?.requestWindowEndPath);
  const derivedBounds = deriveRequestWindowBounds(requestWindow);
  const configuredStart = requestBoundary(
    requestWindowStartPath
      ? resolveJsonPath(data, requestWindowStartPath)
      : config?.requestWindowStart
  );
  const configuredEnd = requestBoundary(
    requestWindowEndPath
      ? resolveJsonPath(data, requestWindowEndPath)
      : config?.requestWindowEnd
  );

  return {
    balance: typeof balance === "number" ? balance : null,
    totalCost: typeof totalCost === "number" ? totalCost : null,
    totalRequests: hasRequests ? totalRequests : null,
    requestUnit: hasRequests ? requestUnit : null,
    requestWindow: hasRequests ? requestWindow : null,
    requestWindowStart:
      hasRequests ? configuredStart ?? derivedBounds.start : null,
    requestWindowEnd:
      hasRequests ? configuredEnd ?? derivedBounds.end : null,
    credits: typeof credits === "number" ? credits : null,
    // Custom endpoints may return arbitrary personal or operational data.
    // Persist only whether each explicitly mapped numeric output was found,
    // never the complete upstream response.
    rawData: {
      mappedFields: {
        balance: typeof balance === "number",
        cost: typeof totalCost === "number",
        requests: typeof totalRequests === "number",
        credits: typeof credits === "number",
      },
    },
  };
}
