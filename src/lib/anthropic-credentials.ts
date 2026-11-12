import { decrypt } from "@/lib/crypto";
import { canonicalProviderKey } from "@/lib/provider-identity";
import {
  decryptProviderSecretConfig,
  mergeProviderConfig,
  splitProviderConfig,
} from "@/lib/provider-secret-config";

export function isAnthropicAdminApiKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().toLowerCase().startsWith("sk-ant-admin")
  );
}

interface StoredProviderCredentials {
  name: string;
  type?: string | null;
  apiKey?: string | null;
  config?: unknown;
  secretConfig?: string | null;
}

const NO_POLL_SNAPSHOT_PROVIDER_KEYS = new Set([
  "voyage",
  "roic",
  "fmp",
  "finnhub",
  "alphavantage",
  "marketstack",
  "tiingo",
  "massive",
  "fred",
  "quiver-quant",
  "robinhood",
]);

/**
 * Derive Anthropic billing capability without returning credential material.
 * `apiKey` is the encrypted Provider column; config may contain a legacy
 * plaintext admin field while secretConfig is the current encrypted store.
 */
export function hasStoredAnthropicAdminApiKey(
  provider: StoredProviderCredentials
): boolean {
  if (canonicalProviderKey(provider.name) !== "anthropic") return false;

  const legacyConfig = splitProviderConfig(provider.config);
  let encryptedConfig: Record<string, unknown> = {};
  try {
    encryptedConfig = decryptProviderSecretConfig(provider.secretConfig);
  } catch {
    // An unreadable credential cannot be claimed as configured capability.
  }
  const secretConfig = mergeProviderConfig(
    legacyConfig.secretConfig,
    encryptedConfig
  );
  if (isAnthropicAdminApiKey(secretConfig.adminApiKey)) {
    return true;
  }

  if (!provider.apiKey) return false;
  try {
    return isAnthropicAdminApiKey(decrypt(provider.apiKey));
  } catch {
    return false;
  }
}

/**
 * Derive Namecheap API polling capability without returning credential material.
 * Requires an API key (encrypted Provider column, secretConfig, or env),
 * an account username (public/secret config or env), and a valid whitelisted
 * client IP address (public/secret config or env, excluding localhost/127.0.0.1).
 */
export function hasStoredNamecheapCredentials(
  provider: StoredProviderCredentials
): boolean {
  if (canonicalProviderKey(provider.name) !== "namecheap") return false;

  const legacyConfig = splitProviderConfig(provider.config);
  let encryptedConfig: Record<string, unknown> = {};
  try {
    encryptedConfig = decryptProviderSecretConfig(provider.secretConfig);
  } catch {
    // An unreadable credential cannot be claimed as configured capability.
  }
  const secretConfig = mergeProviderConfig(
    legacyConfig.secretConfig,
    encryptedConfig
  );
  const publicConfig = legacyConfig.publicConfig;

  let hasApiKey = false;
  if (provider.apiKey) {
    try {
      const decrypted = decrypt(provider.apiKey).trim();
      if (decrypted) hasApiKey = true;
    } catch {
      hasApiKey = false;
    }
  }
  if (!hasApiKey && typeof secretConfig.apiKey === "string" && secretConfig.apiKey.trim()) {
    hasApiKey = true;
  }
  if (!hasApiKey && typeof process.env.NAMECHEAP_API_KEY === "string" && process.env.NAMECHEAP_API_KEY.trim()) {
    hasApiKey = true;
  }

  const rawUser =
    (publicConfig.apiUser as string | undefined) ||
    (publicConfig.userName as string | undefined) ||
    (publicConfig.username as string | undefined) ||
    (secretConfig.apiUser as string | undefined) ||
    (secretConfig.userName as string | undefined) ||
    (secretConfig.username as string | undefined) ||
    process.env.NAMECHEAP_API_USER ||
    process.env.NAMECHEAP_USER_NAME ||
    "";
  const hasUser = typeof rawUser === "string" && Boolean(rawUser.trim());

  const rawIp =
    (publicConfig.clientIp as string | undefined) ||
    (publicConfig.clientIP as string | undefined) ||
    (secretConfig.clientIp as string | undefined) ||
    (secretConfig.clientIP as string | undefined) ||
    process.env.NAMECHEAP_CLIENT_IP ||
    "";
  const trimmedIp = typeof rawIp === "string" ? rawIp.trim() : "";
  const hasIp =
    Boolean(trimmedIp) &&
    trimmedIp !== "127.0.0.1" &&
    trimmedIp !== "localhost";

  return hasApiKey && hasUser && hasIp;
}

export function providerPollSnapshotExpected(
  provider: StoredProviderCredentials
): boolean {
  const providerType = provider.type?.trim().toLowerCase();
  if (providerType === "generic" || providerType === "push") return false;
  if (providerType === "custom") return true;

  const providerKey = canonicalProviderKey(provider.name);
  if (NO_POLL_SNAPSHOT_PROVIDER_KEYS.has(providerKey)) return false;

  if (providerKey === "anthropic") {
    return hasStoredAnthropicAdminApiKey(provider);
  }

  if (providerKey === "namecheap") {
    return hasStoredNamecheapCredentials(provider);
  }

  return true;
}

