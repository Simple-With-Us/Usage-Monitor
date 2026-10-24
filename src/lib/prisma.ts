import "server-only";

// @prisma/client is CommonJS (`module.exports = { ...require('#main-entry-point') }`
// in the generated client). Node's ESM named-export interop for a CommonJS
// module depends on static analysis (cjs-module-lexer) of the module source,
// and that spread-based re-export is exactly the shape that analysis cannot
// always resolve - on Node 24 this intermittently leaves a named
// `import { PrismaClient } from "@prisma/client"` binding undefined, throwing
// "PrismaClient is not a constructor" only in some dynamic-import paths (a
// fresh `await import("@/lib/prisma")` in a test file's beforeAll, in
// particular). scripts/ensure-subscription-link-unique-index.mjs carries the
// same fix for the equivalent startup-script hazard (PR #409); this default
// import is the runtime-code sibling of that fix. Default-importing the
// module object sidesteps synthetic named-export detection entirely: the
// constructor is read back out via a plain property access instead.
import type { PrismaClient as PrismaClientInstance } from "@prisma/client";
import { createPrismaClient } from "./create-prisma-client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClientInstance | undefined;
  __apiUsageMonitorSqlitePragmasApplied: Promise<void> | undefined;
};

function clampedIntEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

// Prisma 7 uses the better-sqlite3 driver adapter (single underlying
// connection per PrismaClient). Native page-cache / mmap bounds below are
// applied on that connection in applySqliteNativeMemoryPragmas().

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

// --- Native (non-heap) SQLite memory bounds --------------------------------
// Prisma's default "library" engine for SQLite embeds its own SQLite driver
// as an in-process N-API addon (no separate query-engine process). Its page
// cache and any memory-mapped I/O are native Rust/C allocations that live
// OUTSIDE the V8 heap, so `NODE_OPTIONS=--max-old-space-size` (the heap cap
// added in #387) cannot bound them, and a heap-limit hit would produce a
// distinct "JavaScript heap out of memory" fatal error rather than a silent
// container OOM-kill. A restart cycling between ~440-496MB used and a fresh
// baseline with the heap capped at 350MB points at this native side.
//
// SQLite's compiled-in default page cache is already small (cache_size of
// -2000, ~2MB), but we pin it explicitly so behavior doesn't depend on
// whatever the bundled SQLite amalgamation happened to compile in for
// Render's Linux binary, and so it becomes a documented, tunable knob.
// mmap_size is disabled outright: memory-mapped pages of a 130MB+ database
// count toward the process's resident set the same as any other native
// allocation, and this 512MB container has no slack to let the OS map large
// chunks of the file into the query engine's address space.
//
// Temp B-trees are a separate native-memory risk. EXPLAIN QUERY PLAN shows
// that the current-month ExternalUsageEvent aggregation necessarily uses one
// for GROUP BY; keeping it in memory can transiently consume tens or hundreds
// of MiB on top of the page cache. FILE makes SQLite spill that B-tree to the
// service disk instead. This has identical query semantics, trades a little
// latency/I/O for bounded RSS, and is the safer default in Render's 512MiB
// container. An operator can opt back into MEMORY only with an explicit env
// override after measuring their own headroom.
//
// There is no dedicated per-connection init hook in Prisma's public API for
// SQLite, so this is applied as an explicit, idempotent, awaited step -
// see instrumentation.ts's register(), which Next.js guarantees completes
// before the server accepts any request (so no query can race ahead of it).
// It is applied against the single pooled connection above (see
// withConnectionLimit), and read back to confirm it actually took effect.
export interface SqliteMemoryPragmaValues {
  cacheSizeKib: number;
  mmapSizeBytes: number;
  tempStore: SqliteTempStore;
  journalMode: string;
  busyTimeoutMs: number;
}

export type SqliteTempStore = "default" | "file" | "memory";

// E2a: journal_mode and busy_timeout were previously left to Prisma/SQLite
// defaults (journal=delete, no explicit busy timeout). WAL gives readers and
// the single writer separate locks so a long read (e.g. the MTD groupBy) no
// longer blocks ingest writes behind the whole database file, and an
// explicit busy_timeout makes a genuinely contended write wait briefly
// instead of failing immediately with SQLITE_BUSY. journal_mode is
// persistent on the database file (not per-connection), but it is applied
// and read back through the same verified-pragma path as the memory bounds
// so a rejected PRAGMA is logged loudly rather than silently no-op'ing.
const DEFAULT_SQLITE_BUSY_TIMEOUT_MS = 5_000;

function sqliteJournalModeFromPragma(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : String(value);
}

function sqliteTempStoreFromEnv(): Exclude<SqliteTempStore, "default"> {
  switch (process.env.SQLITE_TEMP_STORE?.trim().toLowerCase()) {
    case "memory":
      return "memory";
    case "file":
    case undefined:
    case "":
      return "file";
    default:
      return "file";
  }
}

function sqliteTempStoreFromPragma(value: unknown): SqliteTempStore {
  switch (Number(value)) {
    case 1:
      return "file";
    case 2:
      return "memory";
    default:
      return "default";
  }
}

export function resolveSqliteMemoryPragmaValues(): SqliteMemoryPragmaValues {
  return {
    // Negative values are KiB per SQLite convention: -2000 = ~2MB cache.
    cacheSizeKib: -Math.abs(clampedIntEnv("SQLITE_CACHE_SIZE_KIB", 2_000, 256, 65_536)),
    // 0 disables mmap I/O entirely; a positive value is a byte ceiling.
    mmapSizeBytes: clampedIntEnv("SQLITE_MMAP_SIZE_BYTES", 0, 0, 268_435_456),
    tempStore: sqliteTempStoreFromEnv(),
    // WAL is not operator-tunable: it is the correctness fix for read/write
    // blocking on the single-connection pool. busy_timeout stays tunable.
    journalMode: "wal",
    busyTimeoutMs: clampedIntEnv(
      "SQLITE_BUSY_TIMEOUT_MS",
      DEFAULT_SQLITE_BUSY_TIMEOUT_MS,
      0,
      60_000
    ),
  };
}

/**
 * Reads the currently-effective cache_size / mmap_size / temp_store /
 * journal_mode / busy_timeout off the live connection. SQLite returns these
 * as 64-bit INTEGERs, which Prisma surfaces as JS BigInt, so each is coerced
 * to Number before returning.
 */
export async function readSqliteMemoryPragmas(): Promise<SqliteMemoryPragmaValues> {
  const cacheRows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    "PRAGMA cache_size"
  );
  const mmapRows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    "PRAGMA mmap_size"
  );
  const tempStoreRows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    "PRAGMA temp_store"
  );
  const journalModeRows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    "PRAGMA journal_mode"
  );
  const busyTimeoutRows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    "PRAGMA busy_timeout"
  );
  return {
    cacheSizeKib: Number(cacheRows[0]?.cache_size),
    mmapSizeBytes: Number(mmapRows[0]?.mmap_size),
    tempStore: sqliteTempStoreFromPragma(tempStoreRows[0]?.temp_store),
    journalMode: sqliteJournalModeFromPragma(journalModeRows[0]?.journal_mode),
    // SQLite names the busy_timeout pragma's result column "timeout".
    busyTimeoutMs: Number(busyTimeoutRows[0]?.timeout),
  };
}

export function applySqliteNativeMemoryPragmas(): Promise<void> {
  if (!globalForPrisma.__apiUsageMonitorSqlitePragmasApplied) {
    globalForPrisma.__apiUsageMonitorSqlitePragmasApplied = (async () => {
      const target = resolveSqliteMemoryPragmaValues();
      try {
        // A PRAGMA assignment RETURNS the applied value as a result row on
        // SQLite, so it must go through the query path. `$executeRaw*` rejects
        // it with "Execute returned results, which is not allowed in SQLite" -
        // which is exactly why an earlier `$executeRawUnsafe` version silently
        // no-op'd and left SQLite's defaults (mmap_size=0, cache_size=-2000)
        // in place, masking the failure whenever those defaults happened to
        // match the target.
        await prisma.$queryRawUnsafe(`PRAGMA cache_size = ${target.cacheSizeKib}`);
        await prisma.$queryRawUnsafe(`PRAGMA mmap_size = ${target.mmapSizeBytes}`);
        await prisma.$queryRawUnsafe(`PRAGMA temp_store = ${target.tempStore.toUpperCase()}`);
        await prisma.$queryRawUnsafe(`PRAGMA journal_mode = ${target.journalMode.toUpperCase()}`);
        await prisma.$queryRawUnsafe(`PRAGMA busy_timeout = ${target.busyTimeoutMs}`);
        // Read the values back on the same connection and confirm they took.
        // A mismatch is logged loudly (never swallowed): it would mean a future
        // engine change rejected a PRAGMA, or connection_limit was raised above
        // 1 and split the pool, either of which silently re-opens the native
        // memory regression this function exists to prevent.
        const applied = await readSqliteMemoryPragmas();
        if (
          applied.cacheSizeKib !== target.cacheSizeKib ||
          applied.mmapSizeBytes !== target.mmapSizeBytes ||
          applied.tempStore !== target.tempStore ||
          applied.journalMode !== target.journalMode ||
          applied.busyTimeoutMs !== target.busyTimeoutMs
        ) {
          console.error(
            `[prisma] SQLite native memory bounds did not take effect ` +
              `(wanted cache_size=${target.cacheSizeKib}, mmap_size=${target.mmapSizeBytes}; ` +
              `temp_store=${target.tempStore}; journal_mode=${target.journalMode}; ` +
              `busy_timeout=${target.busyTimeoutMs}; read back cache_size=${applied.cacheSizeKib}, ` +
              `mmap_size=${applied.mmapSizeBytes}, temp_store=${applied.tempStore}, ` +
              `journal_mode=${applied.journalMode}, busy_timeout=${applied.busyTimeoutMs})`
          );
        }
      } catch (error) {
        console.error(
          "[prisma] failed to apply native SQLite memory bounds; continuing with SQLite defaults",
          error
        );
      }
    })();
  }
  return globalForPrisma.__apiUsageMonitorSqlitePragmasApplied;
}

/**
 * Test-only: clears the module-level memoization so a test can call
 * applySqliteNativeMemoryPragmas again after changing env-driven tuning
 * values. Mirrors resetRuntimeHealthForTests's guard in runtime-health.ts.
 */
export function resetSqliteNativeMemoryPragmasForTests(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(
      "SQLite native memory pragma state can only be reset in tests"
    );
  }
  globalForPrisma.__apiUsageMonitorSqlitePragmasApplied = undefined;
}
