import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { setupPrismaSqliteTestDb } from "./setup-test-db";
import { DEFAULT_ANOMALY_CONFIG, type AnomalyConfig } from "../anomaly-detection";

let dbPath: string;
let prisma: typeof import("@/lib/prisma").prisma;
let loadSpendAnomaliesByProviderId: typeof import("../anomaly-loader").loadSpendAnomaliesByProviderId;
let loadSpendAnomaliesByProjectId: typeof import("../anomaly-loader").loadSpendAnomaliesByProjectId;

const CONFIG: AnomalyConfig = { ...DEFAULT_ANOMALY_CONFIG };

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anomaly-loader-test-"));
  dbPath = path.join(dir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.ENCRYPTION_KEY = "44".repeat(32);

  setupPrismaSqliteTestDb(dbPath);

  ({ prisma } = await import("@/lib/prisma"));
  ({ loadSpendAnomaliesByProviderId, loadSpendAnomaliesByProjectId } = await import(
    "../anomaly-loader"
  ));
}, 60_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (dbPath && fs.existsSync(dbPath)) {
    fs.rmSync(dbPath, { force: true });
  }
  delete process.env.ENCRYPTION_KEY;
}, 30_000);

beforeEach(async () => {
  vi.restoreAllMocks();
  await prisma.providerAlertChannelDelivery.deleteMany();
  await prisma.providerAlertNotification.deleteMany();
  await prisma.externalUsageEventTombstone.deleteMany();
  await prisma.externalUsageEventDailyRollup.deleteMany();
  await prisma.externalUsageEvent.deleteMany();
  await prisma.usageSnapshotDailyRollup.deleteMany();
  await prisma.usageSnapshot.deleteMany();
  await prisma.providerPlan.deleteMany();
  await prisma.subscription.deleteMany();
  await prisma.project.deleteMany();
  await prisma.provider.deleteMany();
});

async function createProvider(name: string) {
  return prisma.provider.create({
    data: { name, displayName: name, type: "builtin", refreshIntervalMin: 60 },
  });
}

async function addSnapshot(
  providerId: string,
  fetchedAt: string,
  totalCost: number,
  totalRequests?: number
) {
  await prisma.usageSnapshot.create({
    data: {
      providerId,
      fetchedAt: new Date(fetchedAt),
      totalCost,
      ...(totalRequests != null ? { totalRequests } : {}),
    },
  });
}

let eventSeq = 0;
async function addExternalEvent(input: {
  provider: string;
  projectId?: string | null;
  costUsd: number;
  occurredAt: string;
  metricType?: string;
  sourceApp?: string;
  service?: string | null;
  label?: string | null;
}) {
  eventSeq += 1;
  await prisma.externalUsageEvent.create({
    data: {
      idempotencyKey: `test-event-${eventSeq}`,
      sourceApp: input.sourceApp ?? "test-producer",
      provider: input.provider,
      service: input.service ?? null,
      label: input.label ?? null,
      billingMode: "actual",
      metricType: input.metricType ?? "usage",
      confidence: "exact",
      costUsd: input.costUsd,
      occurredAt: new Date(input.occurredAt),
      projectId: input.projectId ?? null,
    },
  });
}

async function addRollup(input: {
  day: string;
  provider: string;
  projectId?: string | null;
  totalCostUsd: number;
  groupKey?: string;
  metricType?: string;
}) {
  await prisma.externalUsageEventDailyRollup.create({
    data: {
      day: new Date(`${input.day}T00:00:00.000Z`),
      groupKey: input.groupKey ?? `test-rollup-${input.day}-${input.provider}-${input.projectId ?? "none"}`,
      sourceApp: "test-producer",
      provider: input.provider,
      billingMode: "actual",
      metricType: input.metricType ?? "usage",
      confidence: "exact",
      totalCostUsd: input.totalCostUsd,
      latestOccurredAt: new Date(`${input.day}T12:00:00.000Z`),
      projectId: input.projectId ?? null,
    },
  });
}

describe("S3: per-provider snapshot baseline caps", () => {
  it("a flooding provider truncates only itself (loudly) and never starves the fleet", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const flood = await createProvider("flood-provider");
    const calm = await createProvider("calm-provider");

    // 25 in-window snapshots for flood; cap is 20 per provider in this test.
    for (let i = 0; i < 25; i += 1) {
      await addSnapshot(flood.id, `2026-07-19T${String(i % 24).padStart(2, "0")}:00:00.000Z`, 100 + i);
    }
    // Calm provider (15 rows, under the cap): ~$10/day for two weeks, then a
    // $200 spike yesterday.
    let cumulative = 40;
    for (let day = 5; day <= 18; day += 1) {
      await addSnapshot(calm.id, `2026-07-${String(day).padStart(2, "0")}T23:00:00.000Z`, cumulative);
      cumulative += 10;
    }
    await addSnapshot(calm.id, "2026-07-19T23:00:00.000Z", cumulative - 10 + 200);

    const results = await loadSpendAnomaliesByProviderId(
      new Date("2026-07-20T12:00:00.000Z"),
      CONFIG,
      [
        { id: flood.id, name: flood.name },
        { id: calm.id, name: calm.name },
      ],
      { maxSnapshotRowsPerProvider: 20 }
    );

    // Truncation is loud and names the provider.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('snapshot baseline truncated for provider "flood-provider"')
    );
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining('snapshot baseline truncated for provider "calm-provider"')
    );
    // The calm provider's baseline was NOT eaten by the flood provider's rows:
    // its spike is still detected (previously one global 20k cap let a single
    // high-frequency poller silently starve every other provider).
    const calmAnomalies = results.get(calm.id) ?? [];
    expect(calmAnomalies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ metric: "cost", providerId: calm.id, day: "2026-07-19" }),
      ])
    );
  });
});

describe("S7: observed point is the latest COMPLETE day, not today's partial day", () => {
  async function seedCalmBaseline(providerId: string) {
    let cumulative = 40;
    for (let day = 5; day <= 18; day += 1) {
      await addSnapshot(providerId, `2026-07-${String(day).padStart(2, "0")}T23:00:00.000Z`, cumulative);
      cumulative += 10;
    }
    return cumulative - 10; // cumulative value written for July 18
  }

  it("fixes the early-morning false negative: yesterday's complete spike is evaluated at 00:30 UTC", async () => {
    const provider = await createProvider("early-morning");
    const base = await seedCalmBaseline(provider.id);
    // July 19 (complete): +150 spike. July 20 00:15 (today, partial): +5 so far.
    await addSnapshot(provider.id, "2026-07-19T23:00:00.000Z", base + 150);
    await addSnapshot(provider.id, "2026-07-20T00:15:00.000Z", base + 155);

    const results = await loadSpendAnomaliesByProviderId(
      new Date("2026-07-20T00:30:00.000Z"),
      CONFIG,
      [{ id: provider.id, name: provider.name }]
    );

    // The old behavior compared today's $5 partial day against full-day
    // baselines and missed the spike entirely. The alert now names the
    // complete day it evaluated, matching the "on {day}" alert text.
    const anomalies = results.get(provider.id) ?? [];
    expect(anomalies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ metric: "cost", day: "2026-07-19", observed: 150 }),
      ])
    );
  });

  it("fixes the morning-heavy false positive: today's partial spike is not evaluated until complete", async () => {
    const provider = await createProvider("morning-heavy");
    const base = await seedCalmBaseline(provider.id);
    await addSnapshot(provider.id, "2026-07-19T23:00:00.000Z", base + 10);
    // Morning-heavy: by 09:00 today the provider already spent $95.
    await addSnapshot(provider.id, "2026-07-20T09:00:00.000Z", base + 105);

    const midday = await loadSpendAnomaliesByProviderId(
      new Date("2026-07-20T12:00:00.000Z"),
      CONFIG,
      [{ id: provider.id, name: provider.name }]
    );
    // Yesterday was a normal $10 day: no anomaly mid-day, no matter how large
    // today's partial is.
    expect(midday.get(provider.id) ?? []).toHaveLength(0);

    // Tomorrow, today's data is a complete day and becomes the observed point.
    await addSnapshot(provider.id, "2026-07-20T23:00:00.000Z", base + 105);
    const nextDay = await loadSpendAnomaliesByProviderId(
      new Date("2026-07-21T12:00:00.000Z"),
      CONFIG,
      [{ id: provider.id, name: provider.name }]
    );
    expect(nextDay.get(provider.id) ?? []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ metric: "cost", day: "2026-07-20", observed: 95 }),
      ])
    );
  });
});

describe("S5: push-channel baseline crosses the month boundary via daily rollups", () => {
  it("detects a day-2-of-month spike for a push-only provider using prior-month rollups", async () => {
    const provider = await createProvider("Anthropic");
    // Prior month: steady ~$10/day (inside the trailing windowDays window).
    for (let day = 20; day <= 31; day += 1) {
      await addRollup({
        day: `2026-07-${String(day).padStart(2, "0")}`,
        provider: "Anthropic",
        totalCostUsd: 10,
      });
    }
    // This month (raw events): Aug 1 normal $10, Aug 2 spike $160, plus a
    // today (Aug 3) partial that must not be evaluated (S7).
    await addExternalEvent({ provider: "Anthropic", costUsd: 10, occurredAt: "2026-08-01T10:00:00.000Z" });
    await addExternalEvent({ provider: "Anthropic", costUsd: 160, occurredAt: "2026-08-02T10:00:00.000Z" });
    await addExternalEvent({ provider: "Anthropic", costUsd: 3, occurredAt: "2026-08-03T06:00:00.000Z" });

    const results = await loadSpendAnomaliesByProviderId(
      new Date("2026-08-03T12:00:00.000Z"),
      CONFIG,
      [{ id: provider.id, name: provider.name }]
    );

    // Without the prior-month rollup window the baseline would be a single
    // $10 day (minHistoryPoints=7 unreachable on Aug 3) and the spike would
    // be invisible until ~day 9 of the month.
    expect(results.get(provider.id) ?? []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ metric: "cost", day: "2026-08-02", observed: 160 }),
      ])
    );
  });

  it("does not page on push-channel day-one spend with a zero prior-month baseline", async () => {
    const provider = await createProvider("backblaze");
    for (let day = 20; day <= 31; day += 1) {
      await addRollup({
        day: `2026-07-${String(day).padStart(2, "0")}`,
        provider: "backblaze",
        totalCostUsd: 0.01,
      });
    }
    await addExternalEvent({ provider: "backblaze", costUsd: 2, occurredAt: "2026-08-01T10:00:00.000Z" });
    await addExternalEvent({ provider: "backblaze", costUsd: 95, occurredAt: "2026-08-02T10:00:00.000Z" });

    const results = await loadSpendAnomaliesByProviderId(
      new Date("2026-08-03T12:00:00.000Z"),
      CONFIG,
      [{ id: provider.id, name: provider.name }]
    );
    expect(results.get(provider.id) ?? []).toHaveLength(0);
  });

  it("still cannot alert early in the month without prior-month rollup history", async () => {
    const provider = await createProvider("Anthropic");
    await addExternalEvent({ provider: "Anthropic", costUsd: 10, occurredAt: "2026-08-01T10:00:00.000Z" });
    await addExternalEvent({ provider: "Anthropic", costUsd: 160, occurredAt: "2026-08-02T10:00:00.000Z" });

    const results = await loadSpendAnomaliesByProviderId(
      new Date("2026-08-03T12:00:00.000Z"),
      CONFIG,
      [{ id: provider.id, name: provider.name }]
    );
    // Control: proves the spike above is detected BECAUSE of the rollup
    // baseline, not despite a short one.
    expect(results.get(provider.id) ?? []).toHaveLength(0);
  });

  it("excludes subscription charges, receipt cash, and status metrics from the rollup baseline", async () => {
    const provider = await createProvider("Anthropic");
    for (let day = 20; day <= 31; day += 1) {
      await addRollup({
        day: `2026-07-${String(day).padStart(2, "0")}`,
        provider: "Anthropic",
        totalCostUsd: 10,
      });
    }
    // A subscription charge rollup row with a huge cost must not poison the
    // variable-spend baseline.
    await addRollup({
      day: "2026-07-25",
      provider: "Anthropic",
      totalCostUsd: 5000,
      metricType: "subscription",
      groupKey: "test-rollup-2026-07-25-subscription",
    });
    await addExternalEvent({ provider: "Anthropic", costUsd: 10, occurredAt: "2026-08-01T10:00:00.000Z" });
    await addExternalEvent({ provider: "Anthropic", costUsd: 160, occurredAt: "2026-08-02T10:00:00.000Z" });

    const results = await loadSpendAnomaliesByProviderId(
      new Date("2026-08-03T12:00:00.000Z"),
      CONFIG,
      [{ id: provider.id, name: provider.name }]
    );
    const anomalies = results.get(provider.id) ?? [];
    expect(anomalies).toHaveLength(1);
    // Baseline center stays ~10 — the $5000 subscription row was excluded.
    expect(anomalies[0]).toMatchObject({ baselineCenter: 10, observed: 160 });
  });
});

describe("S1a: per-project spend anomaly detection", () => {
  it("groups daily cost by projectId and runs the MAD detector per project", async () => {
    const provider = await createProvider("Anthropic");
    const spiking = await prisma.project.create({
      data: { name: "Spiking App", monthlyBudgetUsd: 100 },
    });
    const calm = await prisma.project.create({
      data: { name: "Calm App", monthlyBudgetUsd: 100 },
    });

    for (let day = 10; day <= 18; day += 1) {
      const date = `2026-07-${String(day).padStart(2, "0")}T10:00:00.000Z`;
      await addExternalEvent({ provider: "Anthropic", projectId: spiking.id, costUsd: 10, occurredAt: date });
      await addExternalEvent({ provider: "Anthropic", projectId: calm.id, costUsd: 10, occurredAt: date });
    }
    // Spiking project: +150 spike yesterday (complete day) + a small partial today.
    await addExternalEvent({ provider: "Anthropic", projectId: spiking.id, costUsd: 160, occurredAt: "2026-07-19T10:00:00.000Z" });
    await addExternalEvent({ provider: "Anthropic", projectId: spiking.id, costUsd: 4, occurredAt: "2026-07-20T06:00:00.000Z" });
    await addExternalEvent({ provider: "Anthropic", projectId: calm.id, costUsd: 10, occurredAt: "2026-07-19T10:00:00.000Z" });
    // Noise that must NOT affect project detection: an untagged mega-spend
    // event and a subscription charge tagged to the calm project.
    await addExternalEvent({ provider: "Anthropic", costUsd: 9999, occurredAt: "2026-07-19T10:00:00.000Z" });
    await addExternalEvent({ provider: "Anthropic", projectId: calm.id, costUsd: 500, metricType: "subscription", occurredAt: "2026-07-19T10:00:00.000Z" });

    const results = await loadSpendAnomaliesByProjectId(
      new Date("2026-07-20T12:00:00.000Z"),
      CONFIG,
      [
        { id: spiking.id, name: spiking.name },
        { id: calm.id, name: calm.name },
      ]
    );

    expect(results.get(spiking.id) ?? []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metric: "cost",
          projectId: spiking.id,
          day: "2026-07-19",
          observed: 160,
        }),
      ])
    );
    // Calm project: untagged events and subscription charges never leak in.
    expect(results.get(calm.id) ?? []).toHaveLength(0);
    expect(results.has(provider.id)).toBe(false);
  });

  it("uses prior-month rollups for the project baseline across the month boundary", async () => {
    await createProvider("Anthropic");
    const project = await prisma.project.create({
      data: { name: "Boundary App", monthlyBudgetUsd: 100 },
    });
    for (let day = 20; day <= 31; day += 1) {
      await addRollup({
        day: `2026-07-${String(day).padStart(2, "0")}`,
        provider: "Anthropic",
        projectId: project.id,
        totalCostUsd: 10,
      });
    }
    await addExternalEvent({ provider: "Anthropic", projectId: project.id, costUsd: 10, occurredAt: "2026-08-01T10:00:00.000Z" });
    await addExternalEvent({ provider: "Anthropic", projectId: project.id, costUsd: 160, occurredAt: "2026-08-02T10:00:00.000Z" });

    const results = await loadSpendAnomaliesByProjectId(
      new Date("2026-08-03T12:00:00.000Z"),
      CONFIG,
      [{ id: project.id, name: project.name }]
    );
    expect(results.get(project.id) ?? []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ projectId: project.id, day: "2026-08-02", observed: 160 }),
      ])
    );
  });

  it("returns an empty map without touching the DB when no projects exist", async () => {
    const results = await loadSpendAnomaliesByProjectId(
      new Date("2026-07-20T12:00:00.000Z"),
      CONFIG,
      []
    );
    expect(results.size).toBe(0);
  });
});
