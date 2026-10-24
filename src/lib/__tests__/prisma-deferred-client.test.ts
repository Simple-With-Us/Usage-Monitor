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
    const savedUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    vi.resetModules();

    const { prisma } = await import("@/lib/prisma");
    expect("$queryRawUnsafe" in prisma).toBe(true);
    expect("provider" in prisma).toBe(true);
    expect(() => prisma.provider).toThrow(/DATABASE_URL is required/);

    process.env.DATABASE_URL = savedUrl;
  });

  it("restores real delegates after vi.spyOn().mockRestore()", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prisma-deferred-proxy-"));
    const dbPath = path.join(dir, "test.db");
    process.env.DATABASE_URL = `file:${dbPath}`;
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
