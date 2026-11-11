#!/usr/bin/env node
/**
 * Move credential-shaped values out of Provider.config into the encrypted
 * Provider.secretConfig envelope, and scrub legacy browser-session state
 * (cookies, localStorage/sessionStorage snapshots) that a past adapter
 * generation persisted but is no longer retained in any form.
 *
 * Safe default: report only. Pass --apply to write. Values and ciphertext are
 * never printed. Apply planning decrypts every candidate before opening one
 * transaction, so a bad envelope cannot cause a partial migration.
 *
 * Keep the key classifier synchronized with src/lib/provider-secret-config.ts.
 */
import { createPrismaClient } from "./lib/create-prisma-client.mjs";
import {
  applyProviderSecretMigration,
  inspectProviderSecretMigration,
  parseProviderSecretEncryptionKey,
  planProviderSecretMigration,
} from "./lib/provider-secret-migration.mjs";

const args = new Set(process.argv.slice(2));
if (args.has("--help")) {
  console.log("Usage: node scripts/migrate-provider-config-secrets.mjs [--apply]");
  process.exit(0);
}
for (const arg of args) {
  if (arg !== "--apply") throw new Error(`Unknown argument: ${arg}`);
}

const apply = args.has("--apply");

// Only parse/require ENCRYPTION_KEY when it is actually set, so a database
// with nothing to migrate never needs one -- whether run as a dry run or
// with --apply. If a key IS required for real work, the planner enforces
// that itself with a clear error.
function readEncryptionKeyFromEnv() {
  const raw = process.env.ENCRYPTION_KEY;
  return raw ? parseProviderSecretEncryptionKey(raw) : undefined;
}

function describeActions(candidate) {
  return [
    candidate.fields.length ? `encrypt ${candidate.fields.join(", ")}` : null,
    candidate.scrubPaths.length ? `scrub ${candidate.scrubPaths.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join("; ");
}

const prisma = createPrismaClient();

try {
  if (!apply) {
    // Opportunistically preview browser-state scrubbing buried inside an
    // already-encrypted secretConfig when a usable key happens to be present
    // in the environment; a dry run never requires one.
    let previewKey;
    try {
      previewKey = readEncryptionKeyFromEnv();
    } catch {
      previewKey = undefined;
    }
    const inspection = await inspectProviderSecretMigration(prisma, { encryptionKey: previewKey });
    for (const candidate of inspection.candidates) {
      console.log(`would process: ${candidate.name} [${describeActions(candidate)}]`);
    }
    console.log(
      `DRY RUN: ${inspection.candidateCount} provider(s) need migration; rerun with --apply after backup verification`
    );
  } else {
    const encryptionKey = readEncryptionKeyFromEnv();
    const plan = await planProviderSecretMigration(prisma, { encryptionKey });
    for (const candidate of plan.candidates) {
      console.log(`process: ${candidate.name} [${describeActions(candidate)}]`);
    }
    const result = await prisma.$transaction(
      (tx) => applyProviderSecretMigration(tx, plan),
      { timeout: 300_000 }
    );
    console.log(
      `provider secret migration: ${result.migrated} migrated, 0 failed, ${result.unchanged} unchanged`
    );
  }
} finally {
  await prisma.$disconnect();
}
