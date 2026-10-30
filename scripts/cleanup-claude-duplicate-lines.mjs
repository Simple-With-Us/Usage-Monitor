import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { createPrismaClient } from "./lib/create-prisma-client.mjs";
import { buildStoredClaudeDuplicatePlan, applyStoredClaudeDuplicatePlan, storedPlanDigest, fingerprint } from "./lib/claude-duplicate-stored-plan.mjs";
import { readProtectedCleanupJson, verifyProtectedSqliteBackup } from "./lib/protected-cleanup-file.mjs";

async function main() {
const args = process.argv.slice(2);
const value = (flag) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
const apply = args.includes("--apply");
const inventory = args.includes("--inventory");
const input = value(apply ? "--stored-plan" : "--proof-manifest");
let parsed;
if (!inventory) {
  if (!input) throw new Error("Explicit protected input file required");
  parsed = await readProtectedCleanupJson(input);
}
if (inventory && apply) throw new Error("Inventory cannot be combined with apply");
if (apply && (!args.includes("--full-backup-verified") || !value("--full-backup-path") || !value("--reviewed-digest"))) {
  throw new Error("Apply requires explicit verified full database backup path and reviewed digest");
}
if (apply) {
  const backupPath = resolve(value("--full-backup-path"));
  const livePath = process.env.DATABASE_URL?.replace(/^file:/, "").split("?")[0];
  await verifyProtectedSqliteBackup(backupPath, livePath ? resolve(livePath) : undefined);
}
const prisma = createPrismaClient();
try {
  if (args.includes("--litestream-wal-owner-verified")) {
    // Connection-local policy: do not checkpoint the live replica owner's WAL.
    await prisma.$queryRawUnsafe("PRAGMA wal_autocheckpoint = 0");
  }
  if (inventory) {
    const raw = await prisma.externalUsageEvent.aggregate({ where: { sourceApp: "claude-code", metricType: "usage", unit: "token" }, _count: { _all: true }, _min: { occurredAt: true }, _max: { occurredAt: true } });
    const rollups = await prisma.externalUsageEventDailyRollup.aggregate({ where: { sourceApp: "claude-code", metricType: "usage", unit: "token" }, _count: { _all: true }, _min: { day: true }, _max: { day: true } });
    console.log(JSON.stringify({ mode: "inventory", raw, rollups }));
  } else if (!apply) {
    if (parsed.version !== 1 || !Array.isArray(parsed.candidates) || parsed.candidates.length > 500_000) throw new Error("Unsupported proof manifest");
    const otherInputs = args.flatMap((arg, index) => arg === "--proof-manifest" ? [args[index + 1]] : []).slice(1);
    const manifests = [parsed];
    for (const path of otherInputs) {
      const next = await readProtectedCleanupJson(path);
      if (next.version !== 1 || !Array.isArray(next.candidates)) throw new Error("Unsupported additional host manifest");
      manifests.push(next);
    }
    const proofs = manifests.flatMap((manifest) => manifest.candidates);
    if (proofs.length > 1_000_000) throw new Error("Combined proof limit exceeded");
    const plan = await buildStoredClaudeDuplicatePlan(prisma, proofs);
    const output = value("--plan-output");
    if (!output) throw new Error("Dry-run requires a protected --plan-output backup file");
    const handle = await open(output, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify({ ...plan, sourceManifestHashes: manifests.map(fingerprint) })); await handle.sync(); }
    finally { await handle.close(); }
    console.log(JSON.stringify({ mode: "dry-run", matchedCandidates: plan.approved.length, skipped: plan.skipped, reviewedDigest: plan.digest }));
  } else {
    if (!Array.isArray(parsed.approved) || storedPlanDigest(parsed.approved) !== parsed.digest) throw new Error("Stored plan hash mismatch");
    // This exact protected plan includes complete candidate and keeper backups.
    const result = await applyStoredClaudeDuplicatePlan(prisma, parsed, { reviewedDigest: value("--reviewed-digest"), backupDigest: parsed.digest });
    console.log(JSON.stringify({ mode: "apply", ...result }));
  }
} finally { await prisma.$disconnect(); }
}

main().catch((error) => {
  const errorName = /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error?.name ?? "") ? error.name : "Error";
  console.error(JSON.stringify({ phase: "cleanup-maintenance", errorName }));
  process.exitCode = 1;
});
