// Focused tests for the pre-migration backup retention prune.
//
// Two Usage Monitor containers can share one /data volume and run the backup
// script at the same time.  A backup must never be pruned while another
// concurrent process may still be verifying it, so only settled backups take
// part in the retention count and in the prune decision.
//
// A backup is settled only when two independent witnesses agree that it was
// promoted before this run started:
//
// - its mtime, which the promoting process stamps with the promotion instant
//   (a rename preserves the content-write time, so the stamp is what makes
//   the promotion visible), and
// - the directory listing taken when this run started, which is how a backup
//   promoted after this run began is recognised.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  knownBackupPaths,
  managedBackups,
  pruneBackupEntries,
  pruneBackupsToRetention,
  selectPrunableBackups,
  selectVerifiedBackup,
  settledBackups,
  stampPromotionTime,
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
 *
 * The mtime of a promoted backup is its promotion time: the promoting
 * process stamps it before the rename, so setting it here models a backup
 * promoted at that instant.
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

test("a backup promoted after this run started is never pruned", () => {
  const backupDirectory = makeBackupDir();
  const startedAtMs = 1_000_000;

  // This backup existed in the listing taken when the run started, so the
  // listing witness alone would call it settled.  Its mtime says it was
  // promoted after the run started, so it is in flight and must survive.
  const promotedLater = writeBackup(
    backupDirectory,
    `${PREFIX}20260101T000000000Z-5.backup.db`,
    startedAtMs + 30_000
  );

  const knownPaths = knownBackupPaths(backupDirectory, PREFIX);
  const prunable = selectPrunableBackups(
    managedBackups(backupDirectory, PREFIX),
    { retention: 0, startedAtMs, knownPaths }
  );
  assert.deepEqual(
    prunable.map((entry) => entry.path),
    [],
    "a backup promoted after this run started must never be a prune candidate"
  );
  assert.ok(!prunable.some((entry) => entry.path === promotedLater));
});

test("a backup missing from the run-start listing is never pruned", () => {
  const backupDirectory = makeBackupDir();
  const startedAtMs = 1_000_000;

  // This backup was in the listing taken when the run started, and its mtime
  // says it was promoted before the run started, so it is settled.
  const settled = writeBackup(
    backupDirectory,
    `${PREFIX}20260101T000000000Z-6.backup.db`,
    startedAtMs - 60_000
  );
  const knownPaths = knownBackupPaths(backupDirectory, PREFIX);

  // A backup that appears after the listing was taken was promoted after
  // this run started.  Its mtime is deliberately old, so the listing
  // witness is the only thing that protects it.
  const appearedAfterListing = writeBackup(
    backupDirectory,
    `${PREFIX}20260101T000000000Z-7.backup.db`,
    startedAtMs - 60_000
  );
  assert.ok(!knownPaths.has(appearedAfterListing));
  assert.ok(knownPaths.has(settled));

  const prunable = selectPrunableBackups(
    managedBackups(backupDirectory, PREFIX),
    { retention: 0, startedAtMs, knownPaths }
  );
  assert.deepEqual(
    prunable.map((entry) => entry.path),
    [settled],
    "only the settled backup may be pruned"
  );
  assert.ok(
    !prunable.some((entry) => entry.path === appearedAfterListing),
    "a backup that appeared after the run-start listing must not be pruned"
  );
});

test("the promotion stamp makes the promotion time visible on the file", () => {
  const backupDirectory = makeBackupDir();
  const path = join(backupDirectory, `${PREFIX}20260101T000000000Z-8.partial`);

  // The content was written long ago, as a rename would leave behind.
  const contentWrittenAt = Date.now() - 3_600_000;
  writeFileSync(path, "backup");
  const old = new Date(contentWrittenAt);
  utimesSync(path, old, old);
  assert.equal(statMtimeMs(path), contentWrittenAt);

  // The promotion stamps the instant it becomes visible.
  const promotedAtMs = Date.now();
  stampPromotionTime(path, promotedAtMs);
  assert.equal(
    statMtimeMs(path),
    promotedAtMs,
    "the promoted file must carry the promotion time, not the content-write time"
  );
});

test("pruned counts only successful deletions", () => {
  const entries = [
    { path: "/tmp/does-not-matter-1", name: "one.backup.db" },
    { path: "/tmp/does-not-matter-2", name: "two.backup.db" },
    { path: "/tmp/does-not-matter-3", name: "three.backup.db" },
  ];
  const deleted = [];
  const result = pruneBackupEntries(entries, {
    unlink: (path) => {
      if (path === entries[1].path) {
        const error = new Error("ENOENT");
        error.code = "ENOENT";
        throw error;
      }
      deleted.push(path);
    },
    log: () => {},
  });
  assert.equal(result.pruned, 2, "only successful deletions are counted");
  assert.equal(result.skipped, 1, "an ENOENT skip is reported separately");
  assert.equal(deleted.length, 2);
});

test("the restore point falls back to the newest surviving backup", () => {
  const ownPath = "/tmp/own.backup.db";
  const survivor = "/tmp/survivor.backup.db";
  const entries = [
    { path: survivor, name: "survivor.backup.db", mtimeMs: 5_000 },
    { path: ownPath, name: "own.backup.db", mtimeMs: 9_000 },
  ];

  assert.equal(
    selectVerifiedBackup(entries, ownPath).path,
    ownPath,
    "this run's own backup is preferred"
  );
  assert.equal(
    selectVerifiedBackup([entries[0]], ownPath).path,
    survivor,
    "a peer-pruned own backup falls back to the surviving verified backup"
  );
  assert.equal(
    selectVerifiedBackup([], ownPath),
    null,
    "no surviving backup means the caller must fail closed"
  );
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

test("a promoted backup carries its promotion time in its mtime", () => {
  const dir = mkdtempSync(join(tmpdir(), "um-backup-stamp-e2e-"));
  const databasePath = join(dir, "prod.db");
  const database = new DatabaseSync(databasePath);
  database.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, pad TEXT)");
  database.close();

  const backupDirectory = join(dir, ".pre-migration-backups");
  mkdirSync(backupDirectory, { recursive: true });

  const before = Date.now();
  const result = spawnSync(process.execPath, [SCRIPT], {
    env: { ...process.env, DATABASE_URL: `file:${databasePath}` },
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(result.status, 0, `backup should succeed: ${result.stderr}`);

  const backups = readdirSync(backupDirectory).filter((name) =>
    name.endsWith(".backup.db")
  );
  assert.equal(backups.length, 1);
  const promotedAtMs = statMtimeMs(join(backupDirectory, backups[0]));
  assert.ok(
    promotedAtMs >= before,
    "the promoted backup must carry the promotion time, not an older write time"
  );
});

function statMtimeMs(path) {
  return statSync(path).mtimeMs;
}
