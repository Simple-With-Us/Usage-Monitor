import { decryptJson } from "@/lib/crypto";

export interface SplitProviderConfig {
  publicConfig: Record<string, unknown>;
  secretConfig: Record<string, unknown>;
}

export interface ProviderSecretConfigMeta {
  configured: boolean;
  fields: string[];
  readable: boolean;
}

// `publicKey` is deliberately excluded. The exact names cover current
// adapters; the pattern catches credential-shaped fields added to custom or
// future adapters so they do not silently become browser-visible plaintext.
const ALWAYS_SECRET_KEYS = new Set([
  "adminapikey",
  "apikeysid",
  "apitoken",
  "apisecret",
  "accesstoken",
  "authtoken",
  "authusername",
  "bearertoken",
  "clientsecret",
  "extraheaders",
  "managementkey",
  "password",
  "refreshtoken",
  "secretkey",
  "webhooksecret",
]);

const SECRET_KEY_PATTERN =
  /(?:^|[_-])(authorization|credential|password|private[_-]?key|secret|token)(?:$|[_-])/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizedKey(key: string): string {
  return key.replace(/[_-]/g, "").toLowerCase();
}

export function isSecretConfigKey(key: string): boolean {
  const normalized = normalizedKey(key);
  if (normalized === "publickey") return false;
  return (
    ALWAYS_SECRET_KEYS.has(normalized) ||
    SECRET_KEY_PATTERN.test(key) ||
    /(?:authorization|credential|password|privatekey|secret|token)$/.test(normalized)
  );
}

function splitRecord(input: Record<string, unknown>): SplitProviderConfig {
  const publicConfig: Record<string, unknown> = {};
  const secretConfig: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    if (isSecretConfigKey(key)) {
      secretConfig[key] = value;
      continue;
    }

    if (isRecord(value)) {
      const nested = splitRecord(value);
      if (Object.keys(nested.publicConfig).length > 0) {
        publicConfig[key] = nested.publicConfig;
      }
      if (Object.keys(nested.secretConfig).length > 0) {
        secretConfig[key] = nested.secretConfig;
      }
      continue;
    }

    publicConfig[key] = value;
  }

  return { publicConfig, secretConfig };
}

export function splitProviderConfig(value: unknown): SplitProviderConfig {
  return isRecord(value)
    ? splitRecord(value)
    : { publicConfig: {}, secretConfig: {} };
}

export function mergeProviderConfig(
  publicConfig: Record<string, unknown>,
  secretConfig: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...publicConfig };
  for (const [key, value] of Object.entries(secretConfig)) {
    const current = merged[key];
    merged[key] = isRecord(current) && isRecord(value)
      ? mergeProviderConfig(current, value)
      : value;
  }
  return merged;
}

export function decryptProviderSecretConfig(
  encrypted: string | null | undefined
): Record<string, unknown> {
  return encrypted ? decryptJson(encrypted) : {};
}

function collectFieldPaths(
  value: Record<string, unknown>,
  prefix = ""
): string[] {
  const fields: string[] = [];
  for (const [key, nested] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isRecord(nested)) fields.push(...collectFieldPaths(nested, path));
    else fields.push(path);
  }
  return fields;
}

/** Produce the only provider-config representation allowed in API responses.
 * Legacy plaintext secrets are redacted even before the one-time migration is
 * applied, so deployment order cannot re-expose them.
 */
export function providerConfigForClient(
  config: unknown,
  encryptedSecretConfig: string | null | undefined
): {
  config: Record<string, unknown>;
  secretConfigMeta: ProviderSecretConfigMeta;
} {
  const split = splitProviderConfig(config);
  let encryptedSecrets: Record<string, unknown> = {};
  let readable = true;

  if (encryptedSecretConfig) {
    try {
      encryptedSecrets = decryptProviderSecretConfig(encryptedSecretConfig);
    } catch {
      readable = false;
    }
  }

  const combined = mergeProviderConfig(split.secretConfig, encryptedSecrets);
  const fields = collectFieldPaths(combined).sort();
  return {
    config: split.publicConfig,
    secretConfigMeta: {
      configured: Boolean(encryptedSecretConfig) || fields.length > 0,
      fields,
      readable,
    },
  };
}

export function hasProviderSecrets(value: Record<string, unknown>): boolean {
  return Object.keys(value).length > 0;
}
