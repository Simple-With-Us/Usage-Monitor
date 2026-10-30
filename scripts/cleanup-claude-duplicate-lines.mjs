import { resolve } from "node:path";
import { createPrismaClient } from "./lib/create-prisma-client.mjs";
import { buildStoredClaudeDuplicatePlan, applyStoredClaudeDuplicatePlan, verifyAppliedStoredClaudePlan } from "./lib/claude-duplicate-stored-plan.mjs";
import { readProtectedCleanupJson, verifyProtectedSqliteBackup } from "./lib/protected-cleanup-file.mjs";
import { writePrivateCleanupJson, writeCleanupProgress, writeStoredCleanupShards, readReviewedCleanupIndex, readReviewedCleanupShard, validateReviewedCleanupShards } from "./lib/stored-cleanup-artifacts.mjs";

async function main() {
  const args = process.argv.slice(2);
  const value = (flag) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
  const apply = args.includes("--apply"), verify = args.includes("--verify"), inventory = args.includes("--inventory");
  const indexed = Boolean(value("--stored-plan-index"));
  if ((inventory && (apply || verify)) || (apply && verify) || (verify && !indexed)) throw new Error("Incompatible cleanup modes");
  if (apply && !indexed) throw new Error("Apply requires a reviewed shard index");
  const input = value(indexed ? "--stored-plan-index" : "--proof-manifest");
  let parsed, inputReceipt, index;
  if (!inventory) {
    if (!input) throw new Error("Explicit protected input file required");
    if (indexed) {
      index = await readReviewedCleanupIndex(input, value("--reviewed-index-digest"));
      await validateReviewedCleanupShards(input, index, { onProgress: (state) => writeCleanupProgress(input + ".progress.json", state) });
    }
    else { inputReceipt = await readProtectedCleanupJson(input, { withDigest: true }); parsed = inputReceipt.value; }
  }
  if (apply && (!args.includes("--full-backup-verified") || !value("--full-backup-path") || !value("--full-backup-sha256") || !value("--reviewed-index-digest"))) throw new Error("Apply requires independently reviewed plan and full backup digests");
  let backupDigest;
  if (apply) {
    const livePath = process.env.DATABASE_URL?.replace(/^file:/, "").split("?")[0];
    backupDigest = await verifyProtectedSqliteBackup(resolve(value("--full-backup-path")), livePath ? resolve(livePath) : undefined, value("--full-backup-sha256"));
  }
  const prisma = createPrismaClient();
  try {
    if (args.includes("--litestream-wal-owner-verified")) await prisma.$queryRaw`PRAGMA wal_autocheckpoint = 0`;
    if (inventory) {
      const raw = await prisma.externalUsageEvent.aggregate({ where: { sourceApp: "claude-code", metricType: "usage", unit: "token" }, _count: { _all: true }, _min: { occurredAt: true }, _max: { occurredAt: true } });
      const rollups = await prisma.externalUsageEventDailyRollup.aggregate({ where: { sourceApp: "claude-code", metricType: "usage", unit: "token" }, _count: { _all: true }, _min: { day: true }, _max: { day: true } });
      console.log(JSON.stringify({ mode: "inventory", raw, rollups }));
    } else if (indexed) {
      const indexDigest = value("--reviewed-index-digest");
      const totals = { confirmedDeleted: 0, deletedThisRun: 0, resumedFromReceipts: 0, shardsVerified: 0, candidatesRemaining: 0, matchingTombstones: 0, keeperChecksFailed: 0, missingReceipts: 0 };
      for (let ordinal = 0; ordinal < index.shards.length; ordinal++) {
        const entry = index.shards[ordinal];
        const plan = await readReviewedCleanupShard(input, index, entry);
        const receiptPath = input + ".receipt-" + String(ordinal + 1).padStart(6, "0") + ".json";
        let receipt, check;
        try { receipt = await readProtectedCleanupJson(receiptPath); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        if (receipt && (receipt.indexDigest !== indexDigest || receipt.shardSha256 !== entry.sha256 || receipt.reviewedDigest !== entry.reviewedDigest || receipt.deleted !== entry.count || !/^[a-f0-9]{64}$/.test(receipt.backupDigest ?? "") || (apply && receipt.backupDigest !== backupDigest))) throw new Error("Cleanup receipt does not match the reviewed shard");
        if (apply && !receipt) {
          const result = await applyStoredClaudeDuplicatePlan(prisma, plan, { reviewedDigest: entry.reviewedDigest, backupDigest, reviewedBackupDigest: value("--full-backup-sha256") });
          if (result.deleted !== entry.count) throw new Error("Shard deletion count differs from reviewed count");
          check = await verifyAppliedStoredClaudePlan(prisma, plan);
          if (!check.verified) throw new Error("Committed shard did not pass exact verification");
          receipt = { indexDigest, shardSha256: entry.sha256, reviewedDigest: entry.reviewedDigest, backupDigest, deleted: result.deleted };
          await writePrivateCleanupJson(receiptPath, receipt);
          totals.deletedThisRun += result.deleted;
        } else if (receipt) totals.resumedFromReceipts += receipt.deleted;
        else totals.missingReceipts++;
        check ??= await verifyAppliedStoredClaudePlan(prisma, plan);
        totals.candidatesRemaining += check.candidatesRemaining;
        totals.matchingTombstones += check.matchingTombstones;
        totals.keeperChecksFailed += check.keeperChecksFailed;
        if (check.verified && receipt) { totals.confirmedDeleted += entry.count; totals.shardsVerified++; }
        else if (apply) throw new Error("Previously receipted shard no longer matches database state");
        if ((ordinal + 1) % 50 === 0) await writeCleanupProgress(input + ".progress.json", { phase: apply ? "applying-shards" : "verifying-shards", ...totals, expectedCandidates: index.totalCandidates });
      }
      const verified = totals.confirmedDeleted === index.totalCandidates && totals.shardsVerified === index.shards.length;
      console.log(JSON.stringify({ mode: apply ? "apply" : "verify", verified, expectedCandidates: index.totalCandidates, ...totals, reviewedIndexDigest: indexDigest }));
      if (!verified) process.exitCode = 1;
    } else if (!apply) {
      const output = value("--plan-output");
      if (!output) throw new Error("Dry-run requires a protected plan output path");
      const progress = (state) => writeCleanupProgress(output + ".progress.json", state);
      await progress({ phase: "reading-proofs", manifestsRead: 1 });
      if (parsed.version !== 1 || !Array.isArray(parsed.candidates) || parsed.candidates.length > 500_000) throw new Error("Unsupported proof manifest");
      const manifests = [parsed], sourceManifestHashes = [inputReceipt.sha256];
      const otherInputs = args.flatMap((arg, position) => arg === "--proof-manifest" ? [args[position + 1]] : []).slice(1);
      for (const path of otherInputs) {
        const next = await readProtectedCleanupJson(path, { withDigest: true });
        if (next.value.version !== 1 || !Array.isArray(next.value.candidates)) throw new Error("Unsupported additional host manifest");
        manifests.push(next.value); sourceManifestHashes.push(next.sha256);
      }
      const proofs = manifests.flatMap((manifest) => manifest.candidates);
      if (proofs.length > 1_000_000) throw new Error("Combined proof limit exceeded");
      await progress({ phase: "normalizing-proofs", sourceProofs: proofs.length });
      const plan = await buildStoredClaudeDuplicatePlan(prisma, proofs, { onProgress: progress });
      for (const manifest of manifests) manifest.candidates = [];
      proofs.length = 0; parsed = undefined;
      await progress({ phase: "writing-plan-shards", matchedCandidates: plan.approved.length, skipped: plan.skipped });
      const result = await writeStoredCleanupShards(output, plan, sourceManifestHashes, { onProgress: progress });
      await progress({ phase: "dry-run-complete", matchedCandidates: plan.approved.length, shards: result.index.shards.length, indexSha256: result.sha256 });
      console.log(JSON.stringify({ mode: "dry-run", matchedCandidates: plan.approved.length, skipped: plan.skipped, historicalTombstoneQuantities: plan.historicalTombstoneQuantities,
        reviewedPlanDigest: plan.digest, reviewedIndexDigest: result.sha256, indexBytes: result.bytes, shards: result.index.shards.length, largestShardBytes: Math.max(0, ...result.index.shards.map((entry) => entry.bytes)) }));
    }
  } finally { await prisma.$disconnect(); }
}

main().catch((error) => {
  const errorName = /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error?.name ?? "") ? error.name : "Error";
  console.error(JSON.stringify({ phase: "cleanup-maintenance", errorName }));
  process.exitCode = 1;
});
