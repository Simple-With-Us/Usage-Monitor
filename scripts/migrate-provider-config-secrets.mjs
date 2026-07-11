#!/usr/bin/env node
/**
 * Move credential-shaped values out of Provider.config into the encrypted
 * Provider.secretConfig envelope.
 *
 * Safe default: report only. Pass --apply to write. Values and ciphertext are
 * never printed. Run only after `prisma db push` has added secretConfig.
 *
 * Keep the key classifier synchronized with src/lib/provider-secret-config.ts.
 */
import crypto from "node:crypto";
import { PrismaClient, Prisma } from "@prisma/client";

const args = new Set(process.argv.slice(2));
if (args.has("--help")) {
  console.log("Usage: node scripts/migrate-provider-config-secrets.mjs [--apply]");
  process.exit(0);
}
for (const arg of args) {
  if (arg !== "--apply") throw new Error(`Unknown argument: ${arg}`);
}

const apply = args.has("--apply");
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

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSecretKey(key) {
  const normalized = key.replace(/[_-]/g, "").toLowerCase();
  if (normalized === "publickey") return false;
  return ALWAYS_SECRET_KEYS.has(normalized) || SECRET_KEY_PATTERN.test(key) ||
    /(?:authorization|credential|password|privatekey|secret|token)$/.test(normalized);
}

function splitRecord(input) {
  const publicConfig = {};
  const secretConfig = {};
  for (const [key, value] of Object.entries(input)) {
    if (isSecretKey(key)) {
      secretConfig[key] = value;
    } else if (isRecord(value)) {
      const nested = splitRecord(value);
      if (Object.keys(nested.publicConfig).length) publicConfig[key] = nested.publicConfig;
      if (Object.keys(nested.secretConfig).length) secretConfig[key] = nested.secretConfig;
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

function encryptionKey() {
  const key = process.env.ENCRYPTION_KEY;
  if (!key || !/^[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("ENCRYPTION_KEY must be a 64-character hex string for --apply");
  }
  return Buffer.from(key, "hex");
}

function encryptJson(value) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return `v1:${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${ciphertext.toString("hex")}`;
}

function decryptJson(envelope) {
  const [version, ivHex, tagHex, ciphertextHex, ...extra] = envelope.split(":");
  if (version !== "v1" || extra.length || !ivHex || !tagHex || ciphertextHex == null) {
    throw new Error("unsupported secretConfig envelope");
  }
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(ivHex, "hex")
  );
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, "hex")),
    decipher.final(),
  ]).toString("utf8");
  const value = JSON.parse(plaintext);
  if (!isRecord(value)) throw new Error("secretConfig payload is not an object");
  return value;
}

const prisma = new PrismaClient();
let candidates = 0;
let migrated = 0;
let failed = 0;

try {
  const providers = await prisma.provider.findMany({
    select: { id: true, name: true, config: true, secretConfig: true },
  });

  for (const provider of providers) {
    const split = splitRecord(isRecord(provider.config) ? provider.config : {});
    const fields = collectPaths(split.secretConfig).sort();
    if (fields.length === 0) continue;
    candidates++;
    console.log(`${apply ? "migrate" : "would migrate"}: ${provider.name} [${fields.join(", ")}]`);

    if (!apply) continue;
    try {
      const existing = provider.secretConfig ? decryptJson(provider.secretConfig) : {};
      const merged = mergeRecords(existing, split.secretConfig);
      await prisma.provider.update({
        where: { id: provider.id },
        data: {
          config: Object.keys(split.publicConfig).length
            ? split.publicConfig
            : Prisma.JsonNull,
          secretConfig: encryptJson(merged),
        },
      });
      migrated++;
    } catch (error) {
      failed++;
      console.error(`failed: ${provider.name}: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  console.log(
    apply
      ? `provider secret migration: ${migrated} migrated, ${failed} failed, ${providers.length - candidates} unchanged`
      : `DRY RUN: ${candidates} provider(s) need migration; rerun with --apply after backup verification`
  );
  if (failed) process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
