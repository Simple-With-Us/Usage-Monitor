import crypto from "node:crypto";
import { Prisma } from "@prisma/client";

/**
 * This classifier intentionally mirrors src/lib/provider-secret-config.ts.
 * A parity test imports both implementations so future key additions cannot
 * silently make the one-time migration disagree with request/API redaction.
 */
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
  "cookie",
  "cookies",
  "extraheaders",
  "managementkey",
  "localstorage",
  "password",
  "refreshtoken",
  "secretkey",
  "serviceaccountjson",
  "sessioncookie",
  "sessionstorage",
  "webhooksecret",
]);

// A past adapter generation persisted browser-session state (cookies,
// localStorage/sessionStorage snapshots) to support browser-session-based
// providers. That material is no longer retained in any form: these keys are
// stripped outright -- from both `config` and an already-encrypted
// `secretConfig` -- rather than merely encrypted.
const LEGACY_BROWSER_STATE_KEYS = new Set([
  "cookie",
  "cookies",
  "localstorage",
  "sessioncookie",
  "sessionstorage",
]);

// Hold opaque blobs of cookie/storage entries; reported as a single field
// path in dry-run/plan output rather than recursed into.
const OPAQUE_SECRET_CONTAINER_KEYS = new Set([
  "cookies",
  "localstorage",
  "sessionstorage",
]);

const SECRET_KEY_PATTERN =
  /(?:^|[_-])(authorization|credential|password|private[_-]?key|secret|token)(?:$|[_-])/i;

const PLAN_VERSION = "provider-secret-migration-v3";

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizedKey(key) {
  return key.replace(/[_-]/g, "").toLowerCase();
}

export function isProviderSecretConfigKey(key) {
  const normalized = normalizedKey(key);
  if (normalized === "publickey") return false;
  return (
    ALWAYS_SECRET_KEYS.has(normalized) ||
    SECRET_KEY_PATTERN.test(key) ||
    /(?:authorization|credential|password|privatekey|secret|token)$/.test(normalized)
  );
}

/**
 * Recursively remove legacy browser-session state. Returns both the cleaned
 * record and the dotted paths that were removed, for scrub reporting.
 */
function stripLegacyBrowserState(input, prefix = "") {
  const cleaned = {};
  const removedPaths = [];
  for (const [key, value] of Object.entries(input)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (LEGACY_BROWSER_STATE_KEYS.has(normalizedKey(key))) {
      removedPaths.push(path);
      continue;
    }
    if (isRecord(value)) {
      const nested = stripLegacyBrowserState(value, path);
      if (Object.keys(nested.cleaned).length > 0) cleaned[key] = nested.cleaned;
      removedPaths.push(...nested.removedPaths);
    } else {
      cleaned[key] = value;
    }
  }
  return { cleaned, removedPaths };
}

function splitRecord(input) {
  const publicConfig = {};
  const secretConfig = {};
  for (const [key, value] of Object.entries(input)) {
    if (isProviderSecretConfigKey(key)) {
      secretConfig[key] = value;
    } else if (isRecord(value)) {
      const nested = splitRecord(value);
      if (Object.keys(nested.publicConfig).length > 0) {
        publicConfig[key] = nested.publicConfig;
      }
      if (Object.keys(nested.secretConfig).length > 0) {
        secretConfig[key] = nested.secretConfig;
      }
    } else {
      publicConfig[key] = value;
    }
  }
  return { publicConfig, secretConfig };
}

function mergeRecords(left, right) {
  const merged = { ...left };
  for (const [key, value] of Object.entries(right)) {
    merged[key] = isRecord(merged[key]) && isRecord(value)
      ? mergeRecords(merged[key], value)
      : value;
  }
  return merged;
}

function collectPaths(input, prefix = "") {
  return Object.entries(input).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return isRecord(value) && !OPAQUE_SECRET_CONTAINER_KEYS.has(normalizedKey(key))
      ? collectPaths(value, path)
      : [path];
  });
}

export function parseProviderSecretEncryptionKey(value) {
  if (!value || !/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error("ENCRYPTION_KEY must be a 64-character hex string when migration is required");
  }
  return Buffer.from(value, "hex");
}

function assertEncryptionKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error("ENCRYPTION_KEY must be a 64-character hex string when migration is required");
  }
}

export function encryptProviderSecretConfig(value, key) {
  assertEncryptionKey(key);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return `v1:${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${ciphertext.toString("hex")}`;
}

export function decryptProviderSecretConfig(envelope, key) {
  assertEncryptionKey(key);
  const [version, ivHex, tagHex, ciphertextHex, ...extra] = envelope.split(":");
  if (version !== "v1" || extra.length > 0 || !ivHex || !tagHex || ciphertextHex == null) {
    throw new Error("unsupported secretConfig envelope");
  }
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivHex, "hex")
  );
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, "hex")),
    decipher.final(),
  ]).toString("utf8");
  const decoded = JSON.parse(plaintext);
  if (!isRecord(decoded)) throw new Error("secretConfig payload is not an object");
  return decoded;
}

async function loadProviders(client) {
  return client.provider.findMany({
    orderBy: { id: "asc" },
    select: { id: true, name: true, config: true, secretConfig: true },
  });
}

/**
 * Compute what would change for one provider. Existing encrypted
 * secretConfig is only inspected when `encryptionKey` is supplied; without
 * one, legacy browser state hiding inside an already-encrypted envelope
 * cannot be previewed (dry run) and is treated as absent rather than as a
 * false candidate. Returns null when the provider needs no changes at all.
 */
function describeCandidate(provider, encryptionKey) {
  const strippedConfig = stripLegacyBrowserState(
    isRecord(provider.config) ? provider.config : {}
  );
  const split = splitRecord(strippedConfig.cleaned);
  const fields = collectPaths(split.secretConfig).sort();

  let strippedExisting = { cleaned: {}, removedPaths: [] };
  if (provider.secretConfig && encryptionKey) {
    const existing = decryptProviderSecretConfig(provider.secretConfig, encryptionKey);
    strippedExisting = stripLegacyBrowserState(existing);
  }

  const scrubPaths = [
    ...strippedConfig.removedPaths,
    ...strippedExisting.removedPaths.map((path) => `secretConfig.${path}`),
  ].sort();

  if (fields.length === 0 && scrubPaths.length === 0) return null;

  return {
    id: provider.id,
    name: provider.name,
    fields,
    scrubPaths,
    publicConfig: split.publicConfig,
    // Already-encrypted values are newer/authoritative. Legacy plaintext is
    // migrated only where the encrypted envelope has no replacement.
    mergedSecrets: mergeRecords(split.secretConfig, strippedExisting.cleaned),
  };
}

/**
 * A provider with any existing secretConfig might hide legacy browser state
 * that only decryption can reveal, so its presence alone requires a key --
 * even before we know whether it will end up an actual candidate. Providers
 * with no secretConfig can be checked from `config` alone.
 */
function needsEncryptionKey(providers) {
  return providers.some(
    (provider) => Boolean(provider.secretConfig) || describeCandidate(provider, undefined) !== null
  );
}

/** Read-only, value-redacted inventory used by CLI dry-runs. */
export async function inspectProviderSecretMigration(client, { encryptionKey } = {}) {
  const providers = await loadProviders(client);
  const candidates = [];
  for (const provider of providers) {
    const candidate = describeCandidate(provider, encryptionKey);
    if (candidate) {
      candidates.push({
        id: candidate.id,
        name: candidate.name,
        fields: candidate.fields,
        scrubPaths: candidate.scrubPaths,
      });
    }
  }

  return {
    providerCount: providers.length,
    candidateCount: candidates.length,
    candidates,
  };
}

/**
 * Build the complete write plan before opening a transaction. Every existing
 * ciphertext is decrypted here, so an unreadable envelope aborts before any
 * row can be committed. A no-candidate plan is intentionally a no-op and does
 * not require an encryption key.
 */
export async function planProviderSecretMigration(client, { encryptionKey } = {}) {
  const providers = await loadProviders(client);
  if (needsEncryptionKey(providers)) assertEncryptionKey(encryptionKey);

  const updates = [];
  for (const provider of providers) {
    const candidate = describeCandidate(provider, encryptionKey);
    if (!candidate) continue;
    updates.push({
      id: candidate.id,
      name: candidate.name,
      fields: candidate.fields,
      scrubPaths: candidate.scrubPaths,
      publicConfig: candidate.publicConfig,
      secretConfig: Object.keys(candidate.mergedSecrets).length > 0
        ? encryptProviderSecretConfig(candidate.mergedSecrets, encryptionKey)
        : null,
    });
  }

  return {
    version: PLAN_VERSION,
    providerCount: providers.length,
    candidateCount: updates.length,
    candidates: updates.map(({ id, name, fields, scrubPaths }) => ({ id, name, fields, scrubPaths })),
    updates,
  };
}

/** Apply a precomputed plan using a Prisma client or caller-owned transaction. */
export async function applyProviderSecretMigration(client, plan) {
  if (plan?.version !== PLAN_VERSION || !Array.isArray(plan.updates)) {
    throw new Error("invalid provider-secret migration plan");
  }
  for (const update of plan.updates) {
    await client.provider.update({
      where: { id: update.id },
      data: {
        config: Object.keys(update.publicConfig).length > 0
          ? update.publicConfig
          : Prisma.JsonNull,
        secretConfig: update.secretConfig,
      },
      select: { id: true },
    });
  }
  return { migrated: plan.updates.length, unchanged: plan.providerCount - plan.candidateCount };
}
