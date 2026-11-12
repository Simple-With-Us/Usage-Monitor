import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setupPrismaSqliteTestDb } from "./setup-test-db";

// Behavioral coverage for the chunked MTD raw scan (see
// RAW_EVENT_SCAN_CHUNK_ROWS in ../external-usage-events): the scan must
// return exactly what the old single groupBy returned — rollups folded,
// status metrics excluded, valid receipt-cash excluded, invalid receipt
// candidates folded back as ordinary cost — while walking the window in
// bounded (occurredAt, id) cursor chunks with real event-loop turns in
// between, so /api/health stays answerable mid-scan.

let dbPath: string;
let prisma: typeof import("@/lib/prisma").prisma;

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mtd-scan-chunked-"));
  dbPath = path.join(dir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.ENCRYPTION_KEY = "44".repeat(32);
  setupPrismaSqliteTestDb(dbPath);
  ({ prisma } = await import("@/lib/prisma"));
}, 60_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (dbPath && fs.existsSync(dbPath)) {
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

beforeEach(async () => {
  vi.restoreAllMocks();
  await prisma.externalUsageEventDailyRollup.deleteMany();
  await prisma.externalUsageEvent.deleteMany();
  await prisma.project.deleteMany();
});

const MONTH_START = new Date("2026-10-01T00:00:00.000Z");
const RAW_CUTOFF = new Date("2026-10-03T00:00:00.000Z");
const NOW = new Date("2026-10-05T00:00:00.000Z");

let seq = 0;
function ev(overrides: Record<string, unknown>) {
  seq += 1;
  return {
    idempotencyKey: `mtd-chunked-${seq}`,
    sourceApp: "claude-code",
    provider: "anthropic",
    metricType: "cost",
    billingMode: "estimated",
    confidence: "estimated",
    occurredAt: new Date("2026-10-03T10:00:00.000Z"),
    ...overrides,
  };
}

describe("chunked month-to-date external-cost scan", () => {
  it("matches single-shot aggregate semantics across raw rows, rollups, and receipt candidates", async () => {
    await prisma.project.create({ data: { id: "proj-x", name: "Proj X" } });
    await prisma.externalUsageEventDailyRollup.createMany({
      data: [
        {
          day: new Date("2026-10-01T00:00:00.000Z"),
          groupKey: "rollup-1",
          sourceApp: "claude-code",
          provider: "anthropic",
          service: "api",
          billingMode: "estimated",
          metricType: "cost",
          confidence: "estimated",
          projectId: null,
          eventCount: 4,
          pricedEventCount: 3,
          unpricedEventCount: 1,
          unclassifiedCostEventCount: 0,
          totalCostUsd: 10,
          latestOccurredAt: new Date("2026-10-01T12:00:00.000Z"),
        },
        {
          day: new Date("2026-10-02T00:00:00.000Z"),
          groupKey: "rollup-2",
          sourceApp: "claude-code",
          provider: "anthropic",
          service: "api",
          billingMode: "estimated",
          metricType: "cost",
          confidence: "estimated",
          projectId: "proj-x",
          eventCount: 2,
          pricedEventCount: 2,
          unpricedEventCount: 0,
          unclassifiedCostEventCount: 0,
          totalCostUsd: 5,
          latestOccurredAt: new Date("2026-10-02T12:00:00.000Z"),
        },
      ],
    });

    const digest = "ab".repeat(32);
    const providerUuid = "123e4567-e89b-42d3-a456-426614174000";
    await prisma.externalUsageEvent.createMany({
      data: [
        ev({ costUsd: 2.5, service: "api" }),
        ev({
          costUsd: null,
          service: "api",
          occurredAt: new Date("2026-10-03T11:00:00.000Z"),
        }),
        ev({
          metricType: "usage",
          costUsd: 1.25,
          service: "api",
          occurredAt: new Date("2026-10-04T09:00:00.000Z"),
        }),
        ev({
          sourceApp: "codex",
          provider: "openai",
          costUsd: 3,
          occurredAt: new Date("2026-10-04T10:00:00.000Z"),
        }),
        // Subscription-analytics shape (sourceApp AND service claude-code):
        // an API-equivalent estimate, never cash, never attribution.
        ev({
          service: "claude-code",
          costUsd: 100,
          occurredAt: new Date("2026-10-04T13:00:00.000Z"),
        }),
        // Status metrics are excluded from the cost aggregate entirely.
        ev({
          metricType: "quota_sync",
          costUsd: 99,
          occurredAt: new Date("2026-10-04T10:30:00.000Z"),
        }),
        // Receipt-shaped but with a malformed keyRef: not valid receipt
        // cash, so it folds back in as ordinary cost via the candidate path.
        ev({
          sourceApp: "billing-receipt-import",
          service: "api-prepaid-funding",
          label: "receipt_cash_paid",
          billingMode: "actual",
          confidence: "actual",
          unit: "usd",
          keyRef: "garbage",
          costUsd: 7,
          occurredAt: new Date("2026-10-04T11:00:00.000Z"),
        }),
        // A valid receipt-cash event: excluded from this aggregate (its
        // cash is counted by the receipt-cash path, not as pushed cost).
        ev({
          sourceApp: "billing-receipt-import",
          service: "api-prepaid-funding",
          label: "receipt_cash_paid",
          billingMode: "actual",
          confidence: "actual",
          unit: "usd",
          keyRef: `provider:${providerUuid}:billing-receipt:${digest}`,
          idempotencyKey: `billing-receipt:v1:${digest}`,
          costUsd: 40,
          occurredAt: new Date("2026-10-04T12:00:00.000Z"),
        }),
      ],
    });

    const { sumMonthToDateExternalCostByProvider, sumMonthToDateExternalCostAttribution } =
      await import("../external-usage-events");

    const byProvider = await sumMonthToDateExternalCostByProvider(MONTH_START, RAW_CUTOFF, NOW);
    expect(byProvider.size).toBe(2);
    const anthropic = byProvider.get("anthropic");
    // Rollups 10 + 5, raw priced 2.5 + 1.25, invalid candidate 7. The
    // quota_sync row and the valid receipt contribute nothing.
    expect(anthropic?.usagePushed).toBeCloseTo(25.75, 10);
    expect(anthropic?.estimatedApiEquivalentUsd).toBeCloseTo(100, 10);
    expect(anthropic?.pricedEventCount).toBe(8);
    expect(anthropic?.unpricedEventCount).toBe(2);
    const openai = byProvider.get("openai");
    expect(openai?.usagePushed).toBeCloseTo(3, 10);
    expect(openai?.pricedEventCount).toBe(1);

    const attribution = await sumMonthToDateExternalCostAttribution(MONTH_START, RAW_CUTOFF, NOW);
    const byKey = new Map(
      attribution.map((row) => [
        `${row.provider}|${row.sourceApp}|${row.projectId ?? ""}|${row.metricType}`,
        row,
      ])
    );
    expect(byKey.size).toBe(5);
    expect(byKey.get("anthropic|claude-code||cost")?.costUsd).toBeCloseTo(12.5, 10);
    expect(byKey.get("anthropic|claude-code||cost")?.pricedEventCount).toBe(4);
    expect(byKey.get("anthropic|claude-code||cost")?.unpricedEventCount).toBe(2);
    expect(byKey.get("anthropic|claude-code|proj-x|cost")?.costUsd).toBeCloseTo(5, 10);
    expect(byKey.get("anthropic|claude-code||usage")?.costUsd).toBeCloseTo(1.25, 10);
    expect(byKey.get("anthropic|billing-receipt-import||cost")?.costUsd).toBeCloseTo(7, 10);
    expect(byKey.get("openai|codex||cost")?.costUsd).toBeCloseTo(3, 10);
  });

  it("matches old SQLite aggregates while yielding between dashboard pages", async () => {
    await prisma.$executeRawUnsafe(`
      INSERT INTO "ExternalUsageEvent"
        ("id", "idempotencyKey", "sourceApp", "provider", "metricType", "costUsd", "requests", "quantity", "limit", "limitWindow", "occurredAt", "metadata", "billingMode", "confidence", "createdAt")
      WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 4500)
      SELECT 'dash-' || printf('%05d', x), 'dash-idem-' || printf('%05d', x),
        'dashboard-bulk', CASE WHEN x <= 4000 THEN 'bulk-provider' ELSE 'null-provider' END,
        'usage', CASE WHEN x % 4 = 0 THEN NULL WHEN x % 4 = 1 THEN 0 ELSE 0.25 END,
        CASE WHEN x % 3 = 0 THEN NULL ELSE 1 END,
        CASE WHEN x % 5 = 0 THEN NULL ELSE x END,
        CASE WHEN x = 3999 THEN 900 WHEN x = 4000 THEN 901 ELSE NULL END,
        CASE WHEN x IN (3999, 4000) THEN 'month' ELSE NULL END,
        '2026-10-04T12:00:00.000+00:00',
        CASE WHEN x = 3 THEN '{"_derivedCostUsd":"1abc"}' WHEN x % 3 = 0 THEN '{"_derivedCostUsd":0.125}' ELSE NULL END,
        'estimated', 'estimated', '2026-10-04T12:00:00.000+00:00'
      FROM c
    `);
    const providerUuid = "123e4567-e89b-42d3-a456-426614174000";
    const digest = "ab".repeat(32);
    await prisma.externalUsageEvent.createMany({
      data: [
        ev({ id: "dash-analytics", idempotencyKey: "dash-analytics", sourceApp: "claude-code", provider: "anthropic", service: "claude-code", metricType: "cost", costUsd: 100 }),
        ev({ id: "dash-valid-receipt", idempotencyKey: `billing-receipt:v1:${digest}`, sourceApp: "billing-receipt-import", provider: "billing", service: "api-prepaid-funding", label: "receipt_cash_paid", keyRef: `provider:${providerUuid}:billing-receipt:${digest}`, billingMode: "actual", confidence: "actual", metricType: "cost", unit: "usd", costUsd: 25 }),
        ev({ id: "dash-bad-receipt", idempotencyKey: "dash-bad-receipt", sourceApp: "billing-receipt-import", provider: "billing", service: "api-prepaid-funding", label: "receipt_cash_paid", keyRef: "bad", billingMode: "actual", confidence: "actual", metricType: "cost", unit: "usd", costUsd: 7 }),
        ev({ id: "dash-quota", idempotencyKey: "dash-quota", sourceApp: "dashboard-bulk", provider: "bulk-provider", metricType: "quota_sync", costUsd: 500 }),
      ],
    });

    const { summarizeExternalUsageEvents, buildDailySpendSeries } = await import("../external-usage-events");
    const oldGroups = await prisma.$queryRawUnsafe<Array<{ provider: string; metricType: string; count: bigint; priced: bigint; cost: number | null; latest: string }>>(`
      SELECT "provider", "metricType", COUNT(*) AS "count", COUNT("costUsd") AS "priced",
        SUM("costUsd") AS "cost", MAX("occurredAt") AS "latest"
      FROM "ExternalUsageEvent"
      WHERE "occurredAt" >= '2026-10-01T00:00:00.000+00:00' AND "occurredAt" <= '2026-10-05T00:00:00.000+00:00'
        AND "metricType" NOT IN ('quota_sync', 'credit_balance')
        AND ("sourceApp" <> 'billing-receipt-import' OR "service" IS NULL OR "service" <> 'api-prepaid-funding' OR "label" IS NULL OR "label" <> 'receipt_cash_paid' OR "billingMode" <> 'actual' OR "metricType" <> 'cost' OR "confidence" <> 'actual')
      GROUP BY "provider", "metricType"
    `);
    const oldDaily = await prisma.$queryRawUnsafe<Array<{ day: string; cost: number }>>(`
      SELECT date("occurredAt") AS "day", COALESCE(SUM("costUsd"), 0) AS "cost"
      FROM "ExternalUsageEvent"
      WHERE "occurredAt" >= '2026-10-01T00:00:00.000+00:00' AND "occurredAt" <= '2026-10-05T00:00:00.000+00:00'
        AND "metricType" NOT IN ('quota_sync', 'credit_balance') GROUP BY date("occurredAt")
    `);
    const oldDerived = await prisma.$queryRawUnsafe<Array<{ total: number; count: bigint }>>(`
      SELECT COALESCE(SUM(json_extract("metadata", '$._derivedCostUsd')), 0) AS "total", COUNT(*) AS "count"
      FROM "ExternalUsageEvent" WHERE "occurredAt" >= '2026-10-01T00:00:00.000+00:00' AND json_extract("metadata", '$._derivedCostUsd') IS NOT NULL
    `);
    const previousFlag = process.env.INGEST_COST_DERIVATION_ENABLED;
    process.env.INGEST_COST_DERIVATION_ENABLED = "true";
    let summary: Awaited<ReturnType<typeof summarizeExternalUsageEvents>>;
    let daily: Awaited<ReturnType<typeof buildDailySpendSeries>>;
    let timerFired = false;
    const timerTurn = new Promise<void>((resolve) => setTimeout(() => {
      timerFired = true;
      resolve();
    }, 0));
    try {
      summary = await summarizeExternalUsageEvents(MONTH_START, MONTH_START, NOW);
      daily = await buildDailySpendSeries(MONTH_START, MONTH_START, NOW);
      await timerTurn;
    } finally {
      if (previousFlag === undefined) delete process.env.INGEST_COST_DERIVATION_ENABLED;
      else process.env.INGEST_COST_DERIVATION_ENABLED = previousFlag;
    }
    expect(timerFired).toBe(true);
    for (const old of oldGroups) {
      const isAnalytics = old.provider === "anthropic";
      const actual = summary.groups.find((group) => group.provider === old.provider && group.metricType === old.metricType);
      expect(actual?.eventCount).toBe(Number(old.count));
      expect(actual?.pricedEventCount).toBe(isAnalytics ? 0 : Number(old.priced));
      expect(actual?.totalCostUsd).toBeCloseTo(isAnalytics ? 0 : old.cost ?? 0, 8);
      expect(actual?.latestAt).toBe(new Date(old.latest).toISOString());
    }
    expect(summary.derivedCostEstimateEventCount).toBe(Number(oldDerived[0].count));
    expect(summary.derivedCostEstimateUsd).toBeCloseTo(oldDerived[0].total, 8);
    expect(summary.groups.find((group) => group.provider === "bulk-provider")?.limit).toBe(901);
    expect(summary.groups.find((group) => group.provider === "anthropic")?.estimatedApiEquivalentUsd).toBe(100);
    expect(summary.groups.find((group) => group.provider === "billing")).toMatchObject({ totalCostUsd: 7, receiptCashPaidUsd: 25 });
    expect(daily).toEqual(oldDaily.map((row) => ({ day: row.day, totalCostUsd: row.cost })));
  });

  it("preserves the mixed rollup/raw daily split for a non-midnight cutoff", async () => {
    const cutoff = new Date("2026-10-03T12:00:00.000Z");
    await prisma.externalUsageEventDailyRollup.createMany({ data: [
      { day: new Date("2026-10-02T00:00:00.000Z"), groupKey: "mixed-1", sourceApp: "history", provider: "p", billingMode: "estimated", metricType: "cost", confidence: "estimated", eventCount: 1, pricedEventCount: 1, unpricedEventCount: 0, unclassifiedCostEventCount: 0, totalCostUsd: 10, latestOccurredAt: new Date("2026-10-02T10:00:00.000Z") },
      { day: new Date("2026-10-03T00:00:00.000Z"), groupKey: "mixed-2", sourceApp: "history", provider: "p", billingMode: "estimated", metricType: "cost", confidence: "estimated", eventCount: 1, pricedEventCount: 1, unpricedEventCount: 0, unclassifiedCostEventCount: 0, totalCostUsd: 20, latestOccurredAt: new Date("2026-10-03T11:00:00.000Z") },
    ] });
    await prisma.externalUsageEvent.createMany({ data: [
      ev({ id: "mixed-before-cutoff", idempotencyKey: "mixed-before-cutoff", costUsd: 5, occurredAt: new Date("2026-10-03T10:00:00.000Z") }),
      ev({ id: "mixed-after-cutoff", idempotencyKey: "mixed-after-cutoff", costUsd: 7, occurredAt: new Date("2026-10-03T13:00:00.000Z") }),
    ] });
    const { buildDailySpendSeries } = await import("../external-usage-events");
    const actual = await buildDailySpendSeries(new Date("2026-10-02T00:00:00.000Z"), cutoff, NOW);
    expect(actual).toEqual([
      { day: "2026-10-02", totalCostUsd: 10 },
      { day: "2026-10-03", totalCostUsd: 27 },
    ]);
  });

  it("aggregates a large tied-timestamp MTD fixture in a child while the parent event loop advances", async () => {
    // 12,000 rows at one identical timestamp exercise native aggregation
    // without transferring the raw rows through the parent process.
    await prisma.$executeRawUnsafe(`
      INSERT INTO "ExternalUsageEvent"
        ("id", "idempotencyKey", "sourceApp", "provider", "metricType", "costUsd", "occurredAt", "billingMode", "confidence", "createdAt")
      WITH RECURSIVE c(x) AS (
        SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 12000
      )
      SELECT
        'bulk-' || x,
        'bulk-idem-' || x,
        'bulk-app',
        'bulk-provider',
        'cost',
        0.5,
        '2026-10-04T12:00:00.000+00:00',
        'estimated',
        'estimated',
        '2026-10-04T12:00:00.000+00:00'
      FROM c
    `);

    let timerFired = false;
    const timerTurn = new Promise<void>((resolve) => setTimeout(() => {
      timerFired = true;
      resolve();
    }, 0));

    const { sumMonthToDateExternalCostByProvider } = await import(
      "../external-usage-events"
    );
    const byProvider = await sumMonthToDateExternalCostByProvider(MONTH_START, MONTH_START, NOW);
    await timerTurn;

    // The pre-scheduled timer ran while the read-only child performed SQLite work.
    expect(timerFired).toBe(true);

    const bulk = byProvider.get("bulk-provider");
    expect(bulk?.usagePushed).toBeCloseTo(6000, 6);
    expect(bulk?.pricedEventCount).toBe(12000);
    expect(bulk?.unpricedEventCount).toBe(0);

  });
});
