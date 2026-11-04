import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { isStalePartialMtime } from "./sqlite-pre-migration-backup-timing.mjs";

function isENOENT(error) {
  return error && typeof error === "object" && error.code === "ENOENT";
}

/**
 * Managed pre-migration backups, oldest first.
 *
 * A concurrent startup can delete a file between readdir and stat, so a file
 * that vanished in that window is skipped instead of failing the whole run.
 */
export function managedBackups(backupDirectory, prefix) {
  const backups = [];
  for (const entry of readdirSync(backupDirectory, { withFileTypes: true })) {
    if (
      !entry.isFile() ||
      !entry.name.startsWith(prefix) ||
      !entry.name.endsWith(".backup.db")
    ) {
      continue;
    }
    const path = join(backupDirectory, entry.name);
    let mtimeMs;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch (error) {
      if (isENOENT(error)) {
        continue;
      }
      throw error;
    }
    backups.push({ path, name: entry.name, mtimeMs });
  }
  backups.sort(
    (left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path)
  );
  return backups;
}

/**
 * A managed backup is settled when it was last written before this process
 * started its own backup run, or when it is this process's own just-created
 * backup.  Anything newer belongs to a concurrent startup that may still be
 * verifying it, so it must never be pruned.
 */
export function isSettledBackup(entry, { startedAtMs, ownPath = null }) {
  if (ownPath && entry.path === ownPath) {
    return true;
  }
  return entry.mtimeMs < startedAtMs;
}

export function settledBackups(entries, { startedAtMs, ownPath = null }) {
  return entries.filter((entry) => isSettledBackup(entry, { startedAtMs, ownPath }));
}

/**
 * Pick the backups this process may delete.
 *
 * Only settled backups count toward the retention limit, so another process's
 * in-flight backup cannot inflate the count and trip the retention invariant.
 * This process's own backup is never a deletion candidate.
 */
export function selectPrunableBackups(entries, { retention, startedAtMs, ownPath = null }) {
  const settled = settledBackups(entries, { startedAtMs, ownPath });
  const ownPresent =
    Boolean(ownPath) && settled.some((entry) => entry.path === ownPath);
  const others = settled.filter((entry) => entry.path !== ownPath);
  const allowedOthers = Math.max(0, retention - (ownPresent ? 1 : 0));
  const removeCount = Math.max(0, others.length - allowedOthers);
  return others.slice(0, removeCount);
}

/**
 * Prune settled backups down to the retention count and report the settled
 * backups that remain.  Files that another concurrent startup may still be
 * verifying are left alone.
 */
export function pruneBackupsToRetention({
  backupDirectory,
  prefix,
  retention,
  startedAtMs,
  ownPath = null,
  log = () => {},
}) {
  const prunable = selectPrunableBackups(
    managedBackups(backupDirectory, prefix),
    { retention, startedAtMs, ownPath }
  );
  for (const item of prunable) {
    try {
      unlinkSync(item.path);
      log(`pruned old backup ${item.name}`);
    } catch (error) {
      if (isENOENT(error)) {
        continue;
      }
      throw error;
    }
  }
  return {
    pruned: prunable.length,
    settled: settledBackups(managedBackups(backupDirectory, prefix), {
      startedAtMs,
      ownPath,
    }),
  };
}

export function removeStalePartials(backupDirectory, prefix, log = () => {}, env = process.env) {
  const nowMs = Date.now();
  for (const entry of readdirSync(backupDirectory, { withFileTypes: true })) {
    if (
      !entry.isFile() ||
      !entry.name.startsWith(prefix) ||
      !entry.name.endsWith(".partial")
    ) {
      continue;
    }
    const path = join(backupDirectory, entry.name);
    try {
      const { mtimeMs } = statSync(path);
      if (!isStalePartialMtime(mtimeMs, nowMs, env)) {
        continue;
      }
      unlinkSync(path);
      log(`removed stale partial ${entry.name}`);
    } catch (error) {
      if (isENOENT(error)) {
        continue;
      }
      throw error;
    }
  }
}
