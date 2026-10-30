import test from "node:test";
import assert from "node:assert/strict";
import { buildStoredClaudeDuplicatePlan, applyStoredClaudeDuplicatePlan } from "../lib/claude-duplicate-stored-plan.mjs";
import { mkdtemp, writeFile, chmod, symlink, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProtectedCleanupFile, readProtectedCleanupJson, readProtectedCleanupJsonHandle, verifyProtectedSqliteBackup } from "../lib/protected-cleanup-file.mjs";

const proof = { idempotencyKey: "duplicate", keeperIdempotencyKey: "keeper", label: "token:output", model: "claude-test", quantity: 20,
  occurredAt: "2026-10-29T12:00:01.000Z", keeperOccurredAt: "2026-10-29T12:00:00.000Z", sourceProofHash: "source-sha", messageProofHash: "message-sha" };
const row = (key, changes = {}) => ({ id: key, idempotencyKey: key, sourceApp: "claude-code", provider: "anthropic", service: "claude-code", metricType: "usage", unit: "token", label: "token:output", quantity: 20, keyRef: "claude-test", costUsd: null, requests: null, credits: null, limit: null, billingMode: "estimated", confidence: "estimated", projectId: "project-one", environment: "production", occurredAt: key === "keeper" ? proof.keeperOccurredAt : proof.occurredAt, metadata: { collector: "transcript", model: "claude-test", "host.name": "test-host" }, ...changes });
function client(rows) {
  let records = rows;
  const calls = [];
  const db = {
    externalUsageEvent: {
      findMany: async ({ where }) => structuredClone(records.filter((row) => where.idempotencyKey.in.includes(row.idempotencyKey))),
      deleteMany: async ({ where }) => { calls.push("delete"); const count = records.filter((row) => where.id.in.includes(row.id)).length; records = records.filter((row) => !where.id.in.includes(row.id)); return { count }; },
    },
    externalUsageEventTombstone: { createMany: async () => { calls.push("tombstone"); } },
    $executeRawUnsafe: async () => calls.push("writer-lock"),
    $transaction: async (fn) => fn(db), calls,
  };
  return db;
}
test("only exact stored candidate and keeper identities qualify", async () => {
  const db = client([row("duplicate"), row("keeper"), row("unrelated")]);
  const plan = await buildStoredClaudeDuplicatePlan(db, [proof]);
  assert.equal(plan.approved.length, 1);
  const result = await applyStoredClaudeDuplicatePlan(db, plan, { reviewedDigest: plan.digest, backupDigest: plan.digest });
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
    await assert.rejects(applyStoredClaudeDuplicatePlan(db, plan, { reviewedDigest: plan.digest, backupDigest: plan.digest }), /changed after review/);
    assert.deepEqual(db.calls, ["writer-lock"]);
  }
});
test("missing backup/review digest or changed source proof prevents writes", async () => {
  const db = client([row("duplicate"), row("keeper")]);
  const plan = await buildStoredClaudeDuplicatePlan(db, [proof]);
  await assert.rejects(applyStoredClaudeDuplicatePlan(db, plan), /digest required/);
  plan.approved[0].proof = { ...proof, sourceProofHash: "changed" };
  await assert.rejects(applyStoredClaudeDuplicatePlan(db, plan, { reviewedDigest: plan.digest, backupDigest: plan.digest }), /digest required/);
  assert.deepEqual(db.calls, []);
});
test("tampering with backed-up deletion IDs cannot redirect the reviewed deletion", async () => {
  const db = client([row("duplicate"), row("keeper")]);
  const plan = await buildStoredClaudeDuplicatePlan(db, [proof]);
  plan.approved[0].row = { ...plan.approved[0].row, id: "keeper" };
  await assert.rejects(applyStoredClaudeDuplicatePlan(db, plan, { reviewedDigest: plan.digest, backupDigest: plan.digest }), /backup row differs/);
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
    await symlink(backup, link);
    await assert.rejects(verifyProtectedSqliteBackup(link));
    await assert.rejects(verifyProtectedSqliteBackup(backup, backup), /separate from the live/);
    await verifyProtectedSqliteBackup(backup);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
