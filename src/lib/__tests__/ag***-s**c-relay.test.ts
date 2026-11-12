import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { setupPrismaSqliteTestDb } from "./setup-test-db";

let dbPath: string;
let prisma: typeof import("@/lib/prisma").prisma;
let fetchUsage: typeof import("../adapters/ag***-s**c-relay").fetchUsage;
let ensureAg***S**cProviderSeeded: typeof import("../ensure-ag***-s**c-provider").ensureAg***S**cProviderSeeded;

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ag***-s**c-relay-test-"));
  dbPath = path.join(dir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;

  setupPrismaSqliteTestDb(dbPath);

  ({ prisma } = await import("@/lib/prisma"));
  ({ fetchUsage } = await import("../adapters/ag***-s**c-relay"));
  ({ ensureAg***S**cProviderSeeded } = await import("../ensure-ag***-s**c-provider"));
});

afterAll(async () => {
  await prisma?.$disconnect();
  if (dbPath && fs.existsSync(dbPath)) {
    fs.rmSync(dbPath, { force: true });
  }
});

describe("ag***-s**c-relay adapter", () => {
  let fetchMock: any;

  beforeEach(() => {
    fetchMock = vi.spyOn(global, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches uptime status successfully when service is up", async () => {
    const mockResponse = new Response(
      JSON.stringify({ ok: true, service: "ag***-s**c-push" }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
    fetchMock.mockResolvedValue(mockResponse);

    const res = await fetchUsage("dummy-key", {
      endpoint: "https://ag***-s**c.jays.services/health",
    });

    expect(res.balance).toBeNull();
    expect(res.totalCost).toBeNull();
    expect(res.costScope).toBe("unknown");
    expect(res.totalRequests).toBeNull();
    expect(res.rawData).toEqual({
      status: "UP",
      data: { ok: true, service: "ag***-s**c-push" },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://ag***-s**c.jays.services/health",
      expect.any(Object)
    );
  });

  it("throws an error when service health check fails", async () => {
    const mockResponse = new Response(
      JSON.stringify({ ok: false, error: "internal error" }),
      { status: 500 }
    );
    fetchMock.mockResolvedValue(mockResponse);

    await expect(
      fetchUsage("dummy-key", {
        endpoint: "https://ag***-s**c.jays.services/health",
      })
    ).rejects.toMatchObject({ code: "HTTP_ERROR", status: 500 });
  });
});

describe("ensureAg***S**cProviderSeeded", () => {
  beforeEach(async () => {
    // Delete any existing ag***-s**c-relay providers for clean state
    const providers = await prisma.provider.findMany({
      where: { name: "ag***-s**c-relay" },
    });
    for (const p of providers) {
      await prisma.provider.delete({ where: { id: p.id } });
    }
  });

  it("seeds the ag***-s**c-relay provider if it does not exist", async () => {
    await ensureAg***S**cProviderSeeded();

    const provider = await prisma.provider.findFirst({
      where: { name: "ag***-s**c-relay" },
    });

    expect(provider).toBeDefined();
    expect(provider?.displayName).toBe("Ag*** S**c Relay");
    expect(provider?.type).toBe("builtin");
    // Wave F / E17: catalog/health-only — inactive, never sub-daily poll.
    expect(provider?.isActive).toBe(false);
    expect(provider?.refreshIntervalMin).toBe(1440);
    expect(provider?.alertConfigGeneration).toBe(0);
  });

  it("does not create a duplicate if provider already exists", async () => {
    await ensureAg***S**cProviderSeeded();
    const countAfterFirst = await prisma.provider.count({
      where: { name: "ag***-s**c-relay" },
    });
    expect(countAfterFirst).toBe(1);

    await ensureAg***S**cProviderSeeded();
    const countAfterSecond = await prisma.provider.count({
      where: { name: "ag***-s**c-relay" },
    });
    expect(countAfterSecond).toBe(1);
  });

  it("increments the alert revision when disabling an existing active relay", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "ag***-s**c-relay",
        displayName: "Ag*** S**c Relay",
        isActive: true,
        refreshIntervalMin: 15,
      },
    });

    await ensureAg***S**cProviderSeeded();

    expect(
      await prisma.provider.findUniqueOrThrow({ where: { id: provider.id } })
    ).toMatchObject({
      isActive: false,
      refreshIntervalMin: 1440,
      alertConfigGeneration: 1,
    });
  });

  it("raises sub-daily refresh floor on an already-inactive relay", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "ag***-s**c-relay",
        displayName: "Ag*** S**c Relay",
        isActive: false,
        refreshIntervalMin: 60,
      },
    });

    await ensureAg***S**cProviderSeeded();

    expect(
      await prisma.provider.findUniqueOrThrow({ where: { id: provider.id } })
    ).toMatchObject({
      isActive: false,
      refreshIntervalMin: 1440,
      alertConfigGeneration: 1,
    });
  });
});
