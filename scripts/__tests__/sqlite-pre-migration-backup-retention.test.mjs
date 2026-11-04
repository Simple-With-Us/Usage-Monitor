// Focused tests for the pre-migration backup retention prune.
//
// Two Usage Monitor containers can share one /data volume and run the backup
// script at the same time.  A backup must never be pruned while another
// concurrent process may still be verifying it, so only settled backups
// (written before this run started, or this process's own new backup) take
// part in the retention count and in the prune decision.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  managedBackups,
  pruneBackupsToRetention,
  selectPrunableBackups,
  settledBackups,
} from "../lib/sqlite-pre-migration-backup-cleanup.mjs";

const SCRIPT = fileURLToPath(
  new URL("../backup-sqlite-before-migrate.mjs", import.meta.url)
);
const PREFIX = "prod.db.pre-migration-";

function makeBackupDir() {
  return mkdtempSync(join(tmpdir(), "um-backup-retention-"));
}

/**
 * Writes a managed backup with an explicit mtime so the settled/in-flight
 * split is deterministic instead of timing-dependent.
 */
function writeBackup(backupDirectory, name, mtimeMs) {
  const path = join(backupDirectory, name);
  writeFileSync(path, "backup");
  const date = new Date(mtimeMs);
  utimesSync(path, date, date);
  return path;
}

test("a backup newer than startedAtMs is never pruned", () => {
  const backupDirectory = makeBackupDir();
  const startedAtMs = 1_000_000;
  const inFlight = writeBackup(
    backupDirectory,
    `${PREFIX}20260101T000000000Z-2.backup.db`,
    startedAtMs + 5_000
  );
  const settled = writeBackup(
    backupDirectory,
    `${PREFIX}20260101T000000000Z-1.backup.db`,
    startedAtMs - 60_000
  );
  const ownPath = writeBackup(
    backupDirectory,
    `${PREFIX}20260101T000000000Z-3.backup.db`,
    startedAtMs + 1_000
  );

  const prunable = selectPrunableBackups(
    managedBackups(backupDirectory, PREFIX),
    { retention: 1, startedAtMs, ownPath }
  );
  assert.deepEqual(
    prunable.map((entry) => entry.path),
    [settled],
    "only the settled backup may be pruned"
  );
  assert.ok(
    !prunable.some((entry) => entry.path === inFlight),
    "a concurrent process's in-flight backup must never be a prune candidate"
  );

  pruneBackupsToRetention({
    backupDirectory,
    prefix: PREFIX,
    retention: 1,
    startedAtMs,
    ownPath,
  });
  assert.ok(existsSync(inFlight), "the in-flight backup survives the prune");
  assert.ok(!existsSync(settled), "the settled backup is pruned");
  assert.ok(existsSync(ownPath), "this process's own backup survives");
});

test("this process's own new backup is never pruned", () => {
  const backupDirectory = makeBackupDir();
  const startedAtMs = 2_000_000;
  const ownPath = writeBackup(
    backupDirectory,
    `${PREFIX}20260101T000000000Z-9.backup.db`,
    startedAtMs + 1_000
  );
  const older = writeBackup(
    backupDirectory,
    `${PREFIX}20260101T000000000Z-8.backup.db`,
    startedAtMs - 60_000
  );

  const prunable = selectPrunableBackups(
    managedBackups(backupDirectory, PREFIX),
    { retention: 1, startedAtMs, ownPath }
  );
  assert.deepEqual(
    prunable.map((entry) => entry.path),
    [older],
    "the older backup is pruned, never this process's own backup"
  );
  assert.ok(!prunable.some((entry) => entry.path === ownPath));
});

test("an older settled backup is pruned when retention would be exceeded", () => {
  const backupDirectory = makeBackupDir();
  const startedAtMs = 3_000_000;
  const oldest = writeBackup(
    backupDirectory,
    `${PREFIX}20260101T000000000Z-1.backup.db`,
    startedAtMs - 120_000
  );
  const middle = writeBackup(
    backupDirectory,
    `${PREFIX}20260101T000000000Z-2.backup.db`,
    startedAtMs - 60_000
  );

  const prunable = selectPrunableBackups(
    managedBackups(backupDirectory, PREFIX),
    { retention: 1, startedAtMs, ownPath: null }
  );
  assert.deepEqual(
    prunable.map((entry) => entry.path),
    [oldest],
    "the oldest settled backup is pruned first"
  );

  const pruned = [];
  const result = pruneBackupsToRetention({
    backupDirectory,
    prefix: PREFIX,
    retention: 1,
    startedAtMs,
    ownPath: null,
    log: (message) => pruned.push(message),
  });
  assert.equal(result.pruned, 1);
  assert.ok(!existsSync(oldest));
  assert.ok(existsSync(middle), "the newest settled backup is kept");
  assert.equal(pruned.length, 1);
  assert.match(pruned[0], /pruned old backup/);
});

test("the settled-only invariant holds while another process's backup is in flight", () => {
  const backupDirectory = makeBackupDir();
  const startedAtMs = 4_000_000;
  const inFlight = writeBackup(
    backupDirectory,
    `${PREFIX}20260101T000000000Z-7.backup.db`,
    startedAtMs + 1_000
  );
  const ownPath = writeBackup(
    backupDirectory,
    `${PREFIX}20260101T000000000Z-8.backup.db`,
    startedAtMs + 2_000
  );

  const entries = managedBackups(backupDirectory, PREFIX);
  assert.equal(entries.length, 2, "both files exist on disk");
  const settled = settledBackups(entries, { startedAtMs, ownPath });
  assert.deepEqual(
    settled.map((entry) => entry.path),
    [ownPath],
    "only this process's own backup is settled"
  );
  assert.ok(
    settled.length <= 1,
    "the retention invariant must not fail because of an in-flight backup"
  );

  const result = pruneBackupsToRetention({
    backupDirectory,
    prefix: PREFIX,
    retention: 1,
    startedAtMs,
    ownPath,
  });
  assert.equal(result.pruned, 0);
  assert.ok(existsSync(inFlight), "the in-flight backup survives");
  assert.ok(existsSync(ownPath), "this process's own backup survives");
  assert.equal(result.settled.length, 1);
});

test("normal single-process operation leaves exactly one backup", () => {
  const dir = mkdtempSync(join(tmpdir(), "um-backup-retention-e2e-"));
  const databasePath = join(dir, "prod.db");
  const database = new DatabaseSync(databasePath);
  database.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, pad TEXT)");
  database.close();

  const backupDirectory = join(dir, ".pre-migration-backups");
  mkdirSync(backupDirectory, { recursive: true });

  const run = () =>
    spawnSync(process.execPath, [SCRIPT], {
      env: { ...process.env, DATABASE_URL: `file:${databasePath}` },
      encoding: "utf8",
      timeout: 120_000,
    });

  const first = run();
  assert.equal(first.status, 0, `first backup should succeed: ${first.stderr}`);
  const second = run();
  assert.equal(second.status, 0, `second backup should succeed: ${second.stderr}`);

  const backups = readdirSync(backupDirectory).filter((name) =>
    name.endsWith(".backup.db")
  );
  assert.equal(backups.length, 1, "exactly one backup remains on disk");
});
