import { beforeEach } from "vitest";

/**
 * Wave H / E1: the process-local MTD external-cost scan memo is correct for
 * production (same DB, short TTL) but must not leak across vitest fixtures that
 * share a month key with different SQLite contents.
 */
beforeEach(async () => {
  const { clearMtdScanMemo } = await import("./src/lib/mtd-scan-memo");
  clearMtdScanMemo();
});
