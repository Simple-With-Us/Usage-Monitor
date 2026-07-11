import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { setupPrismaSqliteTestDb } from "./setup-test-db";

let dbPath: string;
let prisma: typeof import("@/lib/prisma").prisma;
let fetchUsage: typeof import("../adapters/agent-sync-relay").fetchUsage;
let ensureAgentSyncProviderSeeded: typeof import("../ensure-agent-sync-provider").ensureAgentSyncProviderSeeded;

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-sync-relay-test-"));
  dbPath = path.join(dir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;

  setupPrismaSqliteTestDb(dbPath);

  ({ prisma } = await import("@/lib/prisma"));
  ({ fetchUsage } = await import("../adapters/agent-sync-relay"));
  ({ ensureAgentSyncProviderSeeded } = await import("../ensure-agent-sync-provider"));
});

afterAll(async () => {
  await prisma?.$disconnect();
  if (dbPath && fs.existsSync(dbPath)) {
    fs.rmSync(dbPath, { force: true });
  }
});

describe("agent-sync-relay adapter", () => {
  let fetchMock: any;

  beforeEach(() => {
    fetchMock = vi.spyOn(global, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches uptime status successfully when service is up", async () => {
    const mockResponse = new Response(
      JSON.stringify({ ok: true, service: "agent-sync-push" }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
    fetchMock.mockResolvedValue(mockResponse);

    const res = await fetchUsage("dummy-key", {
      endpoint: "https://agent-sync.jays.services/health",
    });

    expect(res.balance).toBeNull();
    expect(res.totalCost).toBe(0);
    expect(res.totalRequests).toBeNull();
    expect(res.rawData).toEqual({
      status: "UP",
      data: { ok: true, service: "agent-sync-push" },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://agent-sync.jays.services/health",
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
        endpoint: "https://agent-sync.jays.services/health",
      })
    ).rejects.toMatchObject({ code: "HTTP_ERROR", status: 500 });
  });
});

describe("ensureAgentSyncProviderSeeded", () => {
  beforeEach(async () => {
    // Delete any existing agent-sync-relay providers for clean state
    const providers = await prisma.provider.findMany({
      where: { name: "agent-sync-relay" },
    });
    for (const p of providers) {
      await prisma.provider.delete({ where: { id: p.id } });
    }
  });

  it("seeds the agent-sync-relay provider if it does not exist", async () => {
    await ensureAgentSyncProviderSeeded();

    const provider = await prisma.provider.findFirst({
      where: { name: "agent-sync-relay" },
    });

    expect(provider).toBeDefined();
    expect(provider?.displayName).toBe("Agent Sync Relay");
    expect(provider?.type).toBe("builtin");
    expect(provider?.refreshIntervalMin).toBe(15);
  });

  it("does not create a duplicate if provider already exists", async () => {
    await ensureAgentSyncProviderSeeded();
    const countAfterFirst = await prisma.provider.count({
      where: { name: "agent-sync-relay" },
    });
    expect(countAfterFirst).toBe(1);

    await ensureAgentSyncProviderSeeded();
    const countAfterSecond = await prisma.provider.count({
      where: { name: "agent-sync-relay" },
    });
    expect(countAfterSecond).toBe(1);
  });
});
