import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => {
  const client: any = {
    __transactionDepth: 0,
    provider: { findMany: vi.fn() },
    usageSnapshot: { findMany: vi.fn(), deleteMany: vi.fn() },
    usageSnapshotDailyRollup: { findMany: vi.fn(), findUnique: vi.fn(), upsert: vi.fn() },
    externalUsageEvent: { findMany: vi.fn(), deleteMany: vi.fn() },
    externalUsageEventDailyRollup: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    externalUsageEventTombstone: { findMany: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
    $executeRawUnsafe: vi.fn(),
  };
  client.$transaction = vi.fn(async (fn: (tx: any) => Promise<any>) => {
    client.__transactionDepth += 1;
    try {
      return await fn(client);
    } finally {
      client.__transactionDepth -= 1;
    }
  });
  return client;
});

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

import {
  getExternalEventRawCutoff,
  getSnapshotRawCutoff,
  isAutomaticVacuumEnabled,
  runUsageRetention,
  startOfUtcDay,
} from "../usage-retention";
import { tryAcquireIngestAdmission } from "../ingest-admission";

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.USAGE_SNAPSHOT_RAW_RETENTION_DAYS;
  delete process.env.EXTERNAL_USAGE_EVENT_RAW_RETENTION_DAYS;
  delete process.env.EXTERNAL_USAGE_EVENT_TOMBSTONE_RETENTION_DAYS;
  delete process.env.DATA_RETENTION_BATCH_SIZE;
  delete process.env.DATA_RETENTION_ENABLE_VACUUM;
  delete process.env.DATA_RETENTION_DISABLE_VACUUM;
}

describe("usage-retention wrapper", () => {
  beforeEach(() => {
    resetEnv();
    vi.clearAllMocks();
    prismaMock.__transactionDepth = 0;
    // Wave I / E6 rehash runs first in retention; empty by default.
    prismaMock.externalUsageEventDailyRollup.findMany.mockResolvedValue([]);
  });

  afterEach(() => {
    resetEnv();
  });

  it("normalizes day boundaries in UTC", () => {
    expect(startOfUtcDay(new Date("2026-07-03T23:59:59.999-05:00")).toISOString()).toBe(
      "2026-07-04T00:00:00.000Z"
    );
  });

  it("reads configurable retention windows from env", () => {
    process.env.USAGE_SNAPSHOT_RAW_RETENTION_DAYS = "45";
    process.env.EXTERNAL_USAGE_EVENT_RAW_RETENTION_DAYS = "90";

    expect(getSnapshotRawCutoff(new Date("2026-07-04T12:00:00.000Z")).toISOString()).toBe(
      "2026-05-20T12:00:00.000Z"
    );
    expect(getExternalEventRawCutoff(new Date("2026-07-04T12:00:00.000Z")).toISOString()).toBe(
      "2026-04-05T12:00:00.000Z"
    );
  });

  it("never prunes external events inside the current month boundary", () => {
    process.env.EXTERNAL_USAGE_EVENT_RAW_RETENTION_DAYS = "1";

    expect(getExternalEventRawCutoff(new Date("2026-07-04T12:00:00.000Z")).toISOString()).toBe(
      "2026-07-01T00:00:00.000Z"
    );
  });

  it("keeps exclusive full-database compaction disabled unless explicitly enabled", () => {
    expect(isAutomaticVacuumEnabled({})).toBe(false);
    expect(
      isAutomaticVacuumEnabled({ DATA_RETENTION_ENABLE_VACUUM: "true" })
    ).toBe(true);
    expect(
      isAutomaticVacuumEnabled({
        DATA_RETENTION_ENABLE_VACUUM: "true",
        DATA_RETENTION_DISABLE_VACUUM: "1",
      })
    ).toBe(false);
    expect(
      isAutomaticVacuumEnabled({ DATA_RETENTION_ENABLE_VACUUM: "unexpected" })
    ).toBe(false);
  });

  it("does not hold write admission while a retention scan is waiting on a read", async () => {
    prismaMock.provider.findMany.mockResolvedValue([]);
    let resolveSnapshotScan: ((rows: never[]) => void) | undefined;
    prismaMock.usageSnapshot.findMany.mockImplementationOnce(
      () => new Promise<never[]>((resolve) => { resolveSnapshotScan = resolve; })
    );
    prismaMock.externalUsageEvent.findMany.mockResolvedValue([]);

    const retention = runUsageRetention(new Date("2026-07-04T12:00:00.000Z"));
    await vi.waitFor(() =>
      expect(prismaMock.usageSnapshot.findMany).toHaveBeenCalledOnce()
    );

    const releaseHttpWriter = tryAcquireIngestAdmission();
    expect(releaseHttpWriter).not.toBeNull();
    releaseHttpWriter?.();
    resolveSnapshotScan?.([]);

    await expect(retention).resolves.toMatchObject({
      usageSnapshots: { scanned: 0, pruned: 0 },
      externalUsageEvents: { scanned: 0, pruned: 0 },
    });
  });

  it("aggregates old rows before pruning them", async () => {
    process.env.USAGE_SNAPSHOT_RAW_RETENTION_DAYS = "45";
    process.env.EXTERNAL_USAGE_EVENT_RAW_RETENTION_DAYS = "90";
    process.env.EXTERNAL_USAGE_EVENT_TOMBSTONE_RETENTION_DAYS = "180";
    process.env.DATA_RETENTION_BATCH_SIZE = "1000";

    prismaMock.provider.findMany.mockResolvedValue([
      {
        snapshots: [{ id: "snap-latest" }],
      },
    ]);

    prismaMock.usageSnapshot.findMany.mockResolvedValue([
      {
        id: "snap-old-1",
        providerId: "prov-a",
        fetchedAt: new Date("2026-05-01T00:00:00.000Z"),
        balance: 10,
        totalCost: 1,
        totalRequests: 2,
        credits: 3,
      },
      {
        id: "snap-old-2",
        providerId: "prov-a",
        fetchedAt: new Date("2026-05-01T06:00:00.000Z"),
        balance: 7,
        totalCost: 5,
        totalRequests: 9,
        credits: 6,
      },
    ]);
    prismaMock.usageSnapshotDailyRollup.findMany.mockResolvedValue([]);
    prismaMock.usageSnapshotDailyRollup.findUnique.mockResolvedValue(null);

    const externalRows = [
      {
        id: "evt-1",
        idempotencyKey: "evt-1",
        sourceApp: "socratic-trade",
        environment: "prod",
        provider: "anthropic",
        service: "claude-code",
        label: "model",
        keyRef: "gpt-5.5",
        billingMode: "estimated",
        metricType: "usage",
        quantity: 100,
        unit: "token",
        costUsd: 1.5,
        requests: 2,
        credits: 0.5,
        limit: 1000,
        limitWindow: "month",
        tier: "pro",
        confidence: "estimated",
        projectId: null,
        occurredAt: new Date("2026-04-01T03:00:00.000Z"),
      },
      {
        id: "evt-2",
        idempotencyKey: "evt-2",
        sourceApp: "socratic-trade",
        environment: "prod",
        provider: "anthropic",
        service: "claude-code",
        label: "model",
        keyRef: "gpt-5.5",
        billingMode: "estimated",
        metricType: "usage",
        quantity: 25,
        unit: "token",
        costUsd: 0.75,
        requests: 1,
        credits: 0.25,
        limit: 1200,
        limitWindow: "month",
        tier: "pro",
        confidence: "estimated",
        projectId: null,
        occurredAt: new Date("2026-04-01T09:00:00.000Z"),
      },
    ];
    prismaMock.externalUsageEvent.findMany.mockImplementation(async () => {
      // The raw attribution selected here must be the same version rolled up
      // and deleted by this transaction.
      expect(prismaMock.__transactionDepth).toBeGreaterThan(0);
      return externalRows;
    });
    prismaMock.externalUsageEventDailyRollup.findMany.mockResolvedValue([]);
    prismaMock.externalUsageEventDailyRollup.findUnique.mockResolvedValue(null);
    prismaMock.externalUsageEventTombstone.deleteMany.mockResolvedValue({ count: 0 });

    const result = await runUsageRetention(new Date("2026-07-04T12:00:00.000Z"));

    expect(result.snapshotRetentionDays).toBe(45);
    expect(result.externalEventRetentionDays).toBe(90);
    expect(result.tombstoneRetentionDays).toBe(180);
    expect(result.usageSnapshots).toEqual({
      scanned: 2,
      pruned: 2,
      rollupsTouched: 1,
    });
    expect(result.externalUsageEvents).toEqual({
      scanned: 2,
      pruned: 2,
      rollupsTouched: 1,
      tombstonesWritten: 2,
    });
    expect(result.tombstonesPruned).toBe(0);
    expect(result.compacted).toBe(false);
    expect(result.compactionError).toBeUndefined();

    expect(prismaMock.usageSnapshot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          fetchedAt: { lt: new Date("2026-05-20T12:00:00.000Z") },
          id: { notIn: ["snap-latest"] },
        },
      })
    );
    expect(prismaMock.externalUsageEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { occurredAt: { lt: new Date("2026-04-05T12:00:00.000Z") } },
      })
    );
    expect(prismaMock.usageSnapshotDailyRollup.upsert).toHaveBeenCalledTimes(1);
    expect(prismaMock.externalUsageEventDailyRollup.upsert).toHaveBeenCalledTimes(1);
    expect(prismaMock.externalUsageEventDailyRollup.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          pricedEventCount: 2,
          unpricedEventCount: 0,
          unclassifiedCostEventCount: 0,
        }),
      })
    );
    expect(prismaMock.externalUsageEventTombstone.upsert).toHaveBeenCalledTimes(2);
    expect(prismaMock.externalUsageEventTombstone.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.usageSnapshot.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["snap-old-1", "snap-old-2"] } },
    });
    expect(prismaMock.externalUsageEvent.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["evt-1", "evt-2"] } },
    });
    expect(prismaMock.$executeRawUnsafe).not.toHaveBeenCalled();

    process.env.DATA_RETENTION_ENABLE_VACUUM = "true";
    const optedInResult = await runUsageRetention(
      new Date("2026-07-04T12:00:00.000Z")
    );

    expect(optedInResult.compacted).toBe(true);
    expect(prismaMock.$executeRawUnsafe).toHaveBeenNthCalledWith(
      1,
      "PRAGMA wal_checkpoint(TRUNCATE)"
    );
    expect(prismaMock.$executeRawUnsafe).toHaveBeenNthCalledWith(2, "VACUUM");
  });
});
