import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { setupPrismaSqliteTestDb } from "./setup-test-db";

let dbPath: string;
let prisma: typeof import("@/lib/prisma").prisma;
let persistExternalUsageEvents: typeof import("../external-usage-events").persistExternalUsageEvents;
let syncStatusToUsageSnapshot: typeof import("../external-usage-events").syncStatusToUsageSnapshot;

const NOW = new Date("2026-07-15T12:00:00.000Z");

describe("status snapshot atomicity and safe rounding", () => {
  beforeAll(async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-snapshot-test-"));
    dbPath = path.join(tmpDir, "test.db");
    process.env.DATABASE_URL = `file:${dbPath}`;
    setupPrismaSqliteTestDb(dbPath);

    const prismaModule = await import("@/lib/prisma");
    prisma = prismaModule.prisma;
    const eventsModule = await import("../external-usage-events");
    persistExternalUsageEvents = eventsModule.persistExternalUsageEvents;
    syncStatusToUsageSnapshot = eventsModule.syncStatusToUsageSnapshot;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    if (dbPath && fs.existsSync(dbPath)) {
      try {
        fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  beforeEach(async () => {
    await prisma.externalUsageEvent.deleteMany();
    await prisma.usageSnapshot.deleteMany();
    await prisma.provider.deleteMany();
  });

  it("rolls back event persistence when snapshot creation fails within the transaction", async () => {
    await prisma.provider.create({
      data: {
        name: "test-provider",
        displayName: "Test Provider",
        type: "builtin",
      },
    });

    const event = {
      idempotencyKey: "status-atomicity-key-1",
      sourceApp: "test-app",
      provider: "test-provider",
      billingMode: "actual" as const,
      metricType: "quota_sync" as const,
      costUsd: 10,
      quantity: 50,
      occurredAt: NOW,
    };

    // Test that an error inside syncStatusToUsageSnapshot within a transaction rolls back externalUsageEvent inserts
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.externalUsageEvent.create({
          data: {
            idempotencyKey: event.idempotencyKey,
            sourceApp: event.sourceApp,
            provider: event.provider,
            billingMode: event.billingMode,
            metricType: event.metricType,
            costUsd: event.costUsd,
            occurredAt: event.occurredAt,
          },
        });
        // Force syncStatusToUsageSnapshot error using mock transaction client
        const failingTx = {
          ...tx,
          provider: {
            findMany: vi.fn().mockRejectedValue(new Error("Simulated snapshot failure")),
          },
        } as unknown as typeof tx;

        await syncStatusToUsageSnapshot([event], failingTx);
      })
    ).rejects.toThrow("Simulated snapshot failure");

    // Verify atomic rollback: zero events and zero snapshots persisted in DB
    expect(await prisma.externalUsageEvent.count()).toBe(0);
    expect(await prisma.usageSnapshot.count()).toBe(0);

    // Replay with real persistExternalUsageEvents: both event and snapshot persist atomically
    const result = await persistExternalUsageEvents([event]);
    expect(result.persisted).toBe(1);
    expect(await prisma.externalUsageEvent.count()).toBe(1);
    expect(await prisma.usageSnapshot.count()).toBe(1);
  });

  it("safely rounds fractional quantity to totalRequests integer", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "rounding-provider",
        displayName: "Rounding Provider",
        type: "builtin",
      },
    });

    const event = {
      idempotencyKey: "status-rounding-key-1",
      sourceApp: "test-app",
      provider: "rounding-provider",
      billingMode: "actual" as const,
      metricType: "quota_sync" as const,
      costUsd: 5,
      quantity: 1500.7,
      occurredAt: NOW,
    };

    const result = await persistExternalUsageEvents([event]);
    expect(result.persisted).toBe(1);

    const snapshot = await prisma.usageSnapshot.findFirstOrThrow();
    expect(snapshot.providerId).toBe(provider.id);
    expect(snapshot.totalRequests).toBe(1501);
  });

  it("does not create duplicate snapshots on idempotent replay of an already-successful event", async () => {
    await prisma.provider.create({
      data: {
        name: "dedupe-provider",
        displayName: "Dedupe Provider",
        type: "builtin",
      },
    });

    const event = {
      idempotencyKey: "status-dedupe-key-1",
      sourceApp: "test-app",
      provider: "dedupe-provider",
      billingMode: "actual" as const,
      metricType: "quota_sync" as const,
      costUsd: 20,
      quantity: 100,
      occurredAt: NOW,
    };

    const firstRun = await persistExternalUsageEvents([event]);
    expect(firstRun.persisted).toBe(1);
    expect(await prisma.usageSnapshot.count()).toBe(1);

    // Replay exact same event
    const secondRun = await persistExternalUsageEvents([event]);
    expect(secondRun.persisted).toBe(0);
    expect(await prisma.usageSnapshot.count()).toBe(1);
  });
});
