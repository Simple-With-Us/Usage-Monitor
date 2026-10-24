import { beforeEach } from "vitest";

// Synthetic Infisical universal-auth material for offline app-settings tests.
// Never use real credentials; values are injected at runtime, not hardcoded in
// test bodies.
process.env.TEST_INFISICAL_CLIENT_ID ??=
  "synthetic-test-infisical-client-id";
process.env.TEST_INFISICAL_CLIENT_SECRET ??=
  "synthetic-test-infisical-client-secret";
process.env.INFISICAL_UM_PROJECT_ID ??=
  "synthetic-test-infisical-project-id";

// Prisma 7 requires a driver adapter at client construction; many unit tests
// import modules that touch the shared prisma singleton without a per-file DB.
// The file is per run and per worker;  vitest.global-setup.ts removes it.
const vitestRunId = process.env.UM_VITEST_RUN_ID ?? String(process.ppid);
const vitestWorkerId = process.env.VITEST_WORKER_ID ?? "0";
process.env.DATABASE_URL ??= `file:./prisma/vitest-worker-${vitestRunId}-${vitestWorkerId}.db`;

/**
 * Wave H / E1: the process-local MTD external-cost scan memo is correct for
 * production (same DB, short TTL) but must not leak across vitest fixtures that
 * share a month key with different SQLite contents.
 */
beforeEach(async () => {
  const { clearMtdScanMemo } = await import("./src/lib/mtd-scan-memo");
  clearMtdScanMemo();
});
