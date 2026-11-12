import { knownAiVendor } from "./allowlist.mjs";

const OPERATIONS = new Set(["chat", "generate_content", "execute_tool", "tool", "llm_request", "api_request", "log", "usage_observation", "botfleet.turn"]);

export function telemetryIdentifier(value, max = 160) {
  return typeof value === "string" && value.length <= max && /^[a-z0-9][a-z0-9._:/@+-]*$/i.test(value) && !/^(?:sk[-_]|bearer|password|secret[-_])/i.test(value) ? value : undefined;
}

/** Explicit identifiers and finite counters only; no producer text containers. */
export function projectHubTelemetry(event) {
  const identifier = telemetryIdentifier;
  const numeric = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
  const projection = {
    eventId: identifier(event.eventId, 256), ts: typeof event.ts === "string" && Number.isFinite(Date.parse(event.ts)) ? new Date(event.ts).toISOString() : new Date(0).toISOString(),
    platform: identifier(event.platform, 80) || "unknown", kind: event.kind === "log" ? "log" : "span",
    operation: OPERATIONS.has(event.operation) ? event.operation : "telemetry", status: event.status === "error" ? "error" : "ok",
  };
  for (const key of ["model", "authenticatedSource", "errorType", "serviceName"]) {
    const value = identifier(event[key]);
    if (value) projection[key] = value;
  }
  const vendor = knownAiVendor(event.vendor);
  if (vendor) projection.vendor = vendor;
  for (const key of ["durationMs", "ttftMs"]) if (numeric(event[key])) projection[key] = event[key];
  for (const [field, keys] of [["tokens", ["input", "output", "cacheRead", "cacheCreation", "reasoning"]], ["context", ["tokens", "limit", "utilizationPct"]]]) {
    projection[field] = Object.fromEntries(keys.filter((key) => numeric(event[field]?.[key])).map((key) => [key, event[field][key]]));
  }
  if (Array.isArray(event.toolNames)) projection.toolNames = event.toolNames.map((value) => identifier(value, 80)).filter(Boolean).slice(0, 32);
  if (["ok", "error", "success", "completed", "failed"].includes(event.toolStatus)) projection.toolStatus = event.toolStatus;
  return projection;
}

