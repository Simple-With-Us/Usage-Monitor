import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { NextRequest } from "next/server";
import { setupPrismaSqliteTestDb } from "./setup-test-db";

let dbPath: string;
let prisma: typeof import("@/lib/prisma").prisma;
let runDataRetentionMaintenance: typeof import("../data-retention").runDataRetentionMaintenance;
let persistExternalUsageEvents: typeof import("../external-usage-events").persistExternalUsageEvents;
let computeBudgetStatus: typeof import("../budget-status").computeBudgetStatus;
let getSnapshots: typeof import("@/app/api/snapshots/route").GET;
let getUsageEvents: typeof import("@/app/api/usage-events/route").GET;

const NOW = new Date("2026-07-04T12:00:00.000Z");

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retention-integration-test-"));
  dbPath = path.join(dir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.USAGE_SNAPSHOT_RAW_RETENTION_DAYS = "7";
  process.env.EXTERNAL_USAGE_EVENT_RAW_RETENTION_DAYS = "7";
  process.env.EXTERNAL_USAGE_EVENT_TOMBSTONE_RETENTION_DAYS = "30";
  process.env.DATA_RETENTION_DISABLE_VACUUM = "1";

  setupPrismaSqliteTestDb(dbPath);

  ({ prisma } = await import("@/lib/prisma"));
  ({ runDataRetentionMaintenance } = await import("../data-retention"));
  ({ persistExternalUsageEvents } = await import("../external-usage-events"));
  ({ computeBudgetStatus } = await import("../budget-status"));
  ({ GET: getSnapshots } = await import("@/app/api/snapshots/route"));
  ({ GET: getUsageEvents } = await import("@/app/api/usage-events/route"));
}, 60_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (dbPath && fs.existsSync(dbPath)) {
    fs.rmSync(dbPath, { force: true });
  }
});

beforeEach(async () => {
  await prisma.providerAlertNotification.deleteMany();
  await prisma.externalUsageEventTombstone.deleteMany();
  await prisma.externalUsageEventDailyRollup.deleteMany();
  await prisma.externalUsageEvent.deleteMany();
  await prisma.usageSnapshotDailyRollup.deleteMany();
  await prisma.usageSnapshot.deleteMany();
  await prisma.providerPlan.deleteMany();
  await prisma.provider.deleteMany();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("retention integration", () => {
  it("summarizes every filtered raw event beyond the former 5,000-row cap", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const rows = Array.from({ length: 5_050 }, (_, index) => ({
      idempotencyKey: `summary-page-${index}`,
      sourceApp: "pagination-test",
      provider: "openai",
      billingMode: "actual",
      metricType: "cost",
      costUsd: 0.01,
      occurredAt: new Date("2026-07-03T12:00:00.000Z"),
    }));
    for (let offset = 0; offset < rows.length; offset += 400) {
      await prisma.externalUsageEvent.createMany({ data: rows.slice(offset, offset + 400) });
    }
    await prisma.externalUsageEvent.create({
      data: {
        idempotencyKey: "filtered-status-row",
        sourceApp: "pagination-test",
        provider: "openai",
        billingMode: "actual",
        metricType: "quota_sync",
        costUsd: 999,
        occurredAt: new Date("2026-07-03T12:00:00.000Z"),
      },
    });

    const response = await getUsageEvents(
      new NextRequest("https://usage.jays.services/api/usage-events?days=30")
    );
    const summary = await response.json();
    expect(summary.eventCount).toBe(5_050);
    expect(summary.totalCostUsd).toBeCloseTo(50.5);
  });

  it("returns only the newest requested raw snapshot points in chronological order", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const provider = await prisma.provider.create({
      data: {
        name: "bounded-snapshots",
        displayName: "Bounded snapshots",
        type: "custom",
        refreshIntervalMin: 60,
      },
    });
    await prisma.usageSnapshot.createMany({
      data: Array.from({ length: 8 }, (_, index) => ({
        providerId: provider.id,
        fetchedAt: new Date(`2026-07-03T${String(index).padStart(2, "0")}:00:00.000Z`),
        totalCost: index + 1,
      })),
    });

    const response = await getSnapshots(
      new NextRequest(
        `https://usage.jays.services/api/snapshots?providerId=${provider.id}&days=30&maxPoints=3`
      )
    );
    const snapshots = await response.json();

    expect(snapshots).toHaveLength(3);
    expect(snapshots.map((snapshot: { totalCost: number }) => snapshot.totalCost)).toEqual([
      6, 7, 8,
    ]);
  });

  it("keeps old rollup tombstones so late producer retries remain idempotent", async () => {
    await prisma.externalUsageEventTombstone.createMany({
      data: ["old-but-still-protected", "old-protected-two", "old-protected-three"].map(
        (idempotencyKey) => ({
          idempotencyKey,
          occurredAt: new Date("2025-01-01T00:00:00.000Z"),
          prunedAt: new Date("2025-01-02T00:00:00.000Z"),
        })
      ),
    });

    const result = await runDataRetentionMaintenance(NOW);

    expect(result.tombstonesPruned).toBe(0);
    expect(result.tombstoneCount).toBe(3);
    expect(
      await prisma.externalUsageEventTombstone.findUnique({
        where: { idempotencyKey: "old-but-still-protected" },
      })
    ).not.toBeNull();
  });

  it("rejects distinct events that collide on one fallback idempotency key", async () => {
    const base = {
      idempotencyKey: "mandated-five-field-collision",
      sourceApp: "socratic-trade",
      provider: "openai",
      billingMode: "actual",
      metricType: "cost",
      occurredAt: new Date("2026-07-03T12:00:00.000Z"),
    };
    await persistExternalUsageEvents([{ ...base, label: "lane-a", costUsd: 1 }]);
    await expect(
      persistExternalUsageEvents([{ ...base, label: "lane-b", costUsd: 2 }])
    ).rejects.toThrow(/Idempotency key collision/);
    expect(await prisma.externalUsageEvent.count()).toBe(1);
  });

  it("keeps receipt replay, collision, and tombstone behavior lossless", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "anthropic",
        displayName: "Anthropic",
        type: "push",
        refreshIntervalMin: 60,
      },
    });
    const digest = "c".repeat(64);
    const receipt = {
      idempotencyKey: `billing-receipt:v1:${digest}`,
      sourceApp: "billing-receipt-import",
      provider: "anthropic",
      service: "api-prepaid-funding",
      label: "receipt_cash_paid",
      keyRef: `provider:${provider.id}:billing-receipt:${digest}`,
      billingMode: "actual",
      metricType: "cost",
      unit: "usd",
      confidence: "actual",
      costUsd: 20,
      occurredAt: new Date("2026-06-20T12:00:00.000Z"),
    };

    expect(await persistExternalUsageEvents([receipt])).toMatchObject({ persisted: 1 });
    expect(await persistExternalUsageEvents([receipt])).toMatchObject({ persisted: 0 });
    await expect(
      persistExternalUsageEvents([{ ...receipt, costUsd: 25 }])
    ).rejects.toThrow(/Idempotency key collision/);

    await runDataRetentionMaintenance(NOW);
    const replay = await persistExternalUsageEvents([receipt]);
    expect(replay).toMatchObject({ persisted: 0, skippedPrunedDuplicates: 1 });
    expect(await prisma.externalUsageEvent.count()).toBe(0);
    expect(
      await prisma.externalUsageEventTombstone.findUnique({
        where: { idempotencyKey: receipt.idempotencyKey },
      })
    ).not.toBeNull();
  });

  it("reports only newly inserted rows as persisted across idempotent replays", async () => {
    const existing = {
      idempotencyKey: "accepted-count-existing",
      sourceApp: "socratic-trade",
      provider: "openai",
      billingMode: "actual",
      metricType: "cost",
      costUsd: 0,
      occurredAt: new Date("2026-07-03T12:00:00.000Z"),
    };
    const first = await persistExternalUsageEvents([existing]);
    const replay = await persistExternalUsageEvents([existing]);
    const mixed = await persistExternalUsageEvents([
      existing,
      { ...existing, idempotencyKey: "accepted-count-new" },
    ]);

    expect(first).toMatchObject({ attempted: 1, persisted: 1, skippedPrunedDuplicates: 0 });
    expect(replay).toMatchObject({ attempted: 1, persisted: 0, skippedPrunedDuplicates: 0 });
    expect(replay.newEvents).toEqual([]);
    expect(mixed).toMatchObject({ attempted: 2, persisted: 1, skippedPrunedDuplicates: 0 });
    expect(mixed.newEvents.map((event) => event.idempotencyKey)).toEqual(["accepted-count-new"]);
    expect(await prisma.externalUsageEvent.count()).toBe(2);
  });

  it("serves rolled-up historical data without double counting recent raw rows", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    const provider = await prisma.provider.create({
      data: {
        name: "openai",
        displayName: "OpenAI",
        type: "builtin",
        refreshIntervalMin: 60,
        plan: {
          create: {
            billingMode: "actual",
            monthlyBudgetUsd: 20,
          },
        },
      },
    });

    await prisma.usageSnapshot.createMany({
      data: [
        {
          providerId: provider.id,
          fetchedAt: new Date("2026-06-20T08:00:00.000Z"),
          balance: 55,
          totalCost: 7,
          totalRequests: 70,
          credits: 12,
        },
        {
          providerId: provider.id,
          fetchedAt: new Date("2026-07-02T08:00:00.000Z"),
          balance: 30,
          totalCost: 11,
          totalRequests: 110,
          credits: 6,
        },
      ],
    });

    await prisma.externalUsageEvent.createMany({
      data: [
        {
          idempotencyKey: "older-event",
          sourceApp: "codex-smoke",
          provider: "openai",
          service: "responses",
          billingMode: "actual",
          metricType: "cost",
          costUsd: 12,
          requests: 34,
          occurredAt: new Date("2026-06-25T12:00:00.000Z"),
        },
        {
          idempotencyKey: "recent-event",
          sourceApp: "codex-smoke",
          provider: "openai",
          service: "responses",
          billingMode: "actual",
          metricType: "cost",
          costUsd: 3,
          requests: 4,
          occurredAt: new Date("2026-07-02T12:00:00.000Z"),
        },
      ],
    });

    const retention = await runDataRetentionMaintenance(NOW);
    expect(retention.usageSnapshots.pruned).toBe(1);
    expect(retention.externalUsageEvents.pruned).toBe(1);
    expect(retention.externalUsageEvents.tombstonesWritten).toBe(1);

    const budget = await computeBudgetStatus(NOW);
    expect(budget.providers[0].pushedMonthToDateUsd).toBe(3);
    expect(budget.providers[0].spentUsd).toBe(11);

    const snapshotsResponse = await getSnapshots(
      new NextRequest(
        `https://usage.jays.services/api/snapshots?providerId=${provider.id}&days=30`
      )
    );
    const snapshots = await snapshotsResponse.json();
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0].id).toMatch(/^rollup:/);
    expect(snapshots[1].totalCost).toBe(11);

    const usageEventsResponse = await getUsageEvents(
      new NextRequest("https://usage.jays.services/api/usage-events?days=30")
    );
    const usageEvents = await usageEventsResponse.json();
    expect(usageEvents.eventCount).toBe(2);
    expect(usageEvents.totalCostUsd).toBe(15);
    expect(usageEvents.totalRequests).toBe(38);

    const replay = await persistExternalUsageEvents([
      {
        idempotencyKey: "older-event",
        sourceApp: "codex-smoke",
        provider: "openai",
        service: "responses",
        billingMode: "actual",
        metricType: "cost",
        costUsd: 12,
        requests: 34,
        occurredAt: new Date("2026-06-25T12:00:00.000Z"),
      },
    ]);
    expect(replay.persisted).toBe(0);
    expect(replay.skippedPrunedDuplicates).toBe(1);
    expect(await prisma.externalUsageEvent.findMany()).toHaveLength(1);
  });
});
