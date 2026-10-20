#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  readFileSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const script = join(repoRoot, "scripts", "backup-sqlite-before-migrate.mjs");

const backupScriptSource = readFileSync(script, "utf8");
const renameIndex = backupScriptSource.indexOf(
  "renameSync(partialPath, finalPath);"
);
assert.notEqual(renameIndex, -1, "backup must atomically promote the verified file");
assert.notEqual(
  backupScriptSource.indexOf("fsyncDirectory(backupDirectory);", renameIndex),
  -1,
  "backup directory must be fsynced after atomic promotion"
);

function run(databaseUrl, overrides = {}, cwd = repoRoot) {
  const env = { ...process.env, DATABASE_URL: databaseUrl };
  delete env.SQLITE_PRE_MIGRATION_BACKUP_RETENTION;
  Object.assign(env, overrides);
  return spawnSync(process.execPath, [script], {
    cwd,
    env,
    encoding: "utf8",
  });
}

function expectStatus(name, result, expected) {
  assert.equal(
    result.status,
    expected,
    `${name}: expected exit ${expected}, got ${result.status}\n${result.stdout}\n${result.stderr}`
  );
}

function backupFiles(databasePath) {
  const directory = join(dirname(databasePath), ".pre-migration-backups");
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter(
      (name) =>
        name.startsWith(`${basename(databasePath)}.pre-migration-`) &&
        name.endsWith(".backup.db")
    )
    .map((name) => join(directory, name));
}

function assertBackup(path, expectedRows) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    assert.deepEqual(
      database.prepare("PRAGMA integrity_check").all().map((row) => Object.values(row)[0]),
      ["ok"]
    );
    assert.deepEqual(
      database.prepare("SELECT value FROM sample ORDER BY id").all().map((row) => row.value),
      expectedRows
    );
  } finally {
    database.close();
  }
}

const temp = mkdtempSync(join(tmpdir(), "usage-sqlite-backup-"));
try {
  const missingPath = join(temp, "missing.db");
  const missing = run(`file:${missingPath}`);
  expectStatus("missing database", missing, 0);
  assert.match(missing.stdout, /backup not required/);
  assert.equal(backupFiles(missingPath).length, 0);

  const databasePath = join(temp, "source.db");
  const source = new DatabaseSync(databasePath);
  source.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO sample (value) VALUES ('alpha'), ('beta');
  `);

  // Keep the WAL-mode source connection open while the child backs it up.
  // This proves the online backup API captures committed WAL-backed rows and
  // does not depend on unsafe filesystem copying.
  const first = run(`file:${databasePath}`, {
    SQLITE_PRE_MIGRATION_BACKUP_RETENTION: "2",
  });
  expectStatus("WAL backup", first, 0);
  assert.match(first.stdout, /verified .*\.backup\.db/);
  let backups = backupFiles(databasePath);
  assert.equal(backups.length, 1);
  assertBackup(backups[0], ["alpha", "beta"]);
  assert.equal(statSync(backups[0]).mode & 0o777, 0o600);
  assert.equal(
    statSync(join(temp, ".pre-migration-backups")).mode & 0o777,
    0o700
  );

  // Native SQLite memory bounds (shared with src/lib/prisma.ts) and the
  // backup step rate must be tunable without breaking the backup itself -
  // a custom cache/mmap/rate combination should still produce a verified,
  // byte-correct backup.
  const tunedMemory = run(`file:${databasePath}`, {
    SQLITE_PRE_MIGRATION_BACKUP_RETENTION: "2",
    SQLITE_CACHE_SIZE_KIB: "512",
    SQLITE_MMAP_SIZE_BYTES: "1048576",
    SQLITE_BACKUP_RATE_PAGES: "1",
  });
  expectStatus("tuned native-memory backup", tunedMemory, 0);
  assertBackup(backupFiles(databasePath).at(-1), ["alpha", "beta"]);

  source.prepare("INSERT INTO sample (value) VALUES (?)").run("gamma");
  for (let index = 0; index < 3; index += 1) {
    expectStatus(
      `bounded backup ${index + 1}`,
      run(`file:${databasePath}`, {
        SQLITE_PRE_MIGRATION_BACKUP_RETENTION: "2",
      }),
      0
    );
  }
  backups = backupFiles(databasePath);
  assert.equal(backups.length, 2, "retention must keep exactly the newest two backups");
  for (const path of backups) assertBackup(path, ["alpha", "beta", "gamma"]);
  source.close();

  const relativeDirectory = join(temp, "relative");
  mkdirSync(relativeDirectory);
  const relativePath = join(relativeDirectory, "relative.db");
  const relativeDb = new DatabaseSync(relativePath);
  relativeDb.exec("CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO sample (value) VALUES ('relative');");
  relativeDb.close();
  expectStatus(
    "relative file URL",
    run(`file:${relative(relativeDirectory, relativePath)}`, {}, relativeDirectory),
    0
  );
  assertBackup(backupFiles(relativePath)[0], ["relative"]);

  const symlinkCase = join(temp, "symlink-case");
  const symlinkTarget = join(temp, "symlink-target");
  mkdirSync(symlinkCase);
  mkdirSync(symlinkTarget);
  const symlinkDatabasePath = join(symlinkCase, "source.db");
  const symlinkDatabase = new DatabaseSync(symlinkDatabasePath);
  symlinkDatabase.exec(
    "CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT NOT NULL);"
  );
  symlinkDatabase.close();
  symlinkSync(
    symlinkTarget,
    join(symlinkCase, ".pre-migration-backups"),
    "dir"
  );
  const symlinkResult = run(`file:${symlinkDatabasePath}`);
  expectStatus("symlink backup directory", symlinkResult, 1);
  assert.match(symlinkResult.stderr, /backup path is not a real directory/);
  assert.equal(
    readdirSync(symlinkTarget).length,
    0,
    "a symlink target must never receive backup data"
  );

  const corruptPath = join(temp, "corrupt.db");
  writeFileSync(corruptPath, "not a sqlite database");
  const corrupt = run(`file:${corruptPath}`);
  expectStatus("corrupt source", corrupt, 1);
  assert.match(corrupt.stderr, /ERROR:/);
  assert.equal(backupFiles(corruptPath).length, 0);

  const invalidRetention = run(`file:${databasePath}`, {
    SQLITE_PRE_MIGRATION_BACKUP_RETENTION: "0",
  });
  expectStatus("invalid retention", invalidRetention, 1);
  assert.match(invalidRetention.stderr, /must be an integer from 1 to 10/);

  const wrongDatasource = run("postgresql://example.invalid/database");
  expectStatus("non-SQLite datasource", wrongDatasource, 1);
  assert.match(wrongDatasource.stderr, /must be a file: SQLite URL/);

  const directoryPath = join(temp, "directory.db");
  mkdirSync(directoryPath);
  chmodSync(directoryPath, 0o700);
  const directoryResult = run(`file:${directoryPath}`);
  expectStatus("non-file database path", directoryResult, 1);
  assert.match(directoryResult.stderr, /is not a regular file/);

  // VACUUM INTO must work from the same read-only source connection used by
  // the production backup and keep making progress while another connection
  // commits.  The worker and both database files are confined to this temp
  // directory; production data is never opened by this test.
  const vacuumSourcePath = join(temp, "vacuum-source.db");
  const vacuumSnapshotPath = join(temp, "vacuum-snapshot.db");
  const vacuumSeed = new DatabaseSync(vacuumSourcePath);
  vacuumSeed.exec("PRAGMA journal_mode = WAL; CREATE TABLE ballast (value TEXT NOT NULL); CREATE TABLE writes (value TEXT NOT NULL);");
  const insertBallast = vacuumSeed.prepare("INSERT INTO ballast (value) VALUES (?)");
  vacuumSeed.exec("BEGIN");
  for (let index = 0; index < 60_000; index += 1) {
    insertBallast.run("x".repeat(1024));
  }
  vacuumSeed.exec("COMMIT");
  vacuumSeed.close();

  const control = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const stats = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const writer = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    const { DatabaseSync } = require("node:sqlite");
    const control = new Int32Array(workerData.control);
    const stats = new Int32Array(workerData.stats);
    const database = new DatabaseSync(workerData.databasePath);
    const insert = database.prepare("INSERT INTO writes (value) VALUES (?)");
    let index = 0;
    parentPort.postMessage("ready");
    while (Atomics.load(control, 0) === 0) {
      database.exec("BEGIN IMMEDIATE");
      for (let batch = 0; batch < 100; batch += 1) insert.run(String(index++));
      database.exec("COMMIT");
      Atomics.add(stats, 0, 1);
      Atomics.wait(control, 1, 0, 1);
    }
    database.close();
  `, {
    eval: true,
    workerData: { databasePath: vacuumSourcePath, control, stats },
  });
  try {
    await once(writer, "message");
    const writeStats = new Int32Array(stats);
    const deadline = Date.now() + 5_000;
    while (Atomics.load(writeStats, 0) < 3 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(Atomics.load(writeStats, 0) >= 3, "independent writer must commit before snapshot starts");
    const commitsBeforeSnapshot = Atomics.load(writeStats, 0);

    const readOnlySource = new DatabaseSync(vacuumSourcePath, { readOnly: true });
    try {
      readOnlySource.exec(`VACUUM INTO '${vacuumSnapshotPath}'`);
    } finally {
      readOnlySource.close();
    }

    assert.ok(
      Atomics.load(writeStats, 0) > commitsBeforeSnapshot,
      "independent writer must continue committing during VACUUM INTO"
    );
    const vacuumSnapshot = new DatabaseSync(vacuumSnapshotPath, { readOnly: true });
    try {
      assert.deepEqual(
        vacuumSnapshot.prepare("PRAGMA integrity_check").all().map((row) => Object.values(row)[0]),
        ["ok"]
      );
      const copiedWrites = vacuumSnapshot.prepare("SELECT COUNT(*) AS count FROM writes").get().count;
      const sourceWrites = new DatabaseSync(vacuumSourcePath, { readOnly: true });
      try {
        const latestWrites = sourceWrites.prepare("SELECT COUNT(*) AS count FROM writes").get().count;
        assert.ok(copiedWrites <= latestWrites, "snapshot must not contain uncommitted future rows");
        assert.equal(copiedWrites % 100, 0, "snapshot must include only whole writer transactions");
      } finally {
        sourceWrites.close();
      }
    } finally {
      vacuumSnapshot.close();
    }

    const commitsBeforeBackupScript = Atomics.load(writeStats, 0);
    const concurrentBackup = run(`file:${vacuumSourcePath}`, {
      SQLITE_PRE_MIGRATION_BACKUP_TIMEOUT_MS: "300000",
    });
    expectStatus("pre-migration backup with concurrent writer", concurrentBackup, 0);
    assert.ok(
      Atomics.load(writeStats, 0) > commitsBeforeBackupScript,
      "production backup script must allow independent commits to progress"
    );
    const managedSnapshots = backupFiles(vacuumSourcePath);
    assert.equal(managedSnapshots.length, 1);
    const managedSnapshot = new DatabaseSync(managedSnapshots[0], { readOnly: true });
    try {
      assert.deepEqual(
        managedSnapshot.prepare("PRAGMA integrity_check").all().map((row) => Object.values(row)[0]),
        ["ok"]
      );
      const copiedWrites = managedSnapshot.prepare("SELECT COUNT(*) AS count FROM writes").get().count;
      const latestWritesDb = new DatabaseSync(vacuumSourcePath, { readOnly: true });
      try {
        const latestWrites = latestWritesDb.prepare("SELECT COUNT(*) AS count FROM writes").get().count;
        assert.ok(copiedWrites <= latestWrites, "managed snapshot must not include uncommitted future rows");
        assert.equal(copiedWrites % 100, 0, "managed snapshot must contain complete writer transactions");
      } finally {
        latestWritesDb.close();
      }
    } finally {
      managedSnapshot.close();
    }
  } finally {
    Atomics.store(new Int32Array(control), 0, 1);
    Atomics.notify(new Int32Array(control), 1);
    await writer.terminate();
  }

  // An exclusive rollback-journal lock forces the snapshot child to wait on
  // SQLite.  Its configured overall deadline must kill the child, fail closed,
  // and remove the partial artifact without waiting for SQLite's lock timeout.
  const blockedPath = join(temp, "blocked-source.db");
  const blocker = new DatabaseSync(blockedPath);
  blocker.exec("CREATE TABLE sample (value TEXT NOT NULL); BEGIN EXCLUSIVE; INSERT INTO sample VALUES ('held');");
  const blockedStart = Date.now();
  const blocked = run(`file:${blockedPath}`, {
    SQLITE_PRE_MIGRATION_BACKUP_TIMEOUT_MS: "1000",
  });
  const blockedDuration = Date.now() - blockedStart;
  blocker.exec("ROLLBACK");
  blocker.close();
  expectStatus("bounded snapshot timeout", blocked, 1);
  assert.match(blocked.stderr, /exceeded 1000 ms/);
  assert.ok(blockedDuration < 5_000, `timeout must be bounded, took ${blockedDuration} ms`);
  assert.equal(backupFiles(blockedPath).length, 0, "a timed-out partial snapshot must not be retained");
} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log("SQLite pre-migration backup checks passed");
