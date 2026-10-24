import fs from "node:fs";
import path from "node:path";

// vitest.setup.ts points each worker without its own DATABASE_URL at
// prisma/vitest-worker-<id>.db.  Those files (and their WAL sidecars) are
// per-worker, but nothing else removes them, so they would pile up across
// runs.  Clear them before the run (stale files from a killed run) and after.
const FALLBACK_DB_FILE = /^vitest-worker-\d+\.db(?:-journal|-wal|-shm)?$/;

export function removeVitestFallbackDatabases(
  dir: string = path.resolve(process.cwd(), "prisma")
): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of entries) {
    if (!FALLBACK_DB_FILE.test(name)) continue;
    fs.rmSync(path.join(dir, name), { force: true });
    removed.push(name);
  }
  return removed;
}

export default function setup(): () => void {
  removeVitestFallbackDatabases();
  return () => {
    removeVitestFallbackDatabases();
  };
}
