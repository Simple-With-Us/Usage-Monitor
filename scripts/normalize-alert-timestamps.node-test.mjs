import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { createPrismaClient } from "./lib/create-prisma-client.mjs";
import { normalizeAlertTimestamps } from "./normalize-alert-timestamps.mjs";

const scriptPath = new URL("./normalize-alert-timestamps.mjs", import.meta.url);
const epochMs = 1_790_000_000_123;
const date = new Date(epochMs);
const isoDate = date.toISOString().replace("Z", "+00:00");

function createFixtureSchema(db) {
  db.exec(`
    CREATE TABLE Provider (
      id TEXT PRIMARY KEY,
      alertConfigGeneration INTEGER NOT NULL
    );
    CREATE TABLE ProviderAlertNotification (
      id TEXT PRIMARY KEY,
      providerId TEXT NOT NULL,
      stateKey TEXT NOT NULL UNIQUE,
      alertCode TEXT NOT NULL,
      severity TEXT NOT NULL,
      providerName TEXT NOT NULL,
      providerDisplayName TEXT NOT NULL,
      message TEXT NOT NULL,
      firstDetectedAt DATETIME NOT NULL,
      lastDetectedAt DATETIME NOT NULL,
      incidentGeneration INTEGER NOT NULL,
      evidenceWatermarkAt DATETIME,
      evidenceSourceAt DATETIME,
      evidenceWatermarkState TEXT NOT NULL,
      evidenceConfigGeneration INTEGER NOT NULL,
      pagerDutyAuditState TEXT NOT NULL,
      operationClaimToken TEXT,
      operationClaimGeneration INTEGER NOT NULL,
      operationClaimExpiresAt DATETIME,
      operationClaimIncidentGeneration INTEGER,
      operationClaimConfigGeneration INTEGER,
      operationClaimEvidenceSourceAt DATETIME,
      operationClaimEvidenceAt DATETIME,
      operationClaimEvidenceState TEXT,
      lastSentAt DATETIME,
      sendCount INTEGER NOT NULL,
      resolvedAt DATETIME,
      createdAt DATETIME NOT NULL,
      updatedAt DATETIME NOT NULL,
      FOREIGN KEY (providerId) REFERENCES Provider(id)
    );
    CREATE TABLE ProviderAlertChannelDelivery (
      id TEXT PRIMARY KEY,
      notificationId TEXT NOT NULL,
      channelKey TEXT NOT NULL,
      channelKind TEXT NOT NULL,
      lastAttemptAt DATETIME,
      lastSucceededAt DATETIME,
      triggerClaimToken TEXT,
      triggerClaimGeneration INTEGER NOT NULL,
      triggerClaimExpiresAt DATETIME,
      triggerIncidentGeneration INTEGER,
      triggerOperationClaimGeneration INTEGER,
      lastSucceededIncidentGeneration INTEGER,
      pagerDutyDedupKey TEXT,
      attemptCount INTEGER NOT NULL,
      successCount INTEGER NOT NULL,
      resolveClaimToken TEXT,
      resolveClaimGeneration INTEGER NOT NULL,
      resolveClaimExpiresAt DATETIME,
      resolveIncidentGeneration INTEGER,
      resolveOperationClaimGeneration INTEGER,
      lastResolveAttemptAt DATETIME,
      lastResolvedAt DATETIME,
      lastResolvedIncidentGeneration INTEGER,
      resolveAttemptCount INTEGER NOT NULL,
      lastResolveError TEXT,
      lastError TEXT,
      createdAt DATETIME NOT NULL,
      updatedAt DATETIME NOT NULL,
      UNIQUE (notificationId, channelKey),
      FOREIGN KEY (notificationId) REFERENCES ProviderAlertNotification(id)
    );
    CREATE TABLE ExternalUsageEvent (
      id TEXT PRIMARY KEY,
      occurredAt DATETIME NOT NULL
    );
  `);
}

function insertNotification(
  db,
  {
    id = "notification-1",
    stateKey = "provider-1:spend_anomaly",
    resolvedAt = epochMs,
  } = {}
) {
  db.prepare(
    `INSERT OR IGNORE INTO Provider (id, alertConfigGeneration) VALUES ('provider-1', 7)`
  ).run();
  db.prepare(
    `INSERT INTO ProviderAlertNotification (
       id, providerId, stateKey, alertCode, severity, providerName,
       providerDisplayName, message, firstDetectedAt, lastDetectedAt,
       incidentGeneration, evidenceWatermarkAt, evidenceSourceAt,
       evidenceWatermarkState, evidenceConfigGeneration, pagerDutyAuditState,
       operationClaimToken, operationClaimGeneration, operationClaimExpiresAt,
       operationClaimIncidentGeneration, operationClaimConfigGeneration,
       operationClaimEvidenceSourceAt, operationClaimEvidenceAt,
       operationClaimEvidenceState, lastSentAt, sendCount, resolvedAt,
       createdAt, updatedAt
     ) VALUES (
       ?, 'provider-1', ?, 'spend_anomaly', 'critical',
       'provider', 'Provider', 'Protected test message', ?, ?, 3, ?, ?, 'active',
       7, 'generation_scoped', NULL, 12, NULL, 3, NULL, NULL, NULL, NULL,
       ?, 1, ?, ?, ?
     )`
  ).run(
    id,
    stateKey,
    epochMs,
    epochMs,
    epochMs,
    epochMs,
    epochMs,
    resolvedAt,
    epochMs,
    epochMs
  );
}

function insertChannelDelivery(db) {
  db.prepare(
    `INSERT INTO ProviderAlertChannelDelivery (
       id, notificationId, channelKey, channelKind, lastAttemptAt,
       lastSucceededAt, triggerClaimToken, triggerClaimGeneration,
       triggerClaimExpiresAt, triggerIncidentGeneration,
       triggerOperationClaimGeneration, lastSucceededIncidentGeneration,
       pagerDutyDedupKey, attemptCount, successCount, resolveClaimToken,
       resolveClaimGeneration, resolveClaimExpiresAt, resolveIncidentGeneration,
       resolveOperationClaimGeneration, lastResolveAttemptAt, lastResolvedAt,
       lastResolvedIncidentGeneration, resolveAttemptCount, lastResolveError,
       lastError, createdAt, updatedAt
     ) VALUES (
       'delivery-1', 'notification-1', 'channel-1', 'webhook', ?, ?,
       'opaque-test-claim', 4, NULL, 3, 12, 3, 'test-dedup-key', 2, 1,
       NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL, NULL, ?, ?
     )`
  ).run(epochMs, epochMs, epochMs, epochMs);
}

async function withFixture(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "usage-alert-date-repair-"));
  const databasePath = path.join(directory, "fixture.db");
  const db = new Database(databasePath);
  try {
    createFixtureSchema(db);
    await run({ db, databasePath });
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("dry-run, apply, exact Prisma CAS, event range, NULL preservation, and idempotency", async () => {
  await withFixture(async ({ db, databasePath }) => {
    insertNotification(db);
    insertChannelDelivery(db);
    db.prepare(
      `INSERT INTO ExternalUsageEvent (id, occurredAt) VALUES ('event-1', ?)`
    ).run(isoDate);

    const prisma = createPrismaClient({ databaseUrl: `file:${databasePath}` });
    try {
      const eventRangeBefore = await prisma.externalUsageEvent.count({
        where: { occurredAt: { gte: date, lte: date } },
      });
      assert.equal(eventRangeBefore, 1);

      const dryRun = normalizeAlertTimestamps(db);
      assert.equal(dryRun.mode, "dry-run");
      assert.equal(dryRun.rowsWithIntegerDates, 2);
      assert.ok(dryRun.valuesToConvert > 0);
      assert.equal(
        db.prepare("SELECT typeof(resolvedAt) AS kind FROM ProviderAlertNotification").get().kind,
        "integer"
      );

      const rowBefore = await prisma.providerAlertNotification.findUnique({
        where: { stateKey: "provider-1:spend_anomaly" },
        select: {
          id: true,
          incidentGeneration: true,
          resolvedAt: true,
          operationClaimGeneration: true,
          operationClaimToken: true,
          operationClaimExpiresAt: true,
          evidenceConfigGeneration: true,
          evidenceSourceAt: true,
          evidenceWatermarkAt: true,
          evidenceWatermarkState: true,
          severity: true,
          message: true,
          provider: { select: { alertConfigGeneration: true } },
        },
      });
      assert.ok(rowBefore.resolvedAt instanceof Date);
      assert.equal(
        await prisma.providerAlertNotification.count({
          where: {
            id: rowBefore.id,
            incidentGeneration: rowBefore.incidentGeneration,
            resolvedAt: rowBefore.resolvedAt,
            operationClaimGeneration: rowBefore.operationClaimGeneration,
          },
        }),
        0,
        "legacy INTEGER DateTime equality must fail before repair"
      );

      const applied = normalizeAlertTimestamps(db, { apply: true });
      assert.equal(applied.mode, "applied");
      assert.equal(applied.rowsUpdated, 2);
      assert.equal(dryRun.valuesToConvert, 12);
      assert.equal(applied.valuesConverted, 12);

      const preserved = db
        .prepare(
          `SELECT
             typeof(resolvedAt) AS resolvedAtType,
             resolvedAt,
             typeof(operationClaimExpiresAt) AS expiresType,
             operationClaimExpiresAt,
             typeof(operationClaimGeneration) AS generationType,
             operationClaimGeneration,
             operationClaimToken,
             message
           FROM ProviderAlertNotification WHERE id = 'notification-1'`
        )
        .get();
      assert.equal(preserved.resolvedAtType, "text");
      assert.equal(preserved.resolvedAt, isoDate);
      assert.equal(preserved.expiresType, "null");
      assert.equal(preserved.operationClaimExpiresAt, null);
      assert.equal(preserved.generationType, "integer");
      assert.equal(preserved.operationClaimGeneration, 12);
      assert.equal(preserved.operationClaimToken, null);
      assert.equal(preserved.message, "Protected test message");
      const channelPreserved = db
        .prepare(
          `SELECT
             typeof(lastAttemptAt) AS lastAttemptType,
             triggerClaimToken,
             triggerClaimGeneration,
             attemptCount
           FROM ProviderAlertChannelDelivery WHERE id = 'delivery-1'`
        )
        .get();
      assert.equal(channelPreserved.lastAttemptType, "text");
      assert.equal(channelPreserved.triggerClaimToken, "opaque-test-claim");
      assert.equal(channelPreserved.triggerClaimGeneration, 4);
      assert.equal(channelPreserved.attemptCount, 2);

      const rowAfter = await prisma.providerAlertNotification.findUnique({
        where: { stateKey: "provider-1:spend_anomaly" },
        select: {
          id: true,
          incidentGeneration: true,
          resolvedAt: true,
          operationClaimGeneration: true,
          evidenceConfigGeneration: true,
          evidenceSourceAt: true,
          evidenceWatermarkAt: true,
          evidenceWatermarkState: true,
          severity: true,
          message: true,
          provider: { select: { alertConfigGeneration: true } },
        },
      });
      const casCount = await prisma.providerAlertNotification.updateMany({
        where: {
          id: rowAfter.id,
          incidentGeneration: rowAfter.incidentGeneration,
          resolvedAt: rowAfter.resolvedAt,
          operationClaimGeneration: rowAfter.operationClaimGeneration,
          provider: {
            is: { alertConfigGeneration: rowAfter.provider.alertConfigGeneration },
          },
          evidenceConfigGeneration: rowAfter.evidenceConfigGeneration,
          evidenceSourceAt: rowAfter.evidenceSourceAt,
          evidenceWatermarkAt: rowAfter.evidenceWatermarkAt,
          evidenceWatermarkState: rowAfter.evidenceWatermarkState,
          severity: rowAfter.severity,
          message: rowAfter.message,
          AND: [
            {
              OR: [
                { operationClaimToken: null },
                { operationClaimExpiresAt: { lte: new Date() } },
                { operationClaimIncidentGeneration: { not: rowAfter.incidentGeneration } },
              ],
            },
          ],
        },
        data: { lastDetectedAt: new Date(epochMs + 1_000) },
      });
      assert.equal(casCount.count, 1, "the production-shaped Prisma CAS must match repaired dates");

      const eventRangeAfter = await prisma.externalUsageEvent.count({
        where: { occurredAt: { gte: date, lte: date } },
      });
      assert.equal(eventRangeAfter, eventRangeBefore);
      assert.equal(eventRangeAfter, 1);
      const secondApply = normalizeAlertTimestamps(db, { apply: true });
      assert.equal(secondApply.rowsUpdated, 0);
      assert.equal(secondApply.valuesConverted, 0);
    } finally {
      await prisma.$disconnect();
    }
  });
});

test("invalid integer date aborts the whole repair before mutation", async () => {
  await withFixture(async ({ db }) => {
    insertNotification(db, { id: "valid-row" });
    insertNotification(db, {
      id: "invalid-row",
      stateKey: "provider-1:invalid-row:spend_anomaly",
      resolvedAt: 8_640_000_000_000_001,
    });
    assert.throws(
      () => normalizeAlertTimestamps(db, { apply: true }),
      /Invalid integer timestamp at ProviderAlertNotification\.resolvedAt for row invalid-row/
    );
    const rows = db
      .prepare(
        `SELECT id, typeof(firstDetectedAt) AS firstType, typeof(resolvedAt) AS resolvedType
         FROM ProviderAlertNotification ORDER BY id`
      )
      .all();
    assert.deepEqual(
      rows.map((row) => [row.id, row.firstType, row.resolvedType]),
      [
        ["invalid-row", "integer", "integer"],
        ["valid-row", "integer", "integer"],
      ]
    );
  });
});

test("CLI defaults to a read-only dry-run", async () => {
  await withFixture(async ({ db, databasePath }) => {
    insertNotification(db);
    const result = spawnSync(
      process.execPath,
      [scriptPath.pathname, "--database", databasePath],
      { encoding: "utf8" }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      mode: "dry-run",
      rowsWithIntegerDates: 1,
      valuesToConvert: 8,
      rowsUpdated: 0,
      valuesConverted: 0,
    });
    assert.equal(
      db.prepare("SELECT typeof(resolvedAt) AS kind FROM ProviderAlertNotification").get().kind,
      "integer"
    );
    const applied = spawnSync(
      process.execPath,
      [scriptPath.pathname, "--apply", "--database", databasePath],
      { encoding: "utf8" }
    );
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(JSON.parse(applied.stdout).mode, "applied");
    assert.equal(
      db.prepare("SELECT typeof(resolvedAt) AS kind FROM ProviderAlertNotification").get().kind,
      "text"
    );
  });
});
