export interface RawDataRedactionPolicy {
  redacted: boolean;
  strategy: "allowlist" | "strip_all" | "preserve";
  retainedFields?: string[];
  droppedFields?: string[];
}

/**
 * Returns a new object with the `__apiUsageMonitor.privacy` metadata injected.
 */
function applyPrivacyMetadata(
  rawData: unknown,
  policy: RawDataRedactionPolicy
): unknown {
  if (rawData == null || typeof rawData !== "object") {
    return rawData;
  }

  const original = rawData as Record<string, unknown>;
  const apiUsageMonitor =
    original.__apiUsageMonitor && typeof original.__apiUsageMonitor === "object"
      ? (original.__apiUsageMonitor as Record<string, unknown>)
      : {};

  return {
    ...original,
    __apiUsageMonitor: {
      ...apiUsageMonitor,
      privacy: policy,
    },
  };
}

/**
 * Wave H / E10: built-in adapters keep only money/ops-useful top-level fields
 * (and the monitor metadata bag). Nested payloads are not deep-walked — if a
 * field is not on the allowlist it is dropped wholesale so email/token blobs
 * cannot ride along under an opaque key.
 *
 * When a provider has no specific allowlist, fall back to a conservative
 * shared set rather than preserving the full upstream body.
 */
const SHARED_SAFE_FIELDS = new Set([
  "totalCost",
  "balance",
  "credits",
  "totalRequests",
  "costScope",
  "costWindowStart",
  "costWindowEnd",
  "costIncludesUnknownFixed",
  "fixedCostIncludedUsd",
  "costCoverageCaveat",
  "partialFailure",
  "status",
  "error",
  "message",
  "ok",
  "available",
  "limit",
  "remaining",
  "tier",
  "plan",
  "billingMode",
  "usageUnitLabel",
  "externalBilling",
  "components",
  "componentCount",
  "activity",
  "keys",
  "subscription",
  "grants",
  "rateLimit",
  "rateLimits",
  "quota",
  "spendingLimit",
  "invoice",
  "invoices",
  "period",
  "billingCycle",
  "teamId",
  "organizationId",
  "projectId",
  "accountId",
  "region",
  "fetchedAt",
  "syncedAt",
  "warnings",
  "note",
  "notes",
  // Partial/poll metadata commonly written by adapters (timeout/retry paths).
  "keyValidation",
  "billing",
  "providerPoll",
  "providerField",
  "partialFailure",
]);

/** Provider-name (lowercase) → extra retained top-level keys beyond SHARED_SAFE. */
const PROVIDER_EXTRA_ALLOWLIST: Record<string, readonly string[]> = {
  openai: ["organization", "usage", "costs", "projectCosts", "lineItems"],
  anthropic: ["admin", "usage", "cost"],
  xai: ["management", "billing", "team"],
  openrouter: ["credits", "activity", "managementKeyConfirmed"],
  cloudflare: ["account", "paygo", "workers", "r2", "d1"],
  github: ["copilot", "budgets", "billing"],
  vercel: ["projects", "focus"],
  render: ["services", "bandwidth"],
  googleai: ["monitoring", "billingExport", "keyValidation", "billing"],
  "google-ai": ["monitoring", "billingExport", "keyValidation", "billing"],
  mistral: ["workspaces", "spendLimit"],
  stripe: ["balance", "charges"],
  oracle: ["limits", "budgets", "compartments"],
  coolify: ["servers", "applications", "resources"],
  hetzner: ["projects", "servers", "invoices"],
  sentry: ["stats", "categories"],
  resend: ["domains", "usage"],
};

function allowlistForProvider(providerName: string): Set<string> {
  const name = providerName.trim().toLowerCase();
  const extras = PROVIDER_EXTRA_ALLOWLIST[name] ?? [];
  return new Set([...SHARED_SAFE_FIELDS, ...extras, "__apiUsageMonitor"]);
}

function allowlistRawData(
  rawData: Record<string, unknown>,
  allowed: Set<string>
): { payload: Record<string, unknown>; retained: string[]; dropped: string[] } {
  const payload: Record<string, unknown> = {};
  const retained: string[] = [];
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(rawData)) {
    if (allowed.has(key)) {
      payload[key] = value;
      if (key !== "__apiUsageMonitor") retained.push(key);
    } else {
      dropped.push(key);
    }
  }
  return { payload, retained, dropped };
}

/**
 * Redacts provider rawData before persistence to minimize PII/secret exposure.
 *
 * Wave H / E10: custom adapters are strip-all; built-ins use an allowlist
 * (no longer preserve full upstream bodies).
 */
export function redactProviderRawData(
  providerType: string,
  providerName: string,
  rawData: unknown
): unknown {
  if (rawData == null) return rawData;

  const type = (providerType || "").trim().toLowerCase();
  const name = (providerName || "").trim().toLowerCase();

  if (type === "custom" || name === "custom") {
    const original = (typeof rawData === "object" && rawData && !Array.isArray(rawData)
      ? rawData
      : {}) as Record<string, unknown>;
    const redactedPayload: Record<string, unknown> = {};
    if (original.__apiUsageMonitor) {
      redactedPayload.__apiUsageMonitor = original.__apiUsageMonitor;
    }
    return applyPrivacyMetadata(redactedPayload, {
      redacted: true,
      strategy: "strip_all",
    });
  }

  if (typeof rawData !== "object" || Array.isArray(rawData)) {
    return applyPrivacyMetadata(
      { value: rawData },
      { redacted: true, strategy: "allowlist", retainedFields: [], droppedFields: ["*"] }
    );
  }

  const original = rawData as Record<string, unknown>;
  const allowed = allowlistForProvider(name);
  const { payload, retained, dropped } = allowlistRawData(original, allowed);

  return applyPrivacyMetadata(payload, {
    redacted: dropped.length > 0,
    strategy: "allowlist",
    retainedFields: retained.sort(),
    droppedFields: dropped.sort(),
  });
}
