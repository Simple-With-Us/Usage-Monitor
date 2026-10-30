import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { setupPrismaSqliteTestDb } from "./setup-test-db";

// applySqliteNativeMemoryPragmas bounds native (non-heap) SQLite memory on
// the shared Prisma singleton - see the rationale comment in
// src/lib/prisma.ts. These tests exercise it against a real temp SQLite file
// (not a mock) because the whole point is verifying the PRAGMAs actually take
// effect on the connection Prisma's query engine uses.
//
// Anti-regression note: an earlier version applied the PRAGMAs with
// $executeRawUnsafe, which SQLite rejects for statements that return a row
// ("Execute returned results, which is not allowed in SQLite"); the error was
// swallowed, so the code silently no-op'd and left SQLite's defaults
// (cache_size=-2000, mmap_size=0) in place. A test that asserted those exact
// defaults PASSED anyway - a false positive. The tests below therefore drive
// NON-DEFAULT values through the code path so a silent fallback to defaults
// would fail the assertion.

let dbPath: string;

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prisma-native-memory-test-"));
  dbPath = path.join(dir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  setupPrismaSqliteTestDb(dbPath);
});

afterAll(async () => {
  const { prisma } = await import("@/lib/prisma");
  await prisma.$disconnect();
  if (dbPath && fs.existsSync(path.dirname(dbPath))) {
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  const { resetSqliteNativeMemoryPragmasForTests } = await import("@/lib/prisma");
  resetSqliteNativeMemoryPragmasForTests();
});

describe("resolveSqliteMemoryPragmaValues", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to a 2MB cache, mmap disabled, disk-backed temp B-trees, WAL, and a 5s busy timeout", async () => {
    const { resolveSqliteMemoryPragmaValues } = await import("@/lib/prisma");
    expect(resolveSqliteMemoryPragmaValues()).toEqual({
      cacheSizeKib: -2000,
      mmapSizeBytes: 0,
      tempStore: "file",
      journalMode: "wal",
      busyTimeoutMs: 5_000,
      walAutocheckpointPages: 1_000,
    });
  });

  it("honors env overrides and always reports cache size as negative KiB", async () => {
    vi.stubEnv("SQLITE_CACHE_SIZE_KIB", "4000");
    vi.stubEnv("SQLITE_MMAP_SIZE_BYTES", "8388608");
    vi.stubEnv("SQLITE_TEMP_STORE", "memory");
    vi.stubEnv("SQLITE_BUSY_TIMEOUT_MS", "7500");
    const { resolveSqliteMemoryPragmaValues } = await import("@/lib/prisma");
    expect(resolveSqliteMemoryPragmaValues()).toEqual({
      cacheSizeKib: -4000,
      mmapSizeBytes: 8_388_608,
      tempStore: "memory",
      journalMode: "wal",
      busyTimeoutMs: 7_500,
      walAutocheckpointPages: 1_000,
    });
  });

  it("clamps out-of-range or non-numeric overrides back to safe bounds", async () => {
    vi.stubEnv("SQLITE_CACHE_SIZE_KIB", "not-a-number");
    vi.stubEnv("SQLITE_MMAP_SIZE_BYTES", "999999999999");
    vi.stubEnv("SQLITE_TEMP_STORE", "not-a-mode");
    vi.stubEnv("SQLITE_BUSY_TIMEOUT_MS", "999999999999");
    const { resolveSqliteMemoryPragmaValues } = await import("@/lib/prisma");
    const values = resolveSqliteMemoryPragmaValues();
    expect(values.cacheSizeKib).toBe(-2000); // invalid input falls back to default
    expect(values.mmapSizeBytes).toBe(268_435_456); // clamped to the 256MB ceiling
    expect(values.tempStore).toBe("file"); // invalid input fails closed to the RSS-safe mode
    expect(values.busyTimeoutMs).toBe(60_000); // clamped to the 60s ceiling
  });
});

describe("applySqliteNativeMemoryPragmas", () => {
  it("actually applies NON-DEFAULT bounds to the live connection, with no error logged", async () => {
    // Deliberately different from SQLite's defaults (-2000 / 0) so the
    // read-back proves the code drove these values. The no-error assertion is
    // essential to fully catch the $executeRaw regression: SQLite applies a
    // PRAGMA's side effect BEFORE returning the row that makes Prisma's
    // execute-path throw, so the value can leak through even on the broken
    // path - but that path logs a swallowed error, which this test rejects.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubEnv("SQLITE_CACHE_SIZE_KIB", "1234");
    vi.stubEnv("SQLITE_MMAP_SIZE_BYTES", "1048576");
    vi.stubEnv("SQLITE_TEMP_STORE", "memory");
    vi.stubEnv("SQLITE_BUSY_TIMEOUT_MS", "4321");
    const { applySqliteNativeMemoryPragmas, readSqliteMemoryPragmas } = await import(
      "@/lib/prisma"
    );

    await applySqliteNativeMemoryPragmas();

    const applied = await readSqliteMemoryPragmas();
    expect(applied).toEqual({
      cacheSizeKib: -1234,
      mmapSizeBytes: 1_048_576,
      tempStore: "memory",
      journalMode: "wal",
      busyTimeoutMs: 4_321,
      walAutocheckpointPages: 1_000,
    });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("pins the ~2MB cache, disables mmap, uses disk-backed temp storage, WAL, and a 5s busy timeout by default", async () => {
    const { applySqliteNativeMemoryPragmas, readSqliteMemoryPragmas } = await import(
      "@/lib/prisma"
    );

    await applySqliteNativeMemoryPragmas();

    expect(await readSqliteMemoryPragmas()).toEqual({
      cacheSizeKib: -2000,
      mmapSizeBytes: 0,
      tempStore: "file",
      journalMode: "wal",
      busyTimeoutMs: 5_000,
      walAutocheckpointPages: 1_000,
    });
  });

  it("does not log an application-failure error on the happy path", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { applySqliteNativeMemoryPragmas } = await import("@/lib/prisma");

    await applySqliteNativeMemoryPragmas();

    // Neither the swallowed-exception path nor the read-back-mismatch path
    // should fire when the bounds apply cleanly.
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("logs and continues when a SQLite memory PRAGMA is rejected at startup", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { prisma, applySqliteNativeMemoryPragmas } = await import("@/lib/prisma");
    vi.spyOn(prisma, "$queryRawUnsafe").mockRejectedValueOnce(new Error("pragma unavailable"));

    await expect(applySqliteNativeMemoryPragmas()).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      "[prisma] failed to apply native SQLite memory bounds; continuing with SQLite defaults",
      expect.any(Error)
    );
  });

  it("uses the query path, not the execute path (which SQLite rejects for PRAGMA)", async () => {
    const { prisma, applySqliteNativeMemoryPragmas } = await import("@/lib/prisma");
    const querySpy = vi.spyOn(prisma, "$queryRawUnsafe");
    const executeSpy = vi.spyOn(prisma, "$executeRawUnsafe");

    await applySqliteNativeMemoryPragmas();

    const setCalls = querySpy.mock.calls
      .map((call) => String(call[0]))
      .filter((sql) =>
        /PRAGMA (cache_size|mmap_size|temp_store|journal_mode|busy_timeout|wal_autocheckpoint)\s*=/.test(sql)
      );
    expect(setCalls).toHaveLength(6);
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("disables app-side WAL autocheckpoints only when Litestream owns checkpoints", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubEnv("LITESTREAM_ACTIVE", "true");
    vi.stubEnv("APP_STARTUP_WRAPPER", "start-with-litestream-v2");
    vi.stubEnv("LITESTREAM_S3_BUCKET", "test-r2-bucket");
    vi.stubEnv("LITESTREAM_S3_ENDPOINT", "account.r2.cloudflarestorage.com");
    vi.stubEnv("LITESTREAM_S3_ACCESS_KEY_ID", "test-access-key");
    vi.stubEnv("LITESTREAM_S3_SECRET_ACCESS_KEY", "test-secret-key");
    const { applySqliteNativeMemoryPragmas, readSqliteMemoryPragmas } = await import(
      "@/lib/prisma"
    );

    await applySqliteNativeMemoryPragmas();

    expect((await readSqliteMemoryPragmas()).walAutocheckpointPages).toBe(0);
    expect(errorSpy).not.toHaveBeenCalled();

    // The R2 kill switch hands checkpoints back to SQLite at runtime.
    const { enforceR2AutoDisable, clearR2AutoDisable, __resetR2UsageStateForTests } = await import(
      "@/lib/r2-usage"
    );
    // enforceR2AutoDisable writes these directly; stub first so
    // vi.unstubAllEnvs restores them for later tests.
    vi.stubEnv("LITESTREAM_EMERGENCY_DISABLE", "");
    vi.stubEnv("R2_WRITES_DISABLED", "");
    await enforceR2AutoDisable("test: wal hook");
    expect((await readSqliteMemoryPragmas()).walAutocheckpointPages).toBe(1_000);
    expect(process.env.LITESTREAM_ACTIVE).toBe("false");

    await clearR2AutoDisable("test: resume hook");
    expect((await readSqliteMemoryPragmas()).walAutocheckpointPages).toBe(0);
    expect(process.env.LITESTREAM_ACTIVE).toBe("true");
    __resetR2UsageStateForTests();

    // Without Litestream nothing else checkpoints, so SQLite's default returns.
    vi.unstubAllEnvs();
    const { resetSqliteNativeMemoryPragmasForTests } = await import("@/lib/prisma");
    resetSqliteNativeMemoryPragmasForTests();
    await applySqliteNativeMemoryPragmas();
    expect((await readSqliteMemoryPragmas()).walAutocheckpointPages).toBe(1_000);
  });

  it("registers the persistent checkpoint hook when Litestream is inactive at boot", async () => {
    vi.stubEnv("LITESTREAM_ACTIVE", "false");
    const { applySqliteNativeMemoryPragmas, readSqliteMemoryPragmas } = await import(
      "@/lib/prisma"
    );
    await applySqliteNativeMemoryPragmas();
    expect((await readSqliteMemoryPragmas()).walAutocheckpointPages).toBe(1_000);

    const setCheckpoint = (globalThis as Record<string, unknown>)[
      "__apiUsageMonitorSetWalAutocheckpoint"
    ];
    expect(typeof setCheckpoint).toBe("function");
    await (setCheckpoint as (pages: 0 | 1_000) => Promise<void>)(0);
    expect((await readSqliteMemoryPragmas()).walAutocheckpointPages).toBe(0);
    await (setCheckpoint as (pages: 0 | 1_000) => Promise<void>)(1_000);
    expect((await readSqliteMemoryPragmas()).walAutocheckpointPages).toBe(1_000);
  });

  it("is idempotent - a second call does not re-issue the PRAGMAs", async () => {
    const { prisma, applySqliteNativeMemoryPragmas } = await import("@/lib/prisma");
    const spy = vi.spyOn(prisma, "$queryRawUnsafe");

    await applySqliteNativeMemoryPragmas();
    const callsAfterFirst = spy.mock.calls.length;
    await applySqliteNativeMemoryPragmas();

    expect(spy.mock.calls.length).toBe(callsAfterFirst);
  });
});
