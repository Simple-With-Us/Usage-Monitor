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

/**
 * Wave H / E1: the process-local MTD external-cost scan memo is correct for
 * production (same DB, short TTL) but must not leak across vitest fixtures that
 * share a month key with different SQLite contents.
 */
beforeEach(async () => {
  const { clearMtdScanMemo } = await import("./src/lib/mtd-scan-memo");
  clearMtdScanMemo();
});
