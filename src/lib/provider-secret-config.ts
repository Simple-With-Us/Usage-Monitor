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
  // Wave G / E18: bare apiKey (normalized "apikey") was missing — only
  // "adminapikey" / "apikeysid" matched exact forms, so config.apiKey could
  // leak into publicConfig for custom adapters.
  "apikey",
  "apikeysid",
  "apitoken",
  "apisecret",
  "accesstoken",
  "authtoken",
  "authusername",
  "bearertoken",
  "clientsecret",
  "cookie",
  "cookies",
  "extraheaders",
  "managementkey",
  "localstorage",
  "password",
  "refreshtoken",
  "secretkey",
  "sessioncookie",
  "sessionstorage",
  "serviceaccountjson",
  "webhooksecret",
]);

const OPAQUE_SECRET_CONTAINER_KEYS = new Set([
  "cookies",
  "localstorage",
  "sessionstorage",
]);

const SECRET_KEY_PATTERN =
  /(?:^|[_-])(authorization|credential|password|private[_-]?key|secret|token)(?:$|[_-])/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizedKey(key: string): string {
  return key.replace(/[_-]/g, "").toLowerCase();
}

function isOpaqueSecretContainerKey(key: string): boolean {
  return OPAQUE_SECRET_CONTAINER_KEYS.has(normalizedKey(key));
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

/** Full server-only adapter configuration, including decrypted secrets. */
export function providerConfigForServer(
  config: unknown,
  encryptedSecretConfig: string | null | undefined
): Record<string, unknown> {
  const split = splitProviderConfig(config);
  return mergeProviderConfig(
    split.publicConfig,
    mergeProviderConfig(
      split.secretConfig,
      decryptProviderSecretConfig(encryptedSecretConfig)
    )
  );
}

/**
 * Fail-closed variant of providerConfigForServer for read paths that must not
 * take down a response when stored config cannot be decrypted: returns null
 * instead of throwing. Hoisted here from the three former per-call-site
 * `serverConfig` copies (api/providers, api/providers/[id], budget-status).
 */
export function providerConfigForServerOrNull(
  config: unknown,
  encryptedSecretConfig: string | null
): Record<string, unknown> | null {
  try {
    return providerConfigForServer(config, encryptedSecretConfig);
  } catch {
    return null;
  }
}

function collectFieldPaths(
  value: Record<string, unknown>,
  prefix = ""
): string[] {
  const fields: string[] = [];
  for (const [key, nested] of Object.entries(value)) {
    // Infisical ownership metadata is server-only. Even its nested field names
    // (sequence/fingerprint/secret name) provide no editing affordance and
    // must not be exposed through secretConfigMeta.
    if (normalizedKey(key) === "infisicalcredential") continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (isRecord(nested) && !isOpaqueSecretContainerKey(key)) {
      fields.push(...collectFieldPaths(nested, path));
    }
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
