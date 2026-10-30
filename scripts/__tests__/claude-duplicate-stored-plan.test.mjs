import test from "node:test";
import assert from "node:assert/strict";
import { buildStoredClaudeDuplicatePlan, applyStoredClaudeDuplicatePlan, storedPlanDigest, fingerprint } from "../lib/claude-duplicate-stored-plan.mjs";
import { mkdtemp, writeFile, chmod, symlink, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { openProtectedCleanupFile, readProtectedCleanupJson, readProtectedCleanupJsonHandle, verifyProtectedSqliteBackup } from "../lib/protected-cleanup-file.mjs";
import { writeStoredCleanupShards, readReviewedCleanupIndex, readReviewedCleanupShard, writePrivateCleanupJson, validateReviewedCleanupShards } from "../lib/stored-cleanup-artifacts.mjs";
import { cleanupFailureDiagnostic } from "../lib/cleanup-diagnostics.mjs";

const proof = { idempotencyKey: "duplicate", keeperIdempotencyKey: "keeper", label: "token:output", model: "claude-test", quantity: 20,
  occurredAt: "2026-10-29T12:00:01.000Z", keeperOccurredAt: "2026-10-29T12:00:00.000Z", sourceProofHash: "source-sha", messageProofHash: "message-sha" };
const verified = (plan) => ({ reviewedDigest: plan.digest, backupDigest: "a".repeat(64), reviewedBackupDigest: "a".repeat(64) });
const row = (key, changes = {}) => ({ id: key, idempotencyKey: key, sourceApp: "claude-code", provider: "anthropic", service: "claude-code", metricType: "usage", unit: "token", label: "token:output", quantity: 20, keyRef: "claude-test", costUsd: null, requests: null, credits: null, limit: null, billingMode: "estimated", confidence: "estimated", projectId: "project-one", environment: "production", occurredAt: key === "keeper" ? proof.keeperOccurredAt : proof.occurredAt, metadata: { collector: "transcript", model: "claude-test", "host.name": "test-host" }, ...changes });
function client(rows) {
  let records = rows;
  const calls = [];
  const db = {
    externalUsageEvent: {
      findMany: async ({ where }) => structuredClone(records.filter((row) => where.idempotencyKey.in.includes(row.idempotencyKey))),
      deleteMany: async ({ where }) => { calls.push("delete"); const count = records.filter((row) => where.id.in.includes(row.id)).length; records = records.filter((row) => !where.id.in.includes(row.id)); return { count }; },
    },
    externalUsageEventTombstone: { createMany: async () => { calls.push("tombstone"); }, findMany: async () => [] },
    $executeRaw: async () => calls.push("writer-lock"),
    $transaction: async (fn) => fn(db), calls,
  };
  return db;
}
test("only exact stored candidate and keeper identities qualify", async () => {
  const db = client([row("duplicate"), row("keeper"), row("unrelated")]);
  const plan = await buildStoredClaudeDuplicatePlan(db, [proof]);
  assert.equal(plan.approved.length, 1);
  const result = await applyStoredClaudeDuplicatePlan(db, plan, verified(plan));
  assert.equal(result.deleted, 1);
  assert.deepEqual(db.calls, ["writer-lock", "tombstone", "delete"]);
  const remaining = await db.externalUsageEvent.findMany({ where: { idempotencyKey: { in: ["keeper", "unrelated"] } } });
  assert.equal(remaining.length, 2);
});
test("missing keeper and different project preserve the candidate", async () => {
  const noKeeper = await buildStoredClaudeDuplicatePlan(client([row("duplicate")]), [proof]);
  assert.equal(noKeeper.skipped.keeperAbsent, 1);
  const wrongProject = await buildStoredClaudeDuplicatePlan(client([row("duplicate"), row("keeper", { projectId: "other" })]), [proof]);
  assert.equal(wrongProject.skipped.mismatch, 1);
});
test("cash, changed quantities, attribution and native rows fail open", async () => {
  for (const change of [{ costUsd: 1 }, { quantity: 19 }, { provider: "other" }, { environment: "other" }, { confidence: "actual" }, { metadata: { collector: "native", model: "claude-test" } }]) {
    const plan = await buildStoredClaudeDuplicatePlan(client([row("duplicate", change), row("keeper")]), [proof]);
    assert.equal(plan.approved.length, 0);
  }
});
test("a changed row or keeper after review aborts before any tombstone/delete", async () => {
  for (const changed of ["duplicate", "keeper"]) {
    const records = [row("duplicate"), row("keeper")];
    const db = client(records);
    const plan = await buildStoredClaudeDuplicatePlan(db, [proof]);
    records.find((record) => record.id === changed).quantity = 21;
    await assert.rejects(applyStoredClaudeDuplicatePlan(db, plan, verified(plan)), /changed after review/);
    assert.deepEqual(db.calls, ["writer-lock"]);
  }
});
test("missing backup/review digest or changed source proof prevents writes", async () => {
  const db = client([row("duplicate"), row("keeper")]);
  const plan = await buildStoredClaudeDuplicatePlan(db, [proof]);
  await assert.rejects(applyStoredClaudeDuplicatePlan(db, plan), /digest required/);
  plan.approved[0].proof = { ...proof, sourceProofHash: "changed" };
  await assert.rejects(applyStoredClaudeDuplicatePlan(db, plan, verified(plan)), /digest required/);
  assert.deepEqual(db.calls, []);
});
test("tampering with backed-up deletion IDs cannot redirect the reviewed deletion", async () => {
  const db = client([row("duplicate"), row("keeper")]);
  const plan = await buildStoredClaudeDuplicatePlan(db, [proof]);
  plan.approved[0].row = { ...plan.approved[0].row, id: "keeper" };
  await assert.rejects(applyStoredClaudeDuplicatePlan(db, plan, verified(plan)), /backup row differs/);
  assert.deepEqual(db.calls, []);
});
test("cross-host identity collisions and keeper dependencies preserve rows", async () => {
  const db = client([row("duplicate"), row("keeper")]);
  const conflicting = await buildStoredClaudeDuplicatePlan(db, [proof, { ...proof, messageProofHash: "different-call" }]);
  assert.equal(conflicting.approved.length, 0);
  assert.equal(conflicting.skipped.proofConflicts, 1);
  const dependency = await buildStoredClaudeDuplicatePlan(db, [proof, { ...proof, idempotencyKey: "other", keeperIdempotencyKey: "duplicate" }]);
  assert.equal(dependency.approved.length, 0);
  assert.equal(dependency.skipped.keeperDependencies, 1);
});
test("protected input rejects symlinks, non-private modes and oversized files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cleanup-protected-file-"));
  try {
    const path = join(directory, "plan.json"), link = join(directory, "link.json");
    await writeFile(path, '{"approved":[]}', { mode: 0o600 });
    await symlink(path, link);
    await assert.rejects(readProtectedCleanupJson(link));
    await assert.rejects(openProtectedCleanupFile(path, { maxBytes: 4 }), /size limit/);
    await chmod(path, 0o644);
    await assert.rejects(readProtectedCleanupJson(path), /mode600/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("replacing the checked pathname cannot redirect an open descriptor read", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cleanup-path-swap-"));
  const path = join(directory, "plan.json");
  try {
    await writeFile(path, '{"original":true}', { mode: 0o600 });
    const file = await openProtectedCleanupFile(path);
    try {
      await rename(path, join(directory, "original.json"));
      await writeFile(path, '{"attacker":true}', { mode: 0o600 });
      try { assert.deepEqual(await readProtectedCleanupJsonHandle(file), { original: true }); }
      catch (error) { assert.match(error.message, /changed while being read/); }
    } finally { await file.handle.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("backup validation rejects symlinks and the live inode using held descriptors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cleanup-backup-"));
  try {
    const backup = join(directory, "backup.db"), link = join(directory, "backup-link.db");
    await writeFile(backup, Buffer.from("SQLite format 3\u0000"), { mode: 0o600 });
    const expected = createHash("sha256").update(Buffer.from("SQLite format 3\u0000")).digest("hex");
    await symlink(backup, link);
    await assert.rejects(verifyProtectedSqliteBackup(link, undefined, expected));
    await assert.rejects(verifyProtectedSqliteBackup(backup, backup, expected), /separate from the live/);
    await assert.rejects(verifyProtectedSqliteBackup(backup, link, expected), /separate from the live/);
    const live = join(directory, "live.db"), liveLink = join(directory, "live-link.db");
    await writeFile(live, Buffer.from("SQLite format 3\u0000"));
    await symlink(live, liveLink);
    assert.equal(await verifyProtectedSqliteBackup(backup, liveLink, expected), expected);
    assert.equal(await verifyProtectedSqliteBackup(backup, undefined, expected), expected);
    await assert.rejects(verifyProtectedSqliteBackup(backup, undefined, "f".repeat(64)), /checksum differs/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("unsupported ownership platforms fail explicitly instead of skipping UID validation", async () => {
  const original = process.getuid;
  try {
    process.getuid = undefined;
    await assert.rejects(readProtectedCleanupJson("unused.json"), (error) => error.name === "UnsupportedPlatformError");
  } finally { process.getuid = original; }
});
test("CLI failures disclose only the fixed phase and error name", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cleanup-safe-failure-"));
  try {
    const path = join(directory, "private-plan.json");
    await writeFile(path, "sensitive-plan-payload", { mode: 0o600 });
    const maintenance = spawnSync(process.execPath, [fileURLToPath(new URL("../cleanup-claude-duplicate-lines.mjs", import.meta.url)), "--proof-manifest", path], { encoding: "utf8" });
    assert.equal(maintenance.status, 1);
    assert.deepEqual(JSON.parse(maintenance.stderr), { phase: "cleanup-maintenance", errorName: "Error", operation: "read-proof" });
    const source = spawnSync(process.execPath, [fileURLToPath(new URL("../plan-claude-duplicate-cleanup.mjs", import.meta.url)), "--claude-home", directory, "--manifest", path, "--since", "sensitive-invalid-date"], { encoding: "utf8" });
    assert.equal(source.status, 1);
    assert.deepEqual(JSON.parse(source.stderr), { phase: "cleanup-source-plan", errorName: "Error" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("CLI reports only bounded database codes and operation while withholding private error data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cleanup-coded-failure-"));
  try {
    const preload = join(directory, "inject.mjs");
    await writeFile(preload, `process.getuid = () => { const error = new Error("private SQL parameter and transcript path"); error.name = "PrismaClientKnownRequestError"; error.code = "P2028"; error.meta = { private: "private SQL parameter and transcript path", driverAdapterError: { cause: { originalCode: "SQLITE_BUSY_SNAPSHOT", message: "private SQL parameter and transcript path" } } }; throw error; };`);
    const cli = fileURLToPath(new URL("../cleanup-claude-duplicate-lines.mjs", import.meta.url));
    const result = spawnSync(process.execPath, ["--import", preload, cli, "--proof-manifest", join(directory, "private-plan.json")], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stderr), { phase: "cleanup-maintenance", errorName: "PrismaClientKnownRequestError", operation: "read-proof", prismaCode: "P2028", sqliteCode: "SQLITE_BUSY_SNAPSHOT" });
    assert.equal((result.stderr + result.stdout).includes("private SQL"), false);
    assert.equal((result.stderr + result.stdout).includes(directory), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("transaction failure identifies the exact safe operation and shard without altering writes", async () => {
  const db = client([row("duplicate"), row("keeper")]);
  const plan = await buildStoredClaudeDuplicatePlan(db, [proof]);
  db.externalUsageEventTombstone.createMany = async () => { throw Object.assign(new Error("private row payload"), { name: "PrismaClientKnownRequestError", code: "P2002", meta: { private: "private row payload" } }); };
  const context = { operation: "apply-shard", shardOrdinal: 1628 };
  await assert.rejects(applyStoredClaudeDuplicatePlan(db, plan, { ...verified(plan), onOperation: (name) => { context.operation = name; } }), (error) => {
    assert.deepEqual(cleanupFailureDiagnostic(error, context), { phase: "cleanup-maintenance", errorName: "PrismaClientKnownRequestError", operation: "write-tombstones", shardOrdinal: 1628, prismaCode: "P2002" });
    return true;
  });
  assert.deepEqual(db.calls, ["writer-lock"]);
});
test("unrecognized code names and diagnostic context never pass through", () => {
  assert.deepEqual(cleanupFailureDiagnostic({ name: "PrivateProject", code: "P2028 private payload", cause: { code: "SQLITE_BUSY_PRIVATE_PAYLOAD" }, meta: { driverAdapterError: { cause: { originalCode: "SQLITE_PRIVATE_PAYLOAD" } } } }, { operation: "private-path", shardOrdinal: "private-row" }), { phase: "cleanup-maintenance", errorName: "Error", operation: "arguments" });
});
test("CLI preserves primary database diagnostics when disconnect also fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cleanup-dual-failure-"));
  try {
    const cli = fileURLToPath(new URL("../cleanup-claude-duplicate-lines.mjs", import.meta.url));
    for (const primaryFails of [true, false]) {
      const preload = join(directory, "inject-" + primaryFails + ".mjs");
      const replacement = `export function createPrismaClient() { const primary = Object.assign(new Error("private primary SQL"), { name: "PrismaClientKnownRequestError", code: "P2028" }); const secondary = Object.assign(new Error("private disconnect SQL"), { name: "PrismaClientKnownRequestError", code: "P2002" }); return { externalUsageEvent: { aggregate: async () => { if (${primaryFails}) throw primary; return {}; } }, externalUsageEventDailyRollup: { aggregate: async () => ({}) }, $disconnect: async () => { throw secondary; } }; }`;
      await writeFile(preload, `import { registerHooks } from "node:module"; registerHooks({ load(url, context, nextLoad) { if (url.endsWith("/scripts/lib/create-prisma-client.mjs")) return { format: "module", shortCircuit: true, source: ${JSON.stringify(replacement)} }; return nextLoad(url, context); } });`);
      const result = spawnSync(process.execPath, ["--import", preload, cli, "--inventory"], { encoding: "utf8" });
      assert.equal(result.status, 1);
      assert.deepEqual(JSON.parse(result.stderr), { phase: "cleanup-maintenance", errorName: "PrismaClientKnownRequestError", operation: primaryFails ? "inventory" : "disconnect", prismaCode: primaryFails ? "P2028" : "P2002" });
      assert.equal((result.stderr + result.stdout).includes("private"), false);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("historical tombstones are counted as uncertain history without changing rollups", async () => {
  const db = client([row("keeper")]);
  db.externalUsageEventTombstone.findMany = async () => [{ idempotencyKey: "duplicate", occurredAt: proof.occurredAt }];
  const plan = await buildStoredClaudeDuplicatePlan(db, [proof]);
  assert.equal(plan.approved.length, 0);
  assert.equal(plan.skipped.compactedOrPreviouslyPruned, 1);
  assert.deepEqual(plan.historicalTombstoneQuantities, { "token:output": 20 });
  assert.deepEqual(db.calls, []);
});
test("protected shards bind their own digests and counts to a separately reviewed index", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cleanup-reviewed-shards-"));
  try {
    const plan = await buildStoredClaudeDuplicatePlan(client([row("duplicate"), row("keeper")]), [proof]);
    const path = join(directory, "index.json");
    const written = await writeStoredCleanupShards(path, plan, ["f".repeat(64)]);
    const index = await readReviewedCleanupIndex(path, written.sha256);
    assert.equal((await validateReviewedCleanupShards(path, index)).candidatesValidated, 1);
    assert.equal(index.totalCandidates, 1);
    assert.equal(index.shards[0].count, 1);
    assert.equal((await readReviewedCleanupShard(path, index, index.shards[0])).digest, index.shards[0].reviewedDigest);
    await assert.rejects(readReviewedCleanupIndex(path, "a".repeat(64)), /independently reviewed/);
    await writeFile(join(directory, index.shards[0].name), '{"tampered":true}', { mode: 0o600 });
    await assert.rejects(readReviewedCleanupShard(path, index, index.shards[0]), /differs from reviewed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("global preflight rejects cross-shard keeper deletion even with internally valid shard digests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cleanup-cross-shard-"));
  try {
    const plan = await buildStoredClaudeDuplicatePlan(client([row("duplicate"), row("keeper")]), [proof]);
    const secondRow = row("keeper"), third = row("third");
    const entries = [plan.approved[0], { proof: { ...proof, idempotencyKey: "keeper", keeperIdempotencyKey: "third" }, row: secondRow, keeper: third, rowFingerprint: fingerprint(secondRow), keeperFingerprint: fingerprint(third) }];
    const master = storedPlanDigest(entries), shards = [];
    for (let i = 0; i < entries.length; i++) {
      const name = "shard-" + i + ".json", reviewedDigest = storedPlanDigest([entries[i]]);
      const written = await writePrivateCleanupJson(join(directory, name), { version: 1, parentDigest: master, approved: [entries[i]], digest: reviewedDigest });
      shards.push({ name, count: 1, reviewedDigest, ...written });
    }
    const index = { version: 1, kind: "claude-duplicate-cleanup-index", planDigest: master, sourceManifestHashes: ["f".repeat(64)], totalCandidates: 2, shards };
    const path = join(directory, "index.json"), written = await writePrivateCleanupJson(path, index);
    const reviewed = await readReviewedCleanupIndex(path, written.sha256);
    await assert.rejects(validateReviewedCleanupShards(path, reviewed), /keeper dependency/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("reviewed index cannot traverse paths or change global keeper dependencies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cleanup-shard-path-"));
  try {
    const plan = await buildStoredClaudeDuplicatePlan(client([row("duplicate"), row("keeper")]), [proof]);
    const path = join(directory, "index.json");
    const written = await writeStoredCleanupShards(path, plan, ["f".repeat(64)]);
    const changed = { ...written.index, shards: [{ ...written.index.shards[0], name: "../escape.json" }] };
    const invalidPath = join(directory, "invalid-index.json");
    const invalid = await writePrivateCleanupJson(invalidPath, changed);
    await assert.rejects(readReviewedCleanupIndex(invalidPath, invalid.sha256), /shard reference/);
    await assert.rejects(writeStoredCleanupShards(join(directory, "too-large-index.json"), plan, ["f".repeat(64)], { shardSize: 101 }), /one transaction/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
