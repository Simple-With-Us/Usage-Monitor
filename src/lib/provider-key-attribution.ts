import crypto from "crypto";
import { canonicalProviderKey } from "@/lib/provider-identity";

const FINGERPRINT_DOMAIN = "usage-monitor.provider-key-identity.v1";

export interface AttributionIdentity {
  id: string;
  providerId: string;
  providerName: string;
  status: string;
  retiredAt: Date | null;
  providerReportedKeyIdFingerprint: string | null;
}

export interface AttributionBinding {
  id: string;
  identityId: string;
  projectId: string | null;
  producerId: string;
  producerKeyRef: string;
  providerConnectionRef: string | null;
  billingAccountRef: string | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

export interface AttributionObservation {
  providerName: string;
  producerId: string;
  producerKeyRef: string | null;
  providerConnectionRef: string | null;
  billingAccountRef: string | null;
  providerReportedKeyId?: string | null;
  occurredAt: Date;
}

export type AttributionResolution =
  | {
      status: "matched";
      identityId: string;
      bindingId: string | null;
      projectId: string | null;
      matchedBy: "provider_reported_key_id" | "producer_key_ref" | "both";
    }
  | {
      status: "unattributed";
      reason:
        | "missing_key_reference"
        | "unknown_provider_key"
        | "no_effective_binding"
        | "ambiguous_binding";
    };

function fingerprintKeyMaterial(): string {
  const value =
    process.env.ATTRIBUTION_IDENTITY_HMAC_KEY?.trim() ||
    process.env.ENCRYPTION_KEY?.trim() ||
    "";
  if (value.length < 32) {
    throw new Error(
      "ATTRIBUTION_IDENTITY_HMAC_KEY or ENCRYPTION_KEY must be at least 32 characters"
    );
  }
  return value;
}

/**
 * Convert a provider-reported stable opaque key ID into a one-way identity.
 * The raw value is accepted only in memory and must never be logged or stored.
 */
export function fingerprintProviderReportedKeyId(
  providerId: string,
  providerReportedKeyId: string
): string {
  const normalizedProviderId = providerId.trim();
  const normalizedKeyId = providerReportedKeyId.trim();
  if (!normalizedProviderId || !normalizedKeyId) {
    throw new Error("providerId and providerReportedKeyId are required");
  }
  return crypto
    .createHmac("sha256", fingerprintKeyMaterial())
    .update(FINGERPRINT_DOMAIN)
    .update("\0")
    .update(normalizedProviderId)
    .update("\0")
    .update(normalizedKeyId)
    .digest("hex");
}

export function displayProviderKeyFingerprint(value: string | null): string | null {
  return value ? `hmac:${value.slice(0, 12)}` : null;
}

function sameOptionalConstraint(expected: string | null, actual: string | null): boolean {
  return expected == null || expected === actual;
}

function isEffective(binding: AttributionBinding, occurredAt: Date): boolean {
  return (
    binding.effectiveFrom.getTime() <= occurredAt.getTime() &&
    (binding.effectiveTo == null || occurredAt.getTime() < binding.effectiveTo.getTime())
  );
}

/**
 * Resolve one observation without guessing. Similar labels never match. Any
 * contradictory or multiple effective bindings remain explicitly unattributed.
 */
export function resolveProviderKeyAttribution(
  observation: AttributionObservation,
  identities: readonly AttributionIdentity[],
  bindings: readonly AttributionBinding[]
): AttributionResolution {
  const providerIdentities = identities.filter((identity) => {
    const existedAtObservation =
      identity.status === "active" ||
      (identity.retiredAt != null && observation.occurredAt.getTime() < identity.retiredAt.getTime());
    return (
      existedAtObservation &&
      canonicalProviderKey(identity.providerName) === canonicalProviderKey(observation.providerName)
    );
  });

  const producerKeyRef = observation.producerKeyRef?.trim() || null;
  const explicitProviderReportedKeyId = observation.providerReportedKeyId?.trim() || null;
  // Shared v2.0 has no separate providerReportedKeyId field. When a producer
  // uses the provider's opaque stable ID as producerKeyRef, compare its HMAC
  // automatically; a local alias simply will not match and falls through to
  // the administrator binding path.
  const providerReportedCandidate = explicitProviderReportedKeyId ?? producerKeyRef;
  let providerReportedMatches: AttributionIdentity[] = [];
  if (providerReportedCandidate) {
    providerReportedMatches = providerIdentities.filter(
      (identity) =>
        identity.providerReportedKeyIdFingerprint != null &&
        identity.providerReportedKeyIdFingerprint ===
          fingerprintProviderReportedKeyId(identity.providerId, providerReportedCandidate)
    );
    if (explicitProviderReportedKeyId && providerReportedMatches.length === 0) {
      return { status: "unattributed", reason: "unknown_provider_key" };
    }
    if (providerReportedMatches.length > 1) {
      return { status: "unattributed", reason: "ambiguous_binding" };
    }
  }

  const bindingMatches = producerKeyRef
    ? bindings.filter((binding) => {
        const identity = providerIdentities.find((candidate) => candidate.id === binding.identityId);
        return Boolean(
          identity &&
            binding.producerId === observation.producerId &&
            binding.producerKeyRef === producerKeyRef &&
            sameOptionalConstraint(binding.providerConnectionRef, observation.providerConnectionRef) &&
            sameOptionalConstraint(binding.billingAccountRef, observation.billingAccountRef) &&
            isEffective(binding, observation.occurredAt)
        );
      })
    : [];

  if (bindingMatches.length > 1) {
    return { status: "unattributed", reason: "ambiguous_binding" };
  }

  const providerReportedIdentity = providerReportedMatches[0] ?? null;
  const binding = bindingMatches[0] ?? null;
  if (providerReportedIdentity && binding && providerReportedIdentity.id !== binding.identityId) {
    return { status: "unattributed", reason: "ambiguous_binding" };
  }
  if (providerReportedIdentity || binding) {
    return {
      status: "matched",
      identityId: providerReportedIdentity?.id ?? binding!.identityId,
      bindingId: binding?.id ?? null,
      projectId: binding?.projectId ?? null,
      matchedBy: providerReportedIdentity
        ? binding
          ? "both"
          : "provider_reported_key_id"
        : "producer_key_ref",
    };
  }

  if (!producerKeyRef && !observation.providerReportedKeyId?.trim()) {
    return { status: "unattributed", reason: "missing_key_reference" };
  }
  return { status: "unattributed", reason: "no_effective_binding" };
}

export function parseRequiredAttributionString(
  value: unknown,
  field: string,
  max = 160
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  const normalized = value.trim();
  if (normalized.length > max) throw new Error(`${field} must be ${max} characters or fewer`);
  return normalized;
}

export function parseOptionalAttributionString(
  value: unknown,
  field: string,
  max = 160
): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > max) throw new Error(`${field} must be ${max} characters or fewer`);
  return normalized;
}

export function parseAttributionDate(value: unknown, field: string): Date {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${field} must be an ISO date`);
  return parsed;
}
