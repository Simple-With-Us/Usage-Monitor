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

  it("walks multiple chunks on an (occurredAt, id) cursor and yields to the event loop", async () => {
    // 12,000 rows at one identical timestamp: pagination must rely on the
    // id half of the cursor, and crossing the 10,000-row chunk boundary
    // must neither lose nor double-count a row.
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

    const rawQuery = vi.spyOn(prisma, "$queryRaw");
    let immediateFired = false;
    setImmediate(() => {
      immediateFired = true;
    });

    const { sumMonthToDateExternalCostByProvider } = await import(
      "../external-usage-events"
    );
    const byProvider = await sumMonthToDateExternalCostByProvider(MONTH_START, MONTH_START, NOW);

    // The pre-scheduled macrotask ran before the scan resolved: the scan
    // took a real event-loop turn between chunks instead of holding the
    // loop for one monolithic aggregation.
    expect(immediateFired).toBe(true);

    const bulk = byProvider.get("bulk-provider");
    expect(bulk?.usagePushed).toBeCloseTo(6000, 6);
    expect(bulk?.pricedEventCount).toBe(12000);
    expect(bulk?.unpricedEventCount).toBe(0);

    const sqlTextOf = (query: unknown): string =>
      typeof query === "object" && query !== null && "sql" in query
        ? String((query as { sql: unknown }).sql)
        : String(query);
    const scanCalls = rawQuery.mock.calls.filter(([query]) => {
      const text = sqlTextOf(query);
      return (
        text.includes('FROM "ExternalUsageEvent"') &&
        text.includes('"costUsd"') &&
        text.includes('ORDER BY "occurredAt" ASC, "id" ASC')
      );
    });
    expect(scanCalls.length).toBe(2);
    expect(sqlTextOf(scanCalls[0][0])).not.toContain('"id" >');
    expect(sqlTextOf(scanCalls[1][0])).toContain('"id" >');
  });
});
