import fs from "node:fs";
import path from "node:path";

// vitest.setup.ts points each worker without its own DATABASE_URL at
// prisma/vitest-worker-<run>-<worker>.db, where <run> is this vitest
// process's pid (UM_VITEST_RUN_ID, set below before workers start).  Nothing
// else removes those files, so this setup does:  on teardown it removes this
// run's files, and before the run it removes files left by runs that are no
// longer alive (a killed run, or the older vitest-worker-<id>.db name).  A
// concurrent run in the same checkout uses its own <run>, so its live files
// are never touched.
const RUN_DB_FILE = /^vitest-worker-(\d+)-\d+\.db(?:-journal|-wal|-shm)?$/;
const LEGACY_DB_FILE = /^vitest-worker-\d+\.db(?:-journal|-wal|-shm)?$/;

export const DEFAULT_FALLBACK_DB_DIR = path.resolve(process.cwd(), "prisma");

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EPERM"
    );
  }
}

/**
 * Removes fallback DB files in `dir`.  `ownRunId` set:  only that run's files.
 * Unset:  files from runs whose process is gone, plus legacy-named files, plus
 * files carrying `startingRunId` (a run that is only starting cannot have
 * created files yet, so those were left by an earlier run with a recycled pid).
 * Best effort:  a file that cannot be removed is skipped, never thrown.
 */
export function removeVitestFallbackDatabases(
  dir: string = DEFAULT_FALLBACK_DB_DIR,
  ownRunId?: number,
  isAlive: (pid: number) => boolean = isProcessAlive,
  startingRunId?: number
): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of entries) {
    const run = RUN_DB_FILE.exec(name);
    let remove: boolean;
    if (run) {
      const runId = Number(run[1]);
      remove =
        ownRunId === undefined
          ? runId === startingRunId || !isAlive(runId)
          : runId === ownRunId;
    } else {
      remove = ownRunId === undefined && LEGACY_DB_FILE.test(name);
    }
    if (!remove) continue;
    try {
      fs.rmSync(path.join(dir, name), { force: true, recursive: true });
      removed.push(name);
    } catch {
      // Housekeeping only:  never abort the test run over a stale file.
    }
  }
  return removed;
}

export default function setup(): () => void {
  const runId = process.pid;
  process.env.UM_VITEST_RUN_ID = String(runId);
  removeVitestFallbackDatabases(DEFAULT_FALLBACK_DB_DIR, undefined, isProcessAlive, runId);
  return () => {
    removeVitestFallbackDatabases(DEFAULT_FALLBACK_DB_DIR, runId);
  };
}
