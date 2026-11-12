import { readdirSync, statSync, unlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { isStalePartialMtime } from "./sqlite-pre-migration-backup-timing.mjs";

function isENOENT(error) {
  return error && typeof error === "object" && error.code === "ENOENT";
}

/**
 * Stamp the promotion time onto a backup before it is renamed into place.
 *
 * A rename preserves the source file's mtime, so without this the promoted
 * file carries the time its content was written rather than the time it
 * became visible to other processes.  A concurrent startup that wrote its
 * content earlier but promoted later would then look like the oldest backup,
 * and a retention prune could delete the backup the other startup is still
 * verifying - the ENOENT abort this whole rule exists to prevent.
 *
 * Stamping the promotion time keeps mtime meaning "promoted at", which is
 * what both the oldest-first ordering and the settled/in-flight split need.
 */
export function stampPromotionTime(path, promotedAtMs = Date.now()) {
  const promotedAt = new Date(promotedAtMs);
  utimesSync(path, promotedAt, promotedAt);
}

/**
 * The managed backups that exist right now, oldest promotion first.
 *
 * The order is the order in which the backups became visible to other
 * processes, not the order in which their content happened to be written.
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
 * The managed backup paths that exist at a given moment.
 *
 * This is the directory-listing witness of promotion time.  A managed backup
 * only gets its `.backup.db` name when it is promoted into place, so a name
 * that is missing from this listing was promoted after the listing was
 * taken.  That is independent of any file timestamp, so it still holds when
 * a rename preserved an mtime that does not reflect the promotion.
 */
export function knownBackupPaths(backupDirectory, prefix) {
  const paths = new Set();
  for (const entry of readdirSync(backupDirectory, { withFileTypes: true })) {
    if (
      entry.isFile() &&
      entry.name.startsWith(prefix) &&
      entry.name.endsWith(".backup.db")
    ) {
      paths.add(join(backupDirectory, entry.name));
    }
  }
  return paths;
}

/**
 * A managed backup is settled when it was promoted before this process
 * started its own backup run, or when it is this process's own just-created
 * backup.  Anything promoted after that moment belongs to a concurrent
 * startup that may still be verifying it, so it must never be pruned.
 *
 * Two independent witnesses must agree before a backup counts as settled:
 *
 * - the listing taken when this run started (the name was already there), and
 * - the file's mtime, which the promoting process stamps with the promotion
 *   instant, so it survives the rename that would otherwise preserve the
 *   content-write time.
 *
 * A backup that fails either test is left alone.
 */
export function isSettledBackup(entry, { startedAtMs, ownPath = null, knownPaths = null }) {
  if (ownPath && entry.path === ownPath) {
    return true;
  }
  if (knownPaths && !knownPaths.has(entry.path)) {
    return false;
  }
  return entry.mtimeMs < startedAtMs;
}

export function settledBackups(entries, { startedAtMs, ownPath = null, knownPaths = null }) {
  return entries.filter((entry) =>
    isSettledBackup(entry, { startedAtMs, ownPath, knownPaths })
  );
}

/**
 * Pick the backups this process may delete.
 *
 * Only settled backups count toward the retention limit, so another process's
 * in-flight backup cannot inflate the count and trip the retention invariant.
 * This process's own backup is never a deletion candidate.
 */
export function selectPrunableBackups(entries, {
  retention,
  startedAtMs,
  ownPath = null,
  knownPaths = null,
}) {
  const settled = settledBackups(entries, { startedAtMs, ownPath, knownPaths });
  const ownPresent =
    Boolean(ownPath) && settled.some((entry) => entry.path === ownPath);
  const others = settled.filter((entry) => entry.path !== ownPath);
  const allowedOthers = Math.max(0, retention - (ownPresent ? 1 : 0));
  const removeCount = Math.max(0, others.length - allowedOthers);
  return others.slice(0, removeCount);
}

/**
 * Delete the given backups and report what this run actually removed.
 *
 * A concurrent startup can remove a file between the listing and the unlink,
 * so a skipped delete is not counted: `pruned` reports deletions this run
 * performed and never exceeds the number of "pruned old backup" log lines.
 */
export function pruneBackupEntries(entries, { unlink = unlinkSync, log = () => {} } = {}) {
  let pruned = 0;
  let skipped = 0;
  for (const item of entries) {
    try {
      unlink(item.path);
      pruned += 1;
      log(`pruned old backup ${item.name}`);
    } catch (error) {
      if (isENOENT(error)) {
        skipped += 1;
        continue;
      }
      throw error;
    }
  }
  return { pruned, skipped };
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
  knownPaths = null,
  log = () => {},
}) {
  const prunable = selectPrunableBackups(
    managedBackups(backupDirectory, prefix),
    { retention, startedAtMs, ownPath, knownPaths }
  );
  const { pruned, skipped } = pruneBackupEntries(prunable, { log });
  return {
    pruned,
    skipped,
    settled: settledBackups(managedBackups(backupDirectory, prefix), {
      startedAtMs,
      ownPath,
      knownPaths,
    }),
  };
}

/**
 * The backup that protects this database from a failed migration.
 *
 * This run's own promoted backup is preferred.  A concurrent startup on the
 * same volume may have promoted its own backup after this one and pruned
 * this one under the shared retention count; that backup was verified the
 * same way (integrity checked before its promotion) and covers the same
 * database, so the newest surviving backup is an equally valid restore
 * point.  When nothing survives, the caller must fail closed.
 */
export function selectVerifiedBackup(entries, ownPath = null) {
  const own = entries.find((entry) => entry.path === ownPath);
  if (own) {
    return own;
  }
  if (entries.length === 0) {
    return null;
  }
  return entries.reduce((newest, entry) =>
    entry.mtimeMs >= newest.mtimeMs ? entry : newest
  );
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
