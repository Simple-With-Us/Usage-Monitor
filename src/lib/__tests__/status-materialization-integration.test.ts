import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { setupPrismaSqliteTestDb } from "./setup-test-db";

let dbPath: string;
let prisma: typeof import("@/lib/prisma").prisma;
let persistExternalUsageEvents: typeof import("../external-usage-events").persistExternalUsageEvents;

const OCCURRED_AT = new Date("2026-07-11T18:00:00.000Z");

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "status-materialization-test-"));
  dbPath = path.join(dir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  setupPrismaSqliteTestDb(dbPath);

  ({ prisma } = await import("@/lib/prisma"));
  ({ persistExternalUsageEvents } = await import("../external-usage-events"));
}, 60_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (dbPath && fs.existsSync(dbPath)) fs.rmSync(dbPath, { force: true });
});

beforeEach(async () => {
  await prisma.externalUsageEventTombstone.deleteMany();
  await prisma.externalUsageEvent.deleteMany();
  await prisma.usageSnapshot.deleteMany();
  await prisma.provider.deleteMany();
});

function creditEvent(overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: "status-event-1",
    sourceApp: "socratic-trade",
    provider: "openai",
    billingMode: "actual",
    metricType: "credit_balance",
    credits: 42,
    occurredAt: OCCURRED_AT,
    ...overrides,
  } as Parameters<typeof persistExternalUsageEvents>[0][number];
}

describe("durable status materialization", () => {
  it("materializes raw status and snapshot atomically and dedupes retries", async () => {
    const provider = await prisma.provider.create({
      data: { name: "openai", displayName: "OpenAI" },
    });

    await persistExternalUsageEvents([creditEvent()]);
    await persistExternalUsageEvents([creditEvent()]);

    expect(await prisma.externalUsageEvent.count()).toBe(1);
    const snapshots = await prisma.usageSnapshot.findMany();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      providerId: provider.id,
      credits: 42,
      statusEventKey: "status-event-1",
    });
  });

  it("repairs an initially ambiguous event when the same event is retried", async () => {
    const first = await prisma.provider.create({
      data: { name: "openai", displayName: "OpenAI A" },
    });
    await prisma.provider.create({
      data: { name: "OpenAI", displayName: "OpenAI B" },
    });
    const event = creditEvent({ keyRef: "account-a" });

    await persistExternalUsageEvents([event]);
    expect(await prisma.externalUsageEvent.count()).toBe(1);
    expect(await prisma.usageSnapshot.count()).toBe(0);

    await prisma.provider.update({
      where: { id: first.id },
      data: { config: { statusKeyRef: "account-a" } },
    });
    await persistExternalUsageEvents([event]);
    await persistExternalUsageEvents([event]);

    expect(await prisma.usageSnapshot.findMany()).toEqual([
      expect.objectContaining({
        providerId: first.id,
        credits: 42,
        statusEventKey: "status-event-1",
      }),
    ]);
  });

  it("rolls back the raw event when snapshot persistence fails", async () => {
    await prisma.provider.create({
      data: { name: "openai", displayName: "OpenAI" },
    });
    const invalid = creditEvent({
      metricType: "quota_sync",
      credits: undefined,
      requests: 2_147_483_648,
    });

    await expect(persistExternalUsageEvents([invalid])).rejects.toThrow();
    expect(await prisma.externalUsageEvent.count()).toBe(0);
    expect(await prisma.usageSnapshot.count()).toBe(0);

    await persistExternalUsageEvents([
      { ...invalid, requests: 12 },
    ]);
    expect(await prisma.externalUsageEvent.count()).toBe(1);
    expect(await prisma.usageSnapshot.findFirst()).toMatchObject({
      totalRequests: 12,
      statusEventKey: "status-event-1",
    });
  });

  it("adopts a matching legacy snapshot instead of duplicating it", async () => {
    const provider = await prisma.provider.create({
      data: { name: "openai", displayName: "OpenAI" },
    });
    const legacy = await prisma.usageSnapshot.create({
      data: { providerId: provider.id, fetchedAt: OCCURRED_AT, credits: 42 },
    });

    await persistExternalUsageEvents([creditEvent()]);

    expect(await prisma.usageSnapshot.count()).toBe(1);
    expect(await prisma.usageSnapshot.findUnique({ where: { id: legacy.id } })).toMatchObject({
      statusEventKey: "status-event-1",
    });
  });
});
