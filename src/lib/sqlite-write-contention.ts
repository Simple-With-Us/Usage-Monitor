/** Only known SQLite lock errors qualify for a retryable busy response. */
export function sqliteWriteContentionCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const meta = (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } } }).meta;
  const code = meta?.driverAdapterError?.cause?.originalCode;
  return typeof code === "string" && /^SQLITE_(?:BUSY|LOCKED)(?:_[A-Z]+)*$/.test(code)
    ? code
    : null;
}
