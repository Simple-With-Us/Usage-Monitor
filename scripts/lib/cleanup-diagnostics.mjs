const OPERATIONS = new Set(["arguments", "read-proof", "read-index", "validate-shards", "verify-backup", "create-client", "configure-wal", "inventory", "read-shard", "read-receipt", "apply-shard", "writer-lock", "reread-rows", "write-tombstones", "delete-candidates", "commit-shard", "verify-shard", "write-receipt", "build-plan", "write-plan", "disconnect"]);
const ERROR_NAMES = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "UnsupportedPlatformError", "PrismaClientKnownRequestError", "PrismaClientUnknownRequestError", "PrismaClientInitializationError", "PrismaClientRustPanicError", "PrismaClientValidationError"]);
// Fixed SQLite result names: https://www.sqlite.org/rescode.html
const SQLITE_CODES = new Set(["SQLITE_ABORT", "SQLITE_ABORT_ROLLBACK", "SQLITE_AUTH", "SQLITE_BUSY", "SQLITE_BUSY_RECOVERY", "SQLITE_BUSY_SNAPSHOT", "SQLITE_BUSY_TIMEOUT", "SQLITE_CANTOPEN", "SQLITE_CONSTRAINT", "SQLITE_CONSTRAINT_CHECK", "SQLITE_CONSTRAINT_DATATYPE", "SQLITE_CONSTRAINT_FOREIGNKEY", "SQLITE_CONSTRAINT_NOTNULL", "SQLITE_CONSTRAINT_PRIMARYKEY", "SQLITE_CONSTRAINT_ROWID", "SQLITE_CONSTRAINT_UNIQUE", "SQLITE_CORRUPT", "SQLITE_FULL", "SQLITE_INTERRUPT", "SQLITE_IOERR", "SQLITE_IOERR_READ", "SQLITE_IOERR_WRITE", "SQLITE_IOERR_FSYNC", "SQLITE_LOCKED", "SQLITE_LOCKED_SHAREDCACHE", "SQLITE_LOCKED_VTAB", "SQLITE_MISMATCH", "SQLITE_MISUSE", "SQLITE_NOMEM", "SQLITE_NOTADB", "SQLITE_READONLY", "SQLITE_SCHEMA", "SQLITE_TOOBIG"]);

export function cleanupFailureDiagnostic(error, context = {}) {
  const result = { phase: "cleanup-maintenance", errorName: ERROR_NAMES.has(error?.name) ? error.name : "Error",
    operation: OPERATIONS.has(context.operation) ? context.operation : "arguments" };
  if (Number.isSafeInteger(context.shardOrdinal) && context.shardOrdinal >= 1 && context.shardOrdinal <= 10_000) result.shardOrdinal = context.shardOrdinal;
  if (typeof error?.code === "string" && /^P[0-9]{4}$/.test(error.code)) result.prismaCode = error.code;
  const sqlite = [error?.code, error?.cause?.code, error?.meta?.driverAdapterError?.cause?.originalCode].find((code) => SQLITE_CODES.has(code));
  if (sqlite) result.sqliteCode = sqlite;
  return result;
}
