import { createHash, timingSafeEqual } from "node:crypto";
import { canonicalProviderKey } from "@/lib/provider-identity";

export type GeminiKeyState =
  | "valid"
  | "invalid"
  | "unreadable"
  | "unavailable"
  | "unchecked"
  | "not_configured";

export interface GeminiKeyStatus {
  state: GeminiKeyState;
  httpStatus: number | null;
  availableModelCount: number | null;
  checkedAt: string | null;
}

export type GeminiBillingState =
  | "ready"
  | "pending"
  | "error"
  | "configuration_changed"
  | "unchecked"
  | "not_configured";

export interface GeminiBillingStatus {
  state: GeminiBillingState;
  errorCode: string | null;
  httpStatus: number | null;
  retryable: boolean;
  checkedAt: string | null;
}

export type GeminiMonitoringState =
  | "ready"
  | "empty"
  | "partial"
  | "permission_denied"
  | "error"
  | "configuration_changed"
  | "project_required"
  | "credential_required"
  | "unchecked"
  | "not_configured";

export interface GeminiMonitoringStatus {
  state: GeminiMonitoringState;
  projectId: string | null;
  errorCode: string | null;
  httpStatus: number | null;
  retryable: boolean;
  checkedAt: string | null;
}

interface LatestGeminiSnapshot {
  rawData: unknown;
  fetchedAt: Date | string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function safeInteger(value: unknown, minimum = 0): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum
    ? value
    : null;
}

function isoDate(value: Date | string): string | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function hasGeminiBillingConfig(
  config: Record<string, unknown>
): boolean {
  return Boolean(
    cleanString(config.billingDataset) ||
      cleanString(config.billingTable)
  );
}

/** Server-only binding for one exact billing configuration. */
export function geminiBillingConfigFingerprint(
  config: Record<string, unknown>
): string {
  const identity = [
    ["billingDataset", cleanString(config.billingDataset)],
    ["billingTable", cleanString(config.billingTable)],
    ["googleProjectId", cleanString(config.googleProjectId)],
    ["serviceAccountJson", cleanString(config.serviceAccountJson)],
  ];
  return createHash("sha256")
    .update("api-usage-monitor:gemini-billing-config:v1\0", "utf8")
    .update(JSON.stringify(identity), "utf8")
    .digest("hex");
}

/** Server-only binding for one exact Cloud Monitoring identity. */
export function geminiMonitoringConfigFingerprint(
  config: Record<string, unknown>
): string {
  const identity = [
    ["googleProjectId", cleanString(config.googleProjectId)],
    ["serviceAccountJson", cleanString(config.serviceAccountJson)],
  ];
  return createHash("sha256")
    .update("api-usage-monitor:gemini-monitoring-config:v1\0", "utf8")
    .update(JSON.stringify(identity), "utf8")
    .digest("hex");
}

/**
 * Binds a validation result to one opaque Gemini key without persisting or
 * returning the key itself. Gemini keys are high-entropy credentials; the
 * digest is server-side comparison metadata and is never included in API
 * responses.
 */
export function geminiApiKeyFingerprint(apiKey: string): string {
  return createHash("sha256")
    .update("api-usage-monitor:gemini-key:v1\0", "utf8")
    .update(apiKey, "utf8")
    .digest("hex");
}

function sameFingerprint(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

/**
 * Returns only a sanitized connection-health projection. In particular, it
 * never returns snapshot rawData or the credential fingerprint.
 */
export function deriveGeminiKeyStatus(input: {
  providerName: string;
  providerType: string;
  apiKey: string | null;
  apiKeyConfigured?: boolean;
  latestSnapshot: LatestGeminiSnapshot | null;
}): GeminiKeyStatus | null {
  if (
    input.providerType.trim().toLowerCase() !== "builtin" ||
    canonicalProviderKey(input.providerName) !== "google-ai"
  ) {
    return null;
  }

  if (!input.apiKey) {
    return {
      state: input.apiKeyConfigured ? "unreadable" : "not_configured",
      httpStatus: null,
      availableModelCount: null,
      checkedAt: null,
    };
  }

  const rawData = asRecord(input.latestSnapshot?.rawData);
  const validation = asRecord(rawData?.keyValidation);
  const observedFingerprint =
    typeof validation?.credentialFingerprint === "string"
      ? validation.credentialFingerprint
      : null;
  const currentFingerprint = geminiApiKeyFingerprint(input.apiKey);

  if (!input.latestSnapshot || !observedFingerprint) {
    return {
      state: "unchecked",
      httpStatus: null,
      availableModelCount: null,
      checkedAt: null,
    };
  }

  if (!sameFingerprint(observedFingerprint, currentFingerprint)) {
    return {
      state: "unchecked",
      httpStatus: null,
      availableModelCount: null,
      checkedAt: null,
    };
  }

  const httpStatus = safeInteger(validation?.status, 100);
  const availableModelCount = safeInteger(
    validation?.availableModelCount,
    0
  );
  const declaredOutcome = validation?.outcome;
  const state: GeminiKeyState =
    declaredOutcome === "valid" ||
    declaredOutcome === "invalid" ||
    declaredOutcome === "unavailable"
      ? declaredOutcome
      : validation?.ok === true
        ? "valid"
        : validation?.ok === false
          ? httpStatus != null && [400, 401, 403].includes(httpStatus)
            ? "invalid"
            : "unavailable"
          : "unchecked";

  return {
    state,
    httpStatus,
    availableModelCount,
    checkedAt:
      state === "unchecked" ? null : isoDate(input.latestSnapshot.fetchedAt),
  };
}

/**
 * Sanitizes the latest billing-channel result and binds it to the current
 * service-account/dataset/project configuration. No raw billing configuration
 * or fingerprint leaves the server.
 */
export function deriveGeminiBillingStatus(input: {
  providerName: string;
  providerType: string;
  billingConfig: Record<string, unknown> | null;
  latestSnapshot: LatestGeminiSnapshot | null;
}): GeminiBillingStatus | null {
  if (
    input.providerType.trim().toLowerCase() !== "builtin" ||
    canonicalProviderKey(input.providerName) !== "google-ai"
  ) {
    return null;
  }

  if (input.billingConfig == null) {
    return {
      state: "error",
      errorCode: "CONFIGURATION_UNREADABLE",
      httpStatus: null,
      retryable: false,
      checkedAt: null,
    };
  }

  if (!hasGeminiBillingConfig(input.billingConfig)) {
    return {
      state: "not_configured",
      errorCode: null,
      httpStatus: null,
      retryable: false,
      checkedAt: null,
    };
  }

  const rawData = asRecord(input.latestSnapshot?.rawData);
  const billing = asRecord(rawData?.billing);
  const observedFingerprint =
    typeof billing?.configFingerprint === "string"
      ? billing.configFingerprint
      : null;
  const currentFingerprint = geminiBillingConfigFingerprint(
    input.billingConfig
  );

  if (!input.latestSnapshot || !observedFingerprint) {
    return {
      state: "unchecked",
      errorCode: null,
      httpStatus: null,
      retryable: false,
      checkedAt: null,
    };
  }

  if (!sameFingerprint(observedFingerprint, currentFingerprint)) {
    return {
      state: "configuration_changed",
      errorCode: null,
      httpStatus: null,
      retryable: false,
      checkedAt: null,
    };
  }

  const declaredStatus = billing?.status;
  const state: GeminiBillingState =
    declaredStatus === "ready" ||
    declaredStatus === "pending" ||
    declaredStatus === "error"
      ? declaredStatus
      : "unchecked";
  return {
    state,
    errorCode:
      state === "error" && typeof billing?.errorCode === "string"
        ? billing.errorCode
        : null,
    httpStatus:
      state === "error" ? safeInteger(billing?.httpStatus, 100) : null,
    retryable: state === "error" && billing?.retryable === true,
    checkedAt:
      state === "unchecked" ? null : isoDate(input.latestSnapshot.fetchedAt),
  };
}

/** Sanitized project-level Monitoring health, kept separate from cash billing. */
export function deriveGeminiMonitoringStatus(input: {
  providerName: string;
  providerType: string;
  monitoringConfig: Record<string, unknown> | null;
  latestSnapshot: LatestGeminiSnapshot | null;
}): GeminiMonitoringStatus | null {
  if (
    input.providerType.trim().toLowerCase() !== "builtin" ||
    canonicalProviderKey(input.providerName) !== "google-ai"
  ) {
    return null;
  }

  const configuredProjectId = cleanString(
    input.monitoringConfig?.googleProjectId
  );
  if (input.monitoringConfig == null) {
    return {
      state: "error",
      projectId: configuredProjectId || null,
      errorCode: "CONFIGURATION_UNREADABLE",
      httpStatus: null,
      retryable: false,
      checkedAt: null,
    };
  }
  if (!cleanString(input.monitoringConfig.serviceAccountJson)) {
    return {
      state: configuredProjectId ? "credential_required" : "not_configured",
      projectId: configuredProjectId || null,
      errorCode: null,
      httpStatus: null,
      retryable: false,
      checkedAt: null,
    };
  }

  const rawData = asRecord(input.latestSnapshot?.rawData);
  const monitoring = asRecord(rawData?.monitoring);
  if (!input.latestSnapshot || !monitoring) {
    return {
      state: "unchecked",
      projectId: configuredProjectId || null,
      errorCode: null,
      httpStatus: null,
      retryable: false,
      checkedAt: null,
    };
  }
  const observedFingerprint =
    typeof monitoring.configFingerprint === "string"
      ? monitoring.configFingerprint
      : null;
  const currentFingerprint = geminiMonitoringConfigFingerprint(
    input.monitoringConfig
  );
  if (!observedFingerprint) {
    return {
      state: "unchecked",
      projectId: configuredProjectId || null,
      errorCode: null,
      httpStatus: null,
      retryable: false,
      checkedAt: null,
    };
  }
  if (!sameFingerprint(observedFingerprint, currentFingerprint)) {
    return {
      state: "configuration_changed",
      projectId: configuredProjectId || null,
      errorCode: null,
      httpStatus: null,
      retryable: false,
      checkedAt: null,
    };
  }
  const observedProjectId = cleanString(monitoring.projectId);
  if (
    configuredProjectId &&
    observedProjectId &&
    configuredProjectId !== observedProjectId
  ) {
    return {
      state: "unchecked",
      projectId: configuredProjectId,
      errorCode: null,
      httpStatus: null,
      retryable: false,
      checkedAt: null,
    };
  }

  const declaredStatus = monitoring.status;
  const state: GeminiMonitoringState =
    declaredStatus === "ready" ||
    declaredStatus === "empty" ||
    declaredStatus === "partial" ||
    declaredStatus === "permission_denied" ||
    declaredStatus === "error" ||
    declaredStatus === "project_required" ||
    declaredStatus === "credential_required"
      ? declaredStatus
      : "unchecked";
  const requests = asRecord(monitoring.requests);
  const descriptors = asRecord(monitoring.descriptorDiscovery);
  const quotaUsage = asRecord(monitoring.quotaUsage);
  const quotaLimits = asRecord(monitoring.quotaLimits);
  const failure = [monitoring, requests, descriptors, quotaUsage, quotaLimits]
    .find(
      (record) =>
        typeof record?.errorCode === "string" ||
        safeInteger(record?.httpStatus, 100) != null
    );

  return {
    state,
    projectId: observedProjectId || configuredProjectId || null,
    errorCode:
      failure && typeof failure.errorCode === "string"
        ? failure.errorCode
        : null,
    httpStatus: failure ? safeInteger(failure.httpStatus, 100) : null,
    retryable: failure?.retryable === true,
    checkedAt:
      state === "unchecked" ? null : isoDate(input.latestSnapshot.fetchedAt),
  };
}
