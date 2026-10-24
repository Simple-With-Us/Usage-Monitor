import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupPrismaSqliteTestDb } from "./setup-test-db";

// prisma.ts caches the client on globalThis outside production, and
// vi.resetModules() does not clear it.  Drop it around each test so every
// test resolves a client for its own DATABASE_URL.
function dropCachedGlobalClient() {
  delete (globalThis as unknown as { prisma?: unknown }).prisma;
}

describe("prisma deferred singleton proxy", () => {
  beforeEach(dropCachedGlobalClient);

  afterEach(() => {
    dropCachedGlobalClient();
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

  it("answers `in` checks like the real client, without constructing it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prisma-deferred-in-"));
    const dbPath = path.join(dir, "test.db");
    vi.stubEnv("DATABASE_URL", `file:${dbPath}`);
    setupPrismaSqliteTestDb(dbPath);
    vi.resetModules();

    const { createPrismaClient } = await import("@/lib/create-prisma-client");
    const real = createPrismaClient({ databaseUrl: `file:${dbPath}` });
    const createSpy = vi.fn();
    vi.doMock("@/lib/create-prisma-client", async (importOriginal) => {
      const mod = await importOriginal<typeof import("@/lib/create-prisma-client")>();
      return {
        ...mod,
        createPrismaClient: (...args: Parameters<typeof mod.createPrismaClient>) => {
          createSpy();
          return mod.createPrismaClient(...args);
        },
      };
    });
    const { prisma } = await import("@/lib/prisma");

    // Every public `$` member and model the real client has, plus misses.
    const publicKeys = [
      ...Reflect.ownKeys(real).filter(
        (key): key is string => typeof key === "string" && !key.startsWith("_")
      ),
      "$notARealMethod",
      "notAModel",
      "then",
    ];
    for (const key of publicKeys) {
      expect([key, key in prisma]).toEqual([key, key in real]);
    }
    expect(createSpy).not.toHaveBeenCalled();

    // After construction every key, private ones included, matches exactly.
    expect(typeof prisma.provider.findMany).toBe("function");
    expect(createSpy).toHaveBeenCalledTimes(1);
    for (const key of [...publicKeys, "_engine", "_notARealField"]) {
      expect([key, key in prisma]).toEqual([key, key in real]);
    }

    vi.doUnmock("@/lib/create-prisma-client");
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
