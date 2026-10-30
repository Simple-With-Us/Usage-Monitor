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
    externalUsageEventTombstone: {
      findMany: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn(),
    },
    agentTurn: { updateMany: vi.fn(), deleteMany: vi.fn() },
    aiRequest: { deleteMany: vi.fn() },
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

const tombstoneCountMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/lib/sqlite-tombstone-count", () => ({
  countExternalUsageEventTombstones: tombstoneCountMock,
}));

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
  delete process.env.DATA_RETENTION_DISABLE_ANALYZE;
  delete process.env.DATA_RETENTION_DISABLE_VACUUM;
}

describe("usage-retention wrapper", () => {
  beforeEach(() => {
    resetEnv();
    vi.clearAllMocks();
    prismaMock.__transactionDepth = 0;
    // Wave I / E6 rehash runs first in retention; empty by default.
    prismaMock.externalUsageEventDailyRollup.findMany.mockResolvedValue([]);
    tombstoneCountMock.mockResolvedValue(0);
    prismaMock.agentTurn.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.agentTurn.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.aiRequest.deleteMany.mockResolvedValue({ count: 0 });
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
      isAutomaticVacuumEnabled({ DATA_RETENTION_ENABLE_VACUUM: "true", LITESTREAM_ACTIVE: "true" })
    ).toBe(false);
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
    expect(result.tombstoneCount).toBe(0);
    expect(result.compacted).toBe(false);
    expect(result.compactionError).toBeUndefined();
    // Wave K / E14: ANALYZE runs after prune by default (no exclusive VACUUM).
    expect(result.analyzed).toBe(true);
    expect(prismaMock.$executeRawUnsafe).toHaveBeenCalledWith("ANALYZE");

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

    process.env.DATA_RETENTION_ENABLE_VACUUM = "true";
    prismaMock.$executeRawUnsafe.mockClear();
    const optedInResult = await runUsageRetention(
      new Date("2026-07-04T12:00:00.000Z")
    );

    expect(optedInResult.compacted).toBe(true);
    expect(optedInResult.analyzed).toBe(true);
    expect(prismaMock.$executeRawUnsafe).toHaveBeenNthCalledWith(1, "ANALYZE");
    expect(prismaMock.$executeRawUnsafe).toHaveBeenNthCalledWith(
      2,
      "PRAGMA wal_checkpoint(TRUNCATE)"
    );
    expect(prismaMock.$executeRawUnsafe).toHaveBeenNthCalledWith(3, "VACUUM");
  });

  it("retries a transient P1008 on the external-event rollup upsert instead of failing the batch", async () => {
    prismaMock.provider.findMany.mockResolvedValue([]);
    prismaMock.usageSnapshot.findMany.mockResolvedValue([]);
    prismaMock.externalUsageEvent.findMany.mockResolvedValue([
      {
        id: "evt-timeout-1",
        idempotencyKey: "evt-timeout-1",
        sourceApp: "socratic-trade",
        environment: "prod",
        provider: "anthropic",
        service: "claude-code",
        label: "model",
        keyRef: "gpt-5.5",
        billingMode: "estimated",
        metricType: "usage",
        quantity: 10,
        unit: "token",
        costUsd: 1,
        requests: 1,
        credits: 0,
        limit: 1000,
        limitWindow: "month",
        tier: "pro",
        confidence: "estimated",
        projectId: null,
        occurredAt: new Date("2026-04-01T03:00:00.000Z"),
      },
    ]);
    prismaMock.externalUsageEventDailyRollup.findUnique.mockResolvedValue(null);
    prismaMock.externalUsageEventDailyRollup.upsert
      .mockRejectedValueOnce(
        Object.assign(new Error("Operation has timed out"), {
          code: "P1008",
          meta: { modelName: "ExternalUsageEventDailyRollup" },
        })
      )
      .mockResolvedValue({});
    prismaMock.externalUsageEventTombstone.upsert.mockResolvedValue({});
    prismaMock.externalUsageEvent.deleteMany.mockResolvedValue({ count: 1 });

    const result = await runUsageRetention(new Date("2026-07-04T12:00:00.000Z"));

    expect(result.externalUsageEvents).toEqual({
      scanned: 1,
      pruned: 1,
      rollupsTouched: 1,
      tombstonesWritten: 1,
    });
    expect(prismaMock.externalUsageEventDailyRollup.upsert).toHaveBeenCalledTimes(2);
  });

  it("keeps a persistent P1008 fatal after bounded retries", async () => {
    prismaMock.provider.findMany.mockResolvedValue([]);
    prismaMock.usageSnapshot.findMany.mockResolvedValue([]);
    prismaMock.externalUsageEvent.findMany.mockResolvedValue([
      {
        id: "evt-timeout-2",
        idempotencyKey: "evt-timeout-2",
        sourceApp: "socratic-trade",
        environment: "prod",
        provider: "anthropic",
        service: "claude-code",
        label: "model",
        keyRef: "gpt-5.5",
        billingMode: "estimated",
        metricType: "usage",
        quantity: 10,
        unit: "token",
        costUsd: 1,
        requests: 1,
        credits: 0,
        limit: 1000,
        limitWindow: "month",
        tier: "pro",
        confidence: "estimated",
        projectId: null,
        occurredAt: new Date("2026-04-01T03:00:00.000Z"),
      },
    ]);
    prismaMock.externalUsageEventDailyRollup.findUnique.mockResolvedValue(null);
    prismaMock.externalUsageEventDailyRollup.upsert.mockRejectedValue(
      Object.assign(new Error("Operation has timed out"), {
        code: "P1008",
        meta: { modelName: "ExternalUsageEventDailyRollup" },
      })
    );

    await expect(
      runUsageRetention(new Date("2026-07-04T12:00:00.000Z"))
    ).rejects.toMatchObject({ code: "P1008" });
    expect(prismaMock.externalUsageEventDailyRollup.upsert).toHaveBeenCalledTimes(3);
  });

  it("does not consume the scheduled retention interval when a run throws a transient write error", async () => {
    vi.resetModules();
    const fresh = await import("../usage-retention");
    prismaMock.provider.findMany.mockResolvedValue([]);
    prismaMock.usageSnapshot.findMany.mockResolvedValue([]);
    prismaMock.externalUsageEvent.findMany.mockResolvedValue([]);
    prismaMock.externalUsageEventDailyRollup.findMany.mockRejectedValueOnce(
      Object.assign(new Error("Operation has timed out"), { code: "P1008" })
    );

    await expect(
      fresh.runScheduledDataRetentionMaintenance(new Date("2026-07-04T12:00:00.000Z"))
    ).rejects.toMatchObject({ code: "P1008" });

    prismaMock.externalUsageEventDailyRollup.findMany.mockResolvedValue([]);
    const retried = await fresh.runScheduledDataRetentionMaintenance(
      new Date("2026-07-04T12:15:00.000Z")
    );
    expect(retried).toMatchObject({
      externalUsageEvents: { scanned: 0, pruned: 0 },
    });

    const skipped = await fresh.runScheduledDataRetentionMaintenance(
      new Date("2026-07-04T12:30:00.000Z")
    );
    expect(skipped).toEqual({ skipped: true, reason: "interval" });
  });

  it("keeps the scheduled retention interval when a run throws a non-transient error", async () => {
    vi.resetModules();
    const fresh = await import("../usage-retention");
    prismaMock.provider.findMany.mockResolvedValue([]);
    prismaMock.usageSnapshot.findMany.mockResolvedValue([]);
    prismaMock.externalUsageEvent.findMany.mockResolvedValue([]);
    prismaMock.externalUsageEventDailyRollup.findMany.mockRejectedValueOnce(
      new Error("rehash failed")
    );

    await expect(
      fresh.runScheduledDataRetentionMaintenance(new Date("2026-07-04T12:00:00.000Z"))
    ).rejects.toThrow("rehash failed");

    // A persistent breakage stays throttled to the retention interval
    // instead of re-running -- and aborting the rest of the maintenance
    // tick -- every 15 minutes.
    const throttled = await fresh.runScheduledDataRetentionMaintenance(
      new Date("2026-07-04T12:15:00.000Z")
    );
    expect(throttled).toEqual({ skipped: true, reason: "interval" });
  });
});
