const CONTENTION_CODES = new Set([
  "SQLITE_BUSY", "SQLITE_BUSY_RECOVERY", "SQLITE_BUSY_SNAPSHOT", "SQLITE_BUSY_TIMEOUT",
  "SQLITE_LOCKED", "SQLITE_LOCKED_SHAREDCACHE", "SQLITE_LOCKED_VTAB",
]);

/** Only known SQLite lock errors qualify for a retryable busy response. */
export function sqliteWriteContentionCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const meta = (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } } }).meta;
  const code = meta?.driverAdapterError?.cause?.originalCode;
  return typeof code === "string" && CONTENTION_CODES.has(code)
    ? code
    : null;
}
