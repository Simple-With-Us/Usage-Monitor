import { createHash } from "node:crypto";

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value instanceof Date) return value.toISOString();
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}
export const fingerprint = (row) => createHash("sha256").update(JSON.stringify(stable(row ?? null))).digest("hex");
export function createStoredPlanDigest() {
  const hash = createHash("sha256").update("[");
  let first = true;
  return { add({ proof, rowFingerprint, keeperFingerprint }) {
    if (!first) hash.update(",");
    first = false; hash.update(JSON.stringify(stable({ proof, rowFingerprint, keeperFingerprint })));
  }, finish() { return hash.update("]").digest("hex"); } };
}
export const storedPlanDigest = (approved) => { const hash = createStoredPlanDigest(); approved.forEach((entry) => hash.add(entry)); return hash.finish(); };

function mergeHostProofs(proofs) {
  const groups = new Map(), requiredKeepers = new Set();
  for (const proof of proofs) {
    requiredKeepers.add(proof.keeperIdempotencyKey);
    const entries = groups.get(proof.idempotencyKey) ?? [];
    entries.push(proof); groups.set(proof.idempotencyKey, entries);
  }
  const normalized = [], skipped = { proofConflicts: 0, keeperDependencies: 0 };
  for (const [key, entries] of groups) {
    if (requiredKeepers.has(key)) { skipped.keeperDependencies++; continue; }
    const semantic = ({ sourceProofHash, keeperSourceProofHash, ...proof }) => proof;
    if (new Set(entries.map((proof) => fingerprint(semantic(proof)))).size !== 1) { skipped.proofConflicts++; continue; }
    normalized.push({ ...entries[0], sourceEvidence: entries.map(({ sourceProofHash, keeperSourceProofHash }) => ({ sourceProofHash, keeperSourceProofHash })) });
  }
  return { normalized, skipped };
}

function matches(row, proof, keeper = false) {
  return row && row.sourceApp === "claude-code" && row.provider === "anthropic" &&
    row.service === "claude-code" && row.metricType === "usage" && row.unit === "token" &&
    row.label === proof.label && row.quantity === proof.quantity && row.costUsd == null &&
    row.requests == null && row.credits == null && row.limit == null &&
    row.providerRequestId == null && row.verifiedCostUsd == null && row.verifiedAt == null &&
    row.verificationStatus == null && row.verifiedSource == null &&
    row.windowStart == null && row.windowEnd == null && row.limitWindow == null && row.tier == null &&
    row.billingMode === "estimated" && row.confidence === "estimated" &&
    row.keyRef === proof.model && row.metadata?.model === proof.model &&
    row.metadata?.collector === "transcript" &&
    new Date(row.occurredAt).toISOString() === (keeper ? proof.keeperOccurredAt : proof.occurredAt);
}

export async function buildStoredClaudeDuplicatePlan(client, proofs, { onProgress = async () => {} } = {}) {
  const merged = mergeHostProofs(proofs);
  proofs = merged.normalized;
  const approved = [], skipped = { absent: 0, keeperAbsent: 0, mismatch: 0, compactedOrPreviouslyPruned: 0, ...merged.skipped };
  const historicalTombstoneQuantities = {};
  await onProgress({ phase: "proofs-normalized", normalizedProofs: proofs.length, matchedCandidates: 0 });
  const seen = new Set();
  for (let offset = 0; offset < proofs.length; offset += 200) {
    const batch = proofs.slice(offset, offset + 200);
    const keys = [...new Set(batch.flatMap((proof) => [proof.idempotencyKey, proof.keeperIdempotencyKey]))];
    const rows = await client.externalUsageEvent.findMany({ where: { idempotencyKey: { in: keys } } });
    const byKey = new Map(rows.map((row) => [row.idempotencyKey, row]));
    const missingKeys = batch.filter((proof) => !byKey.has(proof.idempotencyKey)).map((proof) => proof.idempotencyKey);
    const tombstones = missingKeys.length ? await client.externalUsageEventTombstone.findMany({ where: { idempotencyKey: { in: missingKeys } }, select: { idempotencyKey: true, occurredAt: true } }) : [];
    const pruned = new Map(tombstones.map((row) => [row.idempotencyKey, row]));
    for (const proof of batch) {
      if (seen.has(proof.idempotencyKey)) throw new Error("Duplicate candidate identity in proof manifest");
      seen.add(proof.idempotencyKey);
      if (proof.idempotencyKey === proof.keeperIdempotencyKey) throw new Error("Candidate is its own keeper");
      const row = byKey.get(proof.idempotencyKey), keeper = byKey.get(proof.keeperIdempotencyKey);
      if (!row) {
        skipped.absent++;
        const tombstone = pruned.get(proof.idempotencyKey);
        if (tombstone && new Date(tombstone.occurredAt).toISOString() === proof.occurredAt) {
          skipped.compactedOrPreviouslyPruned++;
          historicalTombstoneQuantities[proof.label] = (historicalTombstoneQuantities[proof.label] ?? 0) + proof.quantity;
        }
        continue;
      }
      if (!keeper) { skipped.keeperAbsent++; continue; }
      if (!matches(row, proof) || !matches(keeper, proof, true) ||
        row.projectId !== keeper.projectId || row.environment !== keeper.environment ||
        ["host.name", "project", "project.name", "projectName", "_producerInstanceId"].some((key) =>
          row.metadata?.[key] !== keeper.metadata?.[key])) { skipped.mismatch++; continue; }
      approved.push({ proof, row, keeper, rowFingerprint: fingerprint(row), keeperFingerprint: fingerprint(keeper) });
    }
    if ((offset + 200) % 1000 === 0 || offset + 200 >= proofs.length) {
      await onProgress({ phase: "matching-proofs", processedProofs: Math.min(offset + 200, proofs.length), normalizedProofs: proofs.length, matchedCandidates: approved.length, skipped: { ...skipped } });
    }
  }
  const deleted = new Set(approved.map(({ row }) => row.idempotencyKey));
  if (approved.some(({ keeper }) => deleted.has(keeper.idempotencyKey))) throw new Error("Plan would delete a required keeper");
  return { approved, skipped, historicalTombstoneQuantities, digest: storedPlanDigest(approved) };
}

/** Caller must persist a protected backup and verify its digest before calling. */
export async function applyStoredClaudeDuplicatePlan(client, plan, { reviewedDigest, backupDigest, reviewedBackupDigest } = {}) {
  if (plan.digest !== storedPlanDigest(plan.approved) || plan.digest !== reviewedDigest ||
    !/^[a-f0-9]{64}$/.test(backupDigest ?? "") || backupDigest !== reviewedBackupDigest) throw new Error("Reviewed plan and verified backup digest required");
  if (plan.approved.some((entry) => fingerprint(entry.row) !== entry.rowFingerprint || fingerprint(entry.keeper) !== entry.keeperFingerprint)) {
    throw new Error("Stored backup row differs from its reviewed fingerprint");
  }
  let deleted = 0;
  for (let offset = 0; offset < plan.approved.length; offset += 100) {
    const batch = plan.approved.slice(offset, offset + 100);
    await client.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE "ExternalUsageEvent" SET "quantity" = "quantity" WHERE "id" = ${batch[0].row.id}`;
      const keys = [...new Set(batch.flatMap(({ row, keeper }) => [row.idempotencyKey, keeper.idempotencyKey]))];
      const current = await tx.externalUsageEvent.findMany({ where: { idempotencyKey: { in: keys } } });
      const byKey = new Map(current.map((row) => [row.idempotencyKey, row]));
      for (const entry of batch) {
        if (fingerprint(byKey.get(entry.row.idempotencyKey)) !== entry.rowFingerprint ||
          fingerprint(byKey.get(entry.keeper.idempotencyKey)) !== entry.keeperFingerprint) {
          throw new Error("Candidate or keeper changed after review; remaining cleanup aborted");
        }
      }
      await tx.externalUsageEventTombstone.createMany({ data: batch.map(({ row }) => ({ idempotencyKey: row.idempotencyKey, occurredAt: row.occurredAt })) });
      const result = await tx.externalUsageEvent.deleteMany({ where: { id: { in: batch.map(({ row }) => row.id) } } });
      if (result.count !== batch.length) throw new Error("Exact deletion count mismatch");
    }, { timeout: 10_000 });
    deleted += batch.length;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return { deleted, tombstonesWritten: deleted, keepersPreserved: plan.approved.length };
}

export async function verifyAppliedStoredClaudePlan(client, plan) {
  let candidatesRemaining = 0, matchingTombstones = 0, keeperChecksFailed = 0;
  for (let offset = 0; offset < plan.approved.length; offset += 100) {
    const batch = plan.approved.slice(offset, offset + 100);
    const keys = [...new Set(batch.flatMap(({ row, keeper }) => [row.idempotencyKey, keeper.idempotencyKey]))];
    const rows = await client.externalUsageEvent.findMany({ where: { idempotencyKey: { in: keys } } });
    const byKey = new Map(rows.map((row) => [row.idempotencyKey, row]));
    const tombstones = await client.externalUsageEventTombstone.findMany({ where: { idempotencyKey: { in: batch.map(({ row }) => row.idempotencyKey) } }, select: { idempotencyKey: true, occurredAt: true } });
    const pruned = new Map(tombstones.map((row) => [row.idempotencyKey, row]));
    for (const entry of batch) {
      if (byKey.has(entry.row.idempotencyKey)) candidatesRemaining++;
      const tombstone = pruned.get(entry.row.idempotencyKey);
      if (tombstone && new Date(tombstone.occurredAt).toISOString() === new Date(entry.row.occurredAt).toISOString()) matchingTombstones++;
      if (fingerprint(byKey.get(entry.keeper.idempotencyKey)) !== entry.keeperFingerprint) keeperChecksFailed++;
    }
  }
  return { verified: candidatesRemaining === 0 && matchingTombstones === plan.approved.length && keeperChecksFailed === 0,
    candidatesRemaining, matchingTombstones, keeperChecksFailed };
}
