import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { parseSqliteDatabasePath } from "@/lib/sqlite-database-url";

const execFileAsync = promisify(execFile);
const CHILD_TIMEOUT_MS = 25_000;
const CHILD_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const MAX_ACTIVE_READERS = 2;
const MAX_PENDING_READERS = 8;
const POOL_SYMBOL = Symbol.for("usage-monitor.sqlite-usage-aggregate-readers.v1");

export type SqliteUsageAggregateMode = "summary" | "daily" | "derived" | "mtd";

type ReaderPool = {
  active: number;
  pending: Array<() => void>;
};

type ChildOptions = {
  timeoutMs?: number;
};

function getReaderPool(): ReaderPool {
  const registry = globalThis as unknown as Record<symbol, unknown>;
  const current = registry[POOL_SYMBOL] as ReaderPool | undefined;
  if (current) return current;
  const pool: ReaderPool = { active: 0, pending: [] };
  registry[POOL_SYMBOL] = pool;
  return pool;
}

async function acquireReader(pool: ReaderPool): Promise<void> {
  if (pool.active < MAX_ACTIVE_READERS) {
    pool.active += 1;
    return;
  }
  if (pool.pending.length >= MAX_PENDING_READERS) {
    throw new Error("SQLite aggregate reader queue is full");
  }
  await new Promise<void>((resolve) => pool.pending.push(resolve));
}

function releaseReader(pool: ReaderPool): void {
  const next = pool.pending.shift();
  if (next) next();
  else pool.active -= 1;
}

function normalizeDate(date: Date, field: string): string {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error(`Invalid SQLite aggregate ${field} date`);
  }
  return date.toISOString().replace(/Z$/, "+00:00");
}

function validateRows(value: unknown): value is Array<Record<string, unknown>> {
  return Array.isArray(value) && value.every((row) =>
    row !== null && typeof row === "object" && !Array.isArray(row)
  );
}

/**
 * Execute one static, read-only SQLite aggregate outside the Next.js event
 * loop.  A process-global bounded pool prevents duplicate Next module copies
 * from oversubscribing memory with reader children.
 */
export async function querySqliteUsageAggregate<T extends Array<Record<string, unknown>>>(
  mode: SqliteUsageAggregateMode,
  since: Date,
  until: Date | undefined,
  databaseUrl = process.env.DATABASE_URL,
  options: ChildOptions = {}
): Promise<T> {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for SQLite usage aggregation");
  }
  const databasePath = parseSqliteDatabasePath(databaseUrl);
  const sinceArg = normalizeDate(since, "since");
  const untilArg = until ? normalizeDate(until, "until") : "";
  if (mode !== "derived" && !untilArg) {
    throw new Error("SQLite aggregate until date is required");
  }

  const pool = getReaderPool();
  await acquireReader(pool);
  try {
    const scriptPath = join(process.cwd(), "scripts", "query-sqlite-usage-aggregate.mjs");
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(
        process.execPath,
        ["--max-old-space-size=64", scriptPath, mode, databasePath, sinceArg, untilArg],
        {
          cwd: process.cwd(),
          timeout: options.timeoutMs ?? CHILD_TIMEOUT_MS,
          killSignal: "SIGKILL",
          maxBuffer: CHILD_MAX_BUFFER_BYTES,
          windowsHide: true,
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
      throw new Error(`Read-only SQLite ${mode} aggregate failed (${code})`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error(`Read-only SQLite ${mode} aggregate returned invalid JSON`);
    }
    if (!validateRows(parsed)) {
      throw new Error(`Read-only SQLite ${mode} aggregate returned invalid rows`);
    }
    return parsed as T;
  } finally {
    releaseReader(pool);
  }
}
