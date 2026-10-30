import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { parseSqliteDatabasePath } from "@/lib/sqlite-database-url";

const execFileAsync = promisify(execFile);
const CHILD_TIMEOUT_MS = 60_000;
const CHILD_MAX_BUFFER_BYTES = 4 * 1024;

/**
 * Count retention tombstones in a short-lived read-only process.  SQLite's
 * exact cold count can take several seconds; isolating it keeps the Next.js
 * event loop responsive while preserving the exact maintenance statistic.
 */
export async function countExternalUsageEventTombstones(
  databaseUrl = process.env.DATABASE_URL
): Promise<number> {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to count external usage tombstones");
  }

  const databasePath = parseSqliteDatabasePath(databaseUrl);
  const scriptPath = join(process.cwd(), "scripts", "count-sqlite-tombstones.mjs");
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      process.execPath,
      [scriptPath, databasePath],
      {
        cwd: process.cwd(),
        timeout: CHILD_TIMEOUT_MS,
        maxBuffer: CHILD_MAX_BUFFER_BYTES,
        env: {
          PATH: process.env.PATH ?? "",
          NODE_ENV: process.env.NODE_ENV ?? "production",
        },
      }
    ));
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "unknown";
    throw new Error(`Read-only SQLite tombstone count failed (${code})`);
  }

  const value = stdout.trim();
  if (!/^\d+$/.test(value)) {
    throw new Error("Read-only SQLite tombstone count returned invalid output");
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("Read-only SQLite tombstone count exceeded the safe integer range");
  }
  return count;
}
