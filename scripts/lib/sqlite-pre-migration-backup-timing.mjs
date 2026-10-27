/**
 * Shared pre-migration backup timing knobs.  Used by backup-sqlite-before-migrate.mjs
 * and start-with-litestream.sh so stale-partial cleanup uses the same deadline.
 */

import { fileURLToPath } from "node:url";

export const DEFAULT_BACKUP_TIMEOUT_MS = 5 * 60_000;
const MIN_BACKUP_TIMEOUT_MS = 1_000;
const MAX_BACKUP_TIMEOUT_MS = 15 * 60_000;

export function clampedIntEnv(name, fallback, min, max, env = process.env) {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

export function backupTimeoutMs(env = process.env) {
  return clampedIntEnv(
    "SQLITE_PRE_MIGRATION_BACKUP_TIMEOUT_MS",
    DEFAULT_BACKUP_TIMEOUT_MS,
    MIN_BACKUP_TIMEOUT_MS,
    MAX_BACKUP_TIMEOUT_MS,
    env
  );
}

/** Partials younger than this are treated as owned by a live snapshot child. */
export function stalePartialMinAgeMs(env = process.env) {
  return 2 * backupTimeoutMs(env);
}

export function isStalePartialMtime(mtimeMs, nowMs = Date.now(), env = process.env) {
  return mtimeMs < nowMs - stalePartialMinAgeMs(env);
}

/** find -mmin uses whole minutes; never pass 0 or a sub-minute guard. */
export function stalePartialGuardMinutesForFind(env = process.env) {
  const minutes = Math.floor(stalePartialMinAgeMs(env) / 60_000);
  return Math.max(1, minutes);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const flag = process.argv[2];
  if (flag === "--guard-minutes") {
    console.log(String(stalePartialGuardMinutesForFind()));
  } else if (flag === "--stale-min-age-ms") {
    console.log(String(stalePartialMinAgeMs()));
  } else {
    console.error("usage: sqlite-pre-migration-backup-timing.mjs --guard-minutes|--stale-min-age-ms");
    process.exitCode = 1;
  }
}
