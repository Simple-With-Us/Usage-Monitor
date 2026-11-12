import { providerConfigForServer } from "@/lib/provider-secret-config";

export const ST_PRIMARY_MANAGED_LABEL =
  "SocraticTrade.com · Primary account" as const;

export interface ProviderCredentialManagement {
  source: "infisical";
  scope: "st-primary";
  label: typeof ST_PRIMARY_MANAGED_LABEL;
  status: "active" | "revoked";
  alias: boolean;
  readOnlyFields: readonly ["apiKey", "isActive", "label"];
}

export interface StPrimaryCredentialBinding {
  scope: "st-primary";
  source: "st-primary";
  providerName: "google-ai" | "deepseek";
  sequence: number;
  status: "active" | "revoked";
  fingerprint: string | null;
  aliasOfProviderId?: string;
}

export interface StPrimaryCredentialBindingRead {
  present: boolean;
  readable: boolean;
  binding?: StPrimaryCredentialBinding;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizedKey(key: string): string {
  return key.replace(/[_-]/g, "").toLowerCase();
}

export function containsProviderManagementClaim(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Object.entries(value).some(
    ([key, nested]) =>
      normalizedKey(key) === "infisicalcredential" ||
      containsProviderManagementClaim(nested)
  );
}

export function readStPrimaryCredentialBinding(
  config: unknown,
  encryptedSecretConfig: string | null | undefined
): StPrimaryCredentialBindingRead {
  let value: unknown;
  try {
    value = providerConfigForServer(
      config,
      encryptedSecretConfig
    ).infisicalCredential;
  } catch {
    // The envelope could contain unrelated provider secrets. Callers can use
    // the reserved server-owned label to fail closed when decryption prevents
    // proving the binding itself.
    return { present: false, readable: false };
  }
  if (value == null) return { present: false, readable: true };
  if (!isRecord(value)) return { present: true, readable: false };
  if (value.scope !== "st-primary" && value.source !== "st-primary") {
    return { present: false, readable: true };
  }
  const keys = Object.keys(value).sort();
  const expected = [
    "fingerprint",
    "providerName",
    "scope",
    "sequence",
    "source",
    "status",
    ...(value.aliasOfProviderId === undefined ? [] : ["aliasOfProviderId"]),
  ].sort();
  if (
    keys.length !== expected.length ||
    !keys.every((key, index) => key === expected[index]) ||
    value.scope !== "st-primary" ||
    value.source !== "st-primary" ||
    (value.providerName !== "google-ai" && value.providerName !== "deepseek") ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) < 1 ||
    (value.status !== "active" && value.status !== "revoked") ||
    (value.status === "active"
      ? typeof value.fingerprint !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.fingerprint)
      : value.fingerprint !== null) ||
    (value.aliasOfProviderId !== undefined &&
      (typeof value.aliasOfProviderId !== "string" || !value.aliasOfProviderId))
  ) {
    return { present: true, readable: false };
  }
  return {
    present: true,
    readable: true,
    binding: value as unknown as StPrimaryCredentialBinding,
  };
}

export function hasStPrimaryCredentialOwnership(
  config: unknown,
  encryptedSecretConfig: string | null | undefined,
  label?: string | null
): boolean {
  const read = readStPrimaryCredentialBinding(config, encryptedSecretConfig);
  return read.present || label === ST_PRIMARY_MANAGED_LABEL;
}

export function isReservedStPrimaryManagedLabel(
  label: string | null | undefined
): boolean {
  return label === ST_PRIMARY_MANAGED_LABEL;
}

/**
 * Return only browser-safe management metadata. Sequence numbers, secret
 * names, fingerprints, aliases' target IDs, and credential values remain
 * server-only.
 */
export function providerCredentialManagementForClient(
  config: unknown,
  encryptedSecretConfig: string | null | undefined
): ProviderCredentialManagement | null {
  try {
    const binding = readStPrimaryCredentialBinding(config, encryptedSecretConfig);
    if (!binding.readable || !binding.binding) return null;
    return {
      source: "infisical",
      scope: "st-primary",
      label: ST_PRIMARY_MANAGED_LABEL,
      status: binding.binding.status,
      alias: typeof binding.binding.aliasOfProviderId === "string",
      readOnlyFields: ["apiKey", "isActive", "label"],
    };
  } catch {
    return null;
  }
}
