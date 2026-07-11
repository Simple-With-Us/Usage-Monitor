#!/usr/bin/env node
/**
 * Move credential-shaped values out of Provider.config into the encrypted
 * Provider.secretConfig envelope.
 *
 * Safe default: report only. Pass --apply to write. Values and ciphertext are
 * never printed. Apply planning decrypts every candidate before opening one
 * transaction, so a bad envelope cannot cause a partial migration.
 */
import { PrismaClient } from "@prisma/client";
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
const prisma = new PrismaClient();

try {
  if (!apply) {
    const inspection = await inspectProviderSecretMigration(prisma);
    for (const candidate of inspection.candidates) {
      console.log(`would migrate: ${candidate.name} [${candidate.fields.join(", ")}]`);
    }
    console.log(
      `DRY RUN: ${inspection.candidateCount} provider(s) need migration; rerun with --apply after backup verification`
    );
  } else {
    // A no-candidate production plan is intentionally a no-op and does not
    // require decrypting or generating a key.
    const inspection = await inspectProviderSecretMigration(prisma);
    const encryptionKey = inspection.candidateCount > 0
      ? parseProviderSecretEncryptionKey(process.env.ENCRYPTION_KEY)
      : undefined;
    const plan = await planProviderSecretMigration(prisma, { encryptionKey });
    for (const candidate of plan.candidates) {
      console.log(`migrate: ${candidate.name} [${candidate.fields.join(", ")}]`);
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
