import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setupPrismaSqliteTestDb } from "./setup-test-db";

describe("prisma deferred singleton proxy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("does not construct the client for `in` checks when DATABASE_URL is unset", async () => {
    // vi.stubEnv (not a direct assignment) so afterEach's vi.unstubAllEnvs()
    // restores the worker's original DATABASE_URL for later test files.
    vi.stubEnv("DATABASE_URL", undefined);
    vi.resetModules();

    const { prisma } = await import("@/lib/prisma");
    expect("$queryRawUnsafe" in prisma).toBe(true);
    expect("provider" in prisma).toBe(true);
    expect("$notARealMethod" in prisma).toBe(false);
    expect("notAModel" in prisma).toBe(false);
    expect(() => prisma.provider).toThrow(/DATABASE_URL is required/);
  });

  it("answers `in` checks exactly like the real client", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prisma-deferred-in-"));
    const dbPath = path.join(dir, "test.db");
    vi.stubEnv("DATABASE_URL", `file:${dbPath}`);
    setupPrismaSqliteTestDb(dbPath);
    vi.resetModules();

    const { createPrismaClient } = await import("@/lib/create-prisma-client");
    const real = createPrismaClient({ databaseUrl: `file:${dbPath}` });
    const { prisma } = await import("@/lib/prisma");
    const keys = [
      "$queryRawUnsafe",
      "$transaction",
      "$extends",
      "_engine",
      "provider",
      "appSetting",
      "$notARealMethod",
      "_notARealField",
      "notAModel",
      "then",
    ];
    for (const key of keys) expect([key, key in prisma]).toEqual([key, key in real]);
    expect(typeof prisma.provider.findMany).toBe("function");
    for (const key of keys) expect([key, key in prisma]).toEqual([key, key in real]);

    await real.$disconnect();
    await prisma.$disconnect();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("restores real delegates after vi.spyOn().mockRestore()", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prisma-deferred-proxy-"));
    const dbPath = path.join(dir, "test.db");
    vi.stubEnv("DATABASE_URL", `file:${dbPath}`);
    setupPrismaSqliteTestDb(dbPath);
    vi.resetModules();

    const { prisma } = await import("@/lib/prisma");
    const spy = vi.spyOn(prisma, "$queryRawUnsafe").mockResolvedValue([]);
    expect(spy).toHaveBeenCalledTimes(0);

    spy.mockRestore();
    expect(typeof prisma.$queryRawUnsafe).toBe("function");
    expect(
      Object.getOwnPropertyDescriptor(prisma, "$queryRawUnsafe")?.value
    ).toBeUndefined();

    await prisma.$disconnect();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
