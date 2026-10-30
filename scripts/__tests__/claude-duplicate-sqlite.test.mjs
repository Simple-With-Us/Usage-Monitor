import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrismaClient } from "../lib/create-prisma-client.mjs";
import { buildStoredClaudeDuplicatePlan, applyStoredClaudeDuplicatePlan } from "../lib/claude-duplicate-stored-plan.mjs";

test("real SQLite deletes exact duplicates with tombstones and rolls back on tombstone collision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-cleanup-test-"));
  const db = createPrismaClient({ databaseUrl: "file:" + join(directory, "test.db") });
  try {
    const schema = await readFile(new URL("../../prisma/schema.prisma", import.meta.url), "utf8");
    const model = /model ExternalUsageEvent \{([\s\S]*?)\n\}/.exec(schema)[1];
    const types = { String: "TEXT", Int: "INTEGER", Float: "REAL", DateTime: "DATETIME", Json: "JSON" };
    const columns = [...model.matchAll(/^\s+(\w+)\s+(String|Int|Float|DateTime|Json)\??\s/gm)].map(([, name, type]) => `"${name}" ${types[type]}${name === "id" ? " PRIMARY KEY" : name === "idempotencyKey" ? " UNIQUE" : ""}`);
    await db.$executeRawUnsafe(`CREATE TABLE "ExternalUsageEvent" (${columns.join(",")})`);
    await db.$executeRawUnsafe('CREATE TABLE "ExternalUsageEventTombstone" ("idempotencyKey" TEXT PRIMARY KEY, "occurredAt" DATETIME NOT NULL, "prunedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)');
    const base = { sourceApp: "claude-code", provider: "anthropic", service: "claude-code", metricType: "usage", unit: "token", label: "token:output", quantity: 20, keyRef: "claude-test", billingMode: "estimated", confidence: "estimated", metadata: { collector: "transcript", model: "claude-test" } };
    const proof = { idempotencyKey: "duplicate", keeperIdempotencyKey: "keeper", label: base.label, model: base.keyRef, quantity: 20, occurredAt: "2026-10-29T12:00:01.000Z", keeperOccurredAt: "2026-10-29T12:00:00.000Z" };
    await db.externalUsageEvent.create({ data: { ...base, idempotencyKey: "keeper", occurredAt: new Date(proof.keeperOccurredAt) } });
    await db.externalUsageEvent.create({ data: { ...base, idempotencyKey: "duplicate", occurredAt: new Date(proof.occurredAt) } });
    const plan = await buildStoredClaudeDuplicatePlan(db, [proof]);
    assert.equal(plan.approved.length, 1);
    await applyStoredClaudeDuplicatePlan(db, plan, { reviewedDigest: plan.digest, backupDigest: plan.digest });
    assert.equal(await db.externalUsageEvent.count(), 1);
    assert.equal(await db.externalUsageEventTombstone.count(), 1);
    await db.externalUsageEvent.create({ data: { ...base, idempotencyKey: "collision", occurredAt: new Date(proof.occurredAt) } });
    await db.externalUsageEventTombstone.create({ data: { idempotencyKey: "collision", occurredAt: new Date(proof.occurredAt) } });
    const collision = await buildStoredClaudeDuplicatePlan(db, [{ ...proof, idempotencyKey: "collision" }]);
    await assert.rejects(applyStoredClaudeDuplicatePlan(db, collision, { reviewedDigest: collision.digest, backupDigest: collision.digest }));
    assert.equal(await db.externalUsageEvent.count(), 2);
  } finally { await db.$disconnect(); await rm(directory, { recursive: true, force: true }); }
});
