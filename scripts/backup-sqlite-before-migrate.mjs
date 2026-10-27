#!/usr/bin/env node
/**
 * Create and verify a transaction-consistent backup of an existing SQLite
 * database before migrate-safe.mjs changes its schema.
 *
 * VACUUM INTO creates a consistent snapshot without Online Backup API restarts
 * when another process writes during the copy.  The source is opened read-only,
 * and a bounded child performs the snapshot and integrity check before the
 * private partial file is promoted to .backup.db.
 *
 * Existing databases fail closed on every backup/verification/retention error.
 * A missing database is the expected first-deploy case and needs no backup.
 *
 * References:
 * - https://www.sqlite.org/backup.html
 * - https://nodejs.org/docs/latest-v24.x/api/sqlite.html
 */

import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSqliteDatabasePath } from "./lib/sqlite-database-url.mjs";

const DEFAULT_RETENTION = 1; // free-tier disk: one pre-migrate snapshot is enough
const MAX_RETENTION = 10;
const BACKUP_DIRECTORY = ".pre-migration-backups";
const BACKUP_TIMEOUT_MS = clampedIntEnv(
  "SQLITE_PRE_MIGRATION_BACKUP_TIMEOUT_MS",
  5 * 60_000,
  1_000,
  15 * 60_000
);

function log(message) {
  console.log(`[sqlite-pre-migration-backup] ${message}`);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function clampedIntEnv(name, fallback, min, max) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

// Native (non-heap) memory bound on the read-only connections this script
// opens against the live database. Shares SQLITE_CACHE_SIZE_KIB /
// SQLITE_MMAP_SIZE_BYTES with src/lib/prisma.ts's applySqliteNativeMemoryPragmas
// (same rationale: SQLite's own page cache/mmap are native allocations
// outside any V8 heap cap) so operators tune one pair of knobs for the whole
// app instead of two. Copying and integrity-checking a 130MB+ database is the
// heaviest I/O this script does; an unbounded mmap here would let the OS map
// large chunks of that file into this short-lived process's address space
// right before migrate-safe and npm start start their own memory ramp.
function applySqliteMemoryPragmas(database) {
  const cacheSizeKib = -Math.abs(
    clampedIntEnv("SQLITE_CACHE_SIZE_KIB", 2_000, 256, 65_536)
  );
  const mmapSizeBytes = clampedIntEnv("SQLITE_MMAP_SIZE_BYTES", 0, 0, 268_435_456);
  database.exec(`PRAGMA cache_size = ${cacheSizeKib}`);
  database.exec(`PRAGMA mmap_size = ${mmapSizeBytes}`);
}

function parseDatabasePath(databaseUrl) {
  return parseSqliteDatabasePath(databaseUrl);
}

function retentionCount(raw) {
  if (raw == null || raw.trim() === "") return DEFAULT_RETENTION;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_RETENTION) {
    throw new Error(
      `SQLITE_PRE_MIGRATION_BACKUP_RETENTION must be an integer from 1 to ${MAX_RETENTION}`
    );
  }
  return value;
}

function backupPrefix(databasePath) {
  return `${basename(databasePath)}.pre-migration-`;
}

function managedBackups(backupDirectory, prefix) {
  return readdirSync(backupDirectory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.startsWith(prefix) &&
        entry.name.endsWith(".backup.db")
    )
    .map((entry) => {
      const path = join(backupDirectory, entry.name);
      return { path, mtimeMs: statSync(path).mtimeMs };
    })
    .sort((left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path));
}

function removeStalePartials(backupDirectory, prefix) {
  for (const entry of readdirSync(backupDirectory, { withFileTypes: true })) {
    if (
      entry.isFile() &&
      entry.name.startsWith(prefix) &&
      entry.name.endsWith(".partial")
    ) {
      unlinkSync(join(backupDirectory, entry.name));
    }
  }
}

function pruneToRetention(backupDirectory, prefix, retention) {
  const existing = managedBackups(backupDirectory, prefix);
  const removeCount = Math.max(0, existing.length - retention);
  for (const item of existing.slice(0, removeCount)) {
    unlinkSync(item.path);
    log(`pruned old backup ${basename(item.path)}`);
  }
}

function assertIntegrity(path) {
  let database;
  try {
    database = new DatabaseSync(path, {
      readOnly: true,
      timeout: 30_000,
    });
  } catch (error) {
    throw new Error(
      `backup integrity check could not open ${path}: ${errorMessage(error)}`
    );
  }
  try {
    try {
      applySqliteMemoryPragmas(database);
    } catch (error) {
      throw new Error(
        `backup integrity_check failed for ${path}: ${errorMessage(error)}`
      );
    }
    let rows;
    try {
      rows = database.prepare("PRAGMA integrity_check").all();
    } catch (error) {
      throw new Error(
        `backup integrity_check failed for ${path}: ${errorMessage(error)}`
      );
    }
    if (
      rows.length !== 1 ||
      Object.values(rows[0] ?? {}).length !== 1 ||
      Object.values(rows[0])[0] !== "ok"
    ) {
      throw new Error("backup PRAGMA integrity_check did not return exactly 'ok'");
    }
  } finally {
    database.close();
  }
}

function fsyncFile(path) {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function fsyncDirectory(path) {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function ensurePrivateBackupDirectory(path) {
  if (existsSync(path)) {
    const existing = lstatSync(path);
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error(`backup path is not a real directory: ${path}`);
    }
  } else {
    mkdirSync(path, { mode: 0o700 });
  }

  // Check again after creation before chmod so an existing symlink is never
  // followed and used as the destination for a database containing secrets.
  const created = lstatSync(path);
  if (created.isSymbolicLink() || !created.isDirectory()) {
    throw new Error(`backup path is not a real directory: ${path}`);
  }
  chmodSync(path, 0o700);
}

function snapshotChild(databasePath, snapshotPath) {
  process.umask(0o077);
  let source;
  try {
    source = new DatabaseSync(databasePath, {
      readOnly: true,
      timeout: 30_000,
    });
  } catch (error) {
    throw new Error(
      `snapshot could not open source ${databasePath}: ${errorMessage(error)}`
    );
  }
  try {
    applySqliteMemoryPragmas(source);
    // VACUUM INTO holds one consistent read transaction.  Unlike sqlite3_backup_step,
    // concurrent commits from the old app cannot restart the copy from page one.
    try {
      source.prepare("VACUUM INTO ?").run(snapshotPath);
    } catch (error) {
      throw new Error(
        `snapshot VACUUM INTO ${snapshotPath} failed: ${errorMessage(error)}`
      );
    }
  } finally {
    source.close();
  }
  assertIntegrity(snapshotPath);
}

function createSnapshotWithDeadline(databasePath, partialPath) {
  log(`creating consistent snapshot with a ${BACKUP_TIMEOUT_MS} ms deadline`);
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(import.meta.url), "--snapshot-child", databasePath, partialPath],
    {
      // Preserve only the bounded SQLite memory knobs, without credentials.
      env: {
        PATH: process.env.PATH ?? "",
        ...(process.env.SQLITE_CACHE_SIZE_KIB ? { SQLITE_CACHE_SIZE_KIB: process.env.SQLITE_CACHE_SIZE_KIB } : {}),
        ...(process.env.SQLITE_MMAP_SIZE_BYTES ? { SQLITE_MMAP_SIZE_BYTES: process.env.SQLITE_MMAP_SIZE_BYTES } : {}),
      },
      timeout: BACKUP_TIMEOUT_MS,
      killSignal: "SIGKILL",
      stdio: "inherit",
    }
  );
  if (result.error) {
    const code = "code" in result.error ? result.error.code : undefined;
    if (code === "ETIMEDOUT") {
      throw new Error(`snapshot and integrity check exceeded ${BACKUP_TIMEOUT_MS} ms`);
    }
    throw new Error(`snapshot child could not run: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`snapshot child failed (exit ${result.status ?? result.signal ?? "unknown"})`);
  }
}

async function main() {
  // Backups contain every credential and usage row in the database. Ensure a
  // newly-created directory/file is private even before the explicit chmod.
  process.umask(0o077);

  const databasePath = parseDatabasePath(process.env.DATABASE_URL);
  if (!existsSync(databasePath)) {
    log(`no existing database at ${databasePath}; backup not required`);
    return;
  }
  if (!lstatSync(databasePath).isFile()) {
    throw new Error(`database path is not a regular file: ${databasePath}`);
  }

  const retention = retentionCount(
    process.env.SQLITE_PRE_MIGRATION_BACKUP_RETENTION
  );
  const backupDirectory = join(dirname(databasePath), BACKUP_DIRECTORY);
  ensurePrivateBackupDirectory(backupDirectory);

  const prefix = backupPrefix(databasePath);
  removeStalePartials(backupDirectory, prefix);
  // First repair any prior retention overflow, but preserve the full bounded
  // set while creating the replacement. If the new backup fails, the previous
  // verified backups remain available instead of being pruned preemptively.
  pruneToRetention(backupDirectory, prefix, retention);

  const timestamp = new Date().toISOString().replace(/[-:.]/g, "");
  const stem = `${prefix}${timestamp}-${process.pid}`;
  const partialPath = join(backupDirectory, `${stem}.partial`);
  const finalPath = join(backupDirectory, `${stem}.backup.db`);

  try {
    createSnapshotWithDeadline(databasePath, partialPath);
    chmodSync(partialPath, 0o600);
    fsyncFile(partialPath);
    renameSync(partialPath, finalPath);
    // The file fsync above persists its contents; fsyncing the containing
    // directory makes the atomic rename durable across a host crash.
    fsyncDirectory(backupDirectory);
    pruneToRetention(backupDirectory, prefix, retention);
    fsyncDirectory(backupDirectory);
    log(
      `verified ${basename(finalPath)} (${statSync(finalPath).size} bytes; retention ${retention})`
    );
  } catch (error) {
    rmSync(partialPath, { force: true });
    rmSync(finalPath, { force: true });
    throw error;
  }

  const retained = managedBackups(backupDirectory, prefix);
  if (retained.length > retention) {
    throw new Error(
      `backup retention invariant failed: found ${retained.length}, expected at most ${retention}`
    );
  }
}

const args = process.argv.slice(2);
const execution =
  args[0] === "--snapshot-child"
    ? Promise.resolve().then(() => {
        if (args.length !== 3 || !isAbsolute(args[1]) || !isAbsolute(args[2])) {
          throw new Error(
            "internal snapshot child requires absolute source and destination paths"
          );
        }
        snapshotChild(args[1], args[2]);
      })
    : args[0] === "--assert-integrity-only"
      ? Promise.resolve().then(() => {
          // Used only by scripts/test-backup-staged-errors.mjs (not deploy).
          if (args.length !== 2 || !isAbsolute(args[1])) {
            throw new Error(
              "internal integrity-only child requires one absolute backup path"
            );
          }
          assertIntegrity(args[1]);
        })
      : main();

execution.catch((error) => {
  console.error(
    `[sqlite-pre-migration-backup] ERROR: ${
      error instanceof Error ? error.message : "unknown backup failure"
    }`
  );
  process.exitCode = 1;
});
