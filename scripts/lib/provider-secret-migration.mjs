import crypto from "node:crypto";
import { Prisma } from "@prisma/client";

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

const PLAN_VERSION = "provider-secret-migration-v2";

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * This classifier intentionally mirrors src/lib/provider-secret-config.ts.
 * A parity test imports both implementations so future key additions cannot
 * silently make the one-time migration disagree with request/API redaction.
 */
export function isProviderSecretConfigKey(key) {
  const normalized = key.replace(/[_-]/g, "").toLowerCase();
  if (normalized === "publickey") return false;
  return (
    ALWAYS_SECRET_KEYS.has(normalized) ||
    SECRET_KEY_PATTERN.test(key) ||
    /(?:authorization|credential|password|privatekey|secret|token)$/.test(normalized)
  );
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
    return isRecord(value) ? collectPaths(value, path) : [path];
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
    throw new Error("provider-secret migration requires a 32-byte encryption key");
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

async function loadCandidates(client) {
  const providers = await client.provider.findMany({
    orderBy: { id: "asc" },
    select: { id: true, name: true, config: true, secretConfig: true },
  });
  const candidates = [];
  for (const provider of providers) {
    const split = splitRecord(isRecord(provider.config) ? provider.config : {});
    const fields = collectPaths(split.secretConfig).sort();
    if (fields.length === 0) continue;
    candidates.push({ provider, split, fields });
  }
  return { providers, candidates };
}

/** Read-only, value-redacted inventory used by CLI dry-runs. */
export async function inspectProviderSecretMigration(client) {
  const loaded = await loadCandidates(client);
  return {
    providerCount: loaded.providers.length,
    candidateCount: loaded.candidates.length,
    candidates: loaded.candidates.map(({ provider, fields }) => ({
      id: provider.id,
      name: provider.name,
      fields,
    })),
  };
}

/**
 * Build the complete write plan before opening a transaction. Every existing
 * ciphertext is decrypted here, so an unreadable provider aborts before any
 * row can be committed. The encrypted envelope is authoritative over stale
 * legacy plaintext when both contain the same nested key.
 */
export async function planProviderSecretMigration(client, { encryptionKey } = {}) {
  const loaded = await loadCandidates(client);
  if (loaded.candidates.length === 0) {
    return {
      version: PLAN_VERSION,
      providerCount: loaded.providers.length,
      candidateCount: 0,
      candidates: [],
      updates: [],
    };
  }

  assertEncryptionKey(encryptionKey);
  const updates = loaded.candidates.map(({ provider, split, fields }) => {
    const encryptedSecrets = provider.secretConfig
      ? decryptProviderSecretConfig(provider.secretConfig, encryptionKey)
      : {};
    // Legacy plaintext is the fallback; an already-encrypted value wins.
    const mergedSecrets = mergeRecords(split.secretConfig, encryptedSecrets);
    return {
      id: provider.id,
      name: provider.name,
      fields,
      publicConfig: split.publicConfig,
      secretConfig: encryptProviderSecretConfig(mergedSecrets, encryptionKey),
    };
  });

  return {
    version: PLAN_VERSION,
    providerCount: loaded.providers.length,
    candidateCount: updates.length,
    candidates: updates.map(({ id, name, fields }) => ({ id, name, fields })),
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
