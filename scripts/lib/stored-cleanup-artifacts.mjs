import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, basename, join } from "node:path";
import { createHash } from "node:crypto";
import { storedPlanDigest, createStoredPlanDigest, fingerprint } from "./claude-duplicate-stored-plan.mjs";
import { readProtectedCleanupJson } from "./protected-cleanup-file.mjs";

const MAX_BYTES = 256 * 1024 * 1024;
const digest = (value) => /^[a-f0-9]{64}$/.test(value ?? "");

export async function writePrivateCleanupJson(path, value) {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > MAX_BYTES) throw new Error("Protected cleanup artifact exceeds the size bound");
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
  return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

export async function writeCleanupProgress(path, value) {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.uid !== process.getuid()) throw new Error("Unsafe cleanup progress file");
    await handle.truncate(0);
    await handle.writeFile(JSON.stringify(value));
  } finally { await handle.close(); }
}

export async function writeStoredCleanupShards(indexPath, plan, sourceManifestHashes, { shardSize = 100, onProgress = async () => {} } = {}) {
  if (!Number.isSafeInteger(shardSize) || shardSize < 1 || shardSize > 100) throw new Error("Each cleanup shard must fit one transaction");
  if (storedPlanDigest(plan.approved) !== plan.digest || !Array.isArray(sourceManifestHashes) || sourceManifestHashes.length < 1 || sourceManifestHashes.length > 8 || !sourceManifestHashes.every(digest)) throw new Error("Unverified global plan or source digest");
  const deletionKeys = new Set(plan.approved.map(({ row }) => row.idempotencyKey));
  if (deletionKeys.size !== plan.approved.length || plan.approved.some(({ keeper }) => deletionKeys.has(keeper.idempotencyKey))) throw new Error("Global keeper dependency or duplicate candidate");
  const shards = [];
  for (let offset = 0; offset < plan.approved.length; offset += shardSize) {
    const approved = plan.approved.slice(offset, offset + shardSize);
    const name = basename(indexPath) + ".shard-" + String(shards.length + 1).padStart(6, "0") + ".json";
    const reviewedDigest = storedPlanDigest(approved);
    const file = await writePrivateCleanupJson(join(dirname(indexPath), name), { version: 1, parentDigest: plan.digest, approved, digest: reviewedDigest });
    shards.push({ name, count: approved.length, reviewedDigest, ...file });
    if (shards.length % 50 === 0) await onProgress({ phase: "writing-plan-shards", shardsWritten: shards.length, candidatesWritten: offset + approved.length, matchedCandidates: plan.approved.length });
  }
  const index = { version: 1, kind: "claude-duplicate-cleanup-index", planDigest: plan.digest, sourceManifestHashes,
    totalCandidates: plan.approved.length, skipped: plan.skipped, historicalTombstoneQuantities: plan.historicalTombstoneQuantities, shards };
  const file = await writePrivateCleanupJson(indexPath, index);
  return { index, ...file };
}

export async function readReviewedCleanupIndex(path, expectedDigest) {
  const file = await readProtectedCleanupJson(path, { withDigest: true });
  if (!digest(expectedDigest) || file.sha256 !== expectedDigest) throw new Error("Cleanup index differs from independently reviewed digest");
  const index = file.value;
  if (index.version !== 1 || index.kind !== "claude-duplicate-cleanup-index" || !digest(index.planDigest) ||
    !Array.isArray(index.shards) || index.shards.length > 10_000 || !Array.isArray(index.sourceManifestHashes) || index.sourceManifestHashes.length < 1 || index.sourceManifestHashes.length > 8 || !index.sourceManifestHashes.every(digest)) throw new Error("Unsupported cleanup index");
  let total = 0;
  const names = new Set();
  for (const shard of index.shards) {
    if (!/^[A-Za-z0-9._-]+$/.test(shard.name ?? "") || shard.name === "." || shard.name === ".." ||
      names.has(shard.name) || !Number.isSafeInteger(shard.count) || shard.count < 1 || shard.count > 100 ||
      !Number.isSafeInteger(shard.bytes) || shard.bytes < 1 || shard.bytes > MAX_BYTES ||
      !digest(shard.reviewedDigest) || !digest(shard.sha256)) throw new Error("Invalid cleanup shard reference");
    names.add(shard.name); total += shard.count;
  }
  if (total !== index.totalCandidates) throw new Error("Cleanup index count mismatch");
  return index;
}

export async function readReviewedCleanupShard(indexPath, index, entry) {
  const file = await readProtectedCleanupJson(join(dirname(indexPath), entry.name), { withDigest: true });
  const plan = file.value;
  if (file.sha256 !== entry.sha256 || file.bytes !== entry.bytes || plan.version !== 1 || plan.parentDigest !== index.planDigest ||
    !Array.isArray(plan.approved) || plan.approved.length !== entry.count || plan.digest !== entry.reviewedDigest ||
    storedPlanDigest(plan.approved) !== entry.reviewedDigest) throw new Error("Cleanup shard differs from reviewed index");
  return plan;
}

export async function validateReviewedCleanupShards(indexPath, index, { onProgress = async () => {} } = {}) {
  const candidates = new Set(), keepers = new Set(), hash = createStoredPlanDigest();
  let count = 0;
  for (const entry of index.shards) {
    const shard = await readReviewedCleanupShard(indexPath, index, entry);
    for (const approved of shard.approved) {
      if (fingerprint(approved.row) !== approved.rowFingerprint || fingerprint(approved.keeper) !== approved.keeperFingerprint ||
        candidates.has(approved.row.idempotencyKey) || keepers.has(approved.row.idempotencyKey) || candidates.has(approved.keeper.idempotencyKey) || approved.row.idempotencyKey === approved.keeper.idempotencyKey) throw new Error("Global reviewed shard proof or keeper dependency mismatch");
      candidates.add(approved.row.idempotencyKey); keepers.add(approved.keeper.idempotencyKey); hash.add(approved); count++;
    }
    if (count % 5000 === 0) await onProgress({ phase: "validating-plan-shards", candidatesValidated: count, expectedCandidates: index.totalCandidates });
  }
  if (count !== index.totalCandidates || hash.finish() !== index.planDigest) throw new Error("Reviewed shards do not reconstruct the globally reviewed plan");
  return { candidatesValidated: count, keeperIdentities: keepers.size };
}
