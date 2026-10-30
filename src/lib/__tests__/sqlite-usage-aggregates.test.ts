import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { setupPrismaSqliteTestDb } from "./setup-test-db";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as new (path: string, options?: object) => {
  prepare(sql: string): { get(): { integrity_check: string } };
  close(): void;
};

let dbPath: string;
let databaseUrl: string;
let prisma: typeof import("@/lib/prisma").prisma;
let querySqliteUsageAggregate: typeof import("@/lib/sqlite-usage-aggregates").querySqliteUsageAggregate;

beforeAll(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-usage-aggregate-"));
  dbPath = path.join(directory, "test.db");
  databaseUrl = `file:${dbPath}`;
  process.env.DATABASE_URL = databaseUrl;
  process.env.ENCRYPTION_KEY = "45".repeat(32);
  setupPrismaSqliteTestDb(dbPath);
  ({ prisma } = await import("@/lib/prisma"));
  ({ querySqliteUsageAggregate } = await import("@/lib/sqlite-usage-aggregates"));
}, 60_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (dbPath && fs.existsSync(dbPath)) {
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

beforeEach(async () => {
  await prisma.externalUsageEvent.deleteMany();
});

const SINCE = new Date("2026-10-01T00:00:00.000Z");
const UNTIL = new Date("2026-10-05T00:00:00.000Z");

function event(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    idempotencyKey: `aggregate-${id}`,
    sourceApp: "codex",
    provider: "openai",
    metricType: "cost",
    billingMode: "estimated",
    confidence: "estimated",
    occurredAt: new Date("2026-10-04T12:00:00.000Z"),
    ...overrides,
  };
}

describe("read-only SQLite usage aggregate child", () => {
  it("matches the legacy row-number winner for canonical millisecond timestamps and ID ties", async () => {
    await prisma.externalUsageEvent.createMany({
      data: [
        event("same-time-a", { label: "same-time", occurredAt: new Date("2026-10-04T12:00:00.000Z") }),
        event("same-time-z", { label: "same-time", occurredAt: new Date("2026-10-04T12:00:00.000Z") }),
        event("later-time-z", { label: "millisecond", occurredAt: new Date("2026-10-04T12:00:00.001Z") }),
        event("earlier-time-zz", { label: "millisecond", occurredAt: new Date("2026-10-04T12:00:00.000Z") }),
      ],
    });

    const summary = await querySqliteUsageAggregate<Array<Record<string, unknown>>>("summary", SINCE, UNTIL, databaseUrl);
    const legacy = await prisma.$queryRawUnsafe<Array<{
      label: string;
      id: string;
      occurredAt: string | Date;
    }>>(`
      WITH ranked AS (
        SELECT "label", "id", "occurredAt",
          ROW_NUMBER() OVER (
            PARTITION BY "sourceApp", "environment", "provider", "service", "label", "projectId",
              "metricType", "unit", "limit", "limitWindow"
            ORDER BY "occurredAt" DESC, "id" DESC
          ) AS rank
        FROM "ExternalUsageEvent"
        WHERE "occurredAt" >= '${SINCE.toISOString().replace("Z", "+00:00")}'
          AND "occurredAt" <= '${UNTIL.toISOString().replace("Z", "+00:00")}'
          AND "metricType" NOT IN ('quota_sync', 'credit_balance')
          AND ("sourceApp" <> 'billing-receipt-import' OR "service" IS NULL OR "service" <> 'api-prepaid-funding'
            OR "label" IS NULL OR "label" <> 'receipt_cash_paid' OR "billingMode" <> 'actual'
            OR "metricType" <> 'cost' OR "confidence" <> 'actual')
      )
      SELECT "label", "id", "occurredAt" FROM ranked WHERE rank = 1
    `);

    for (const winner of legacy) {
      const packed = summary.find((row) => row.label === winner.label)?.packedLatest;
      const canonicalTimestamp = winner.occurredAt instanceof Date
        ? winner.occurredAt.toISOString().replace("Z", "+00:00")
        : winner.occurredAt;
      expect(packed).toBe(`${canonicalTimestamp}\u0001${winner.id}`);
    }
    expect(legacy.find((row) => row.label === "same-time")?.id).toBe("same-time-z");
    expect(legacy.find((row) => row.label === "millisecond")?.id).toBe("later-time-z");
  });

  it("matches legacy aggregate semantics for nulls, UTC days, receipt candidates, malformed estimates and tied limits", async () => {
    const providerId = "123e4567-e89b-42d3-a456-426614174000";
    const digest = "ab".repeat(32);
    await prisma.externalUsageEvent.createMany({
      data: [
        event("tie-a", { costUsd: 1.25, requests: 1, quantity: 10, limit: 100, limitWindow: "month" }),
        event("tie-z", { costUsd: null, requests: null, quantity: null, limit: 200, limitWindow: "month" }),
        event("derived-malformed", { metadata: { _derivedCostUsd: "1abc" } }),
        event("derived-null", { metadata: { _derivedCostUsd: null } }),
        event("status", { metricType: "quota_sync", costUsd: 500 }),
        event("valid-receipt-candidate", {
          sourceApp: "billing-receipt-import", provider: "billing", service: "api-prepaid-funding",
          label: "receipt_cash_paid", keyRef: `provider:${providerId}:billing-receipt:${digest}`,
          billingMode: "actual", confidence: "actual", metricType: "cost", unit: "usd", costUsd: 25,
        }),
        event("invalid-receipt-candidate", {
          sourceApp: "billing-receipt-import", provider: "billing", service: "api-prepaid-funding",
          label: "receipt_cash_paid", keyRef: "bad", billingMode: "actual",
          confidence: "actual", metricType: "cost", unit: "usd", costUsd: 7,
        }),
      ],
    });

    const summary = await querySqliteUsageAggregate<Array<Record<string, unknown>>>("summary", SINCE, UNTIL, databaseUrl);
    const legacySummary = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
      SELECT "sourceApp", "environment", "provider", "service", "label", "projectId",
        "metricType", "unit", "limit", "limitWindow", COUNT(*) AS "eventCount",
        COUNT("costUsd") AS "pricedEventCount", SUM("costUsd") AS "totalCostUsd",
        SUM("requests") AS "totalRequests", SUM("quantity") AS "totalQuantity",
        MAX("occurredAt") AS "latestAt"
      FROM "ExternalUsageEvent"
      WHERE "occurredAt" >= '${SINCE.toISOString().replace("Z", "+00:00")}'
        AND "occurredAt" <= '${UNTIL.toISOString().replace("Z", "+00:00")}'
        AND "metricType" NOT IN ('quota_sync', 'credit_balance')
        AND ("sourceApp" <> 'billing-receipt-import' OR "service" IS NULL OR "service" <> 'api-prepaid-funding'
          OR "label" IS NULL OR "label" <> 'receipt_cash_paid' OR "billingMode" <> 'actual'
          OR "metricType" <> 'cost' OR "confidence" <> 'actual')
      GROUP BY "sourceApp", "environment", "provider", "service", "label", "projectId",
        "metricType", "unit", "limit", "limitWindow"
    `);
    expect(summary).toHaveLength(legacySummary.length);
    for (const old of legacySummary) {
      const match = summary.find((row) => row.provider === old.provider && row.limit === old.limit);
      expect(match).toMatchObject({
        sourceApp: old.sourceApp,
        metricType: old.metricType,
        eventCount: Number(old.eventCount),
        pricedEventCount: Number(old.pricedEventCount),
        totalCostUsd: old.totalCostUsd,
        totalRequests: old.totalRequests == null ? null : Number(old.totalRequests),
        totalQuantity: old.totalQuantity == null ? null : Number(old.totalQuantity),
      });
    }
    expect(summary.find((row) => row.limit === 200)?.packedLatest).toBe(
      `2026-10-04T12:00:00.000+00:00\u0001tie-z`
    );

    const daily = await querySqliteUsageAggregate<Array<{ day: string; totalUsd: number }>>("daily", SINCE, UNTIL, databaseUrl);
    const legacyDaily = await prisma.$queryRawUnsafe<Array<{ day: string; totalUsd: number }>>(`
      SELECT date("occurredAt") AS "day", COALESCE(SUM("costUsd"), 0) AS "totalUsd"
      FROM "ExternalUsageEvent"
      WHERE "occurredAt" >= '${SINCE.toISOString().replace("Z", "+00:00")}'
        AND "occurredAt" <= '${UNTIL.toISOString().replace("Z", "+00:00")}'
        AND "metricType" NOT IN ('quota_sync', 'credit_balance')
      GROUP BY date("occurredAt") ORDER BY "day"
    `);
    expect(daily).toEqual(legacyDaily);

    const derived = await querySqliteUsageAggregate<Array<{ totalUsd: number; eventCount: number }>>("derived", SINCE, undefined, databaseUrl);
    const legacyDerived = await prisma.$queryRawUnsafe<Array<{ totalUsd: number; eventCount: bigint }>>(`
      SELECT COALESCE(SUM(json_extract("metadata", '$._derivedCostUsd')), 0) AS "totalUsd",
        COUNT(json_extract("metadata", '$._derivedCostUsd')) AS "eventCount"
      FROM "ExternalUsageEvent" WHERE "occurredAt" >= '${SINCE.toISOString().replace("Z", "+00:00")}'
    `);
    expect(derived).toEqual([{ totalUsd: legacyDerived[0].totalUsd, eventCount: Number(legacyDerived[0].eventCount) }]);

    const mtd = await querySqliteUsageAggregate<Array<Record<string, unknown>>>("mtd", SINCE, UNTIL, databaseUrl);
    expect(mtd.some((row) => row.sourceApp === "billing-receipt-import")).toBe(false);
  });

  it("rejects missing databases without creating them and kills a timed-out readonly child safely", async () => {
    const missingPath = path.join(path.dirname(dbPath), "missing.db");
    await expect(querySqliteUsageAggregate("daily", SINCE, UNTIL, `file:${missingPath}`)).rejects.toThrow();
    expect(fs.existsSync(missingPath)).toBe(false);

    await expect(querySqliteUsageAggregate("daily", SINCE, UNTIL, databaseUrl, { timeoutMs: 1 })).rejects.toThrow();
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    expect(db.prepare("PRAGMA integrity_check").get().integrity_check).toBe("ok");
    db.close();
  });

  it("bounds the process-global child reader queue", async () => {
    const requests = Array.from({ length: 11 }, () =>
      querySqliteUsageAggregate("daily", SINCE, UNTIL, databaseUrl)
    );
    const results = await Promise.allSettled(requests);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(10);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toMatchObject({
      message: "SQLite aggregate reader queue is full",
    });
  });

  it("rejects oversized grouped results without returning partial totals and reuses the pool", async () => {
    await prisma.$executeRawUnsafe(`
      INSERT INTO "ExternalUsageEvent"
        ("id", "idempotencyKey", "sourceApp", "provider", "metricType", "label", "costUsd", "occurredAt", "billingMode", "confidence", "createdAt")
      WITH RECURSIVE c(x) AS (
        SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 10001
      )
      SELECT 'cap-' || x, 'cap-idem-' || x, 'cap-test', 'cap-provider', 'cost',
        'group-' || x, 0.01, '2026-10-04T12:00:00.000+00:00', 'estimated', 'estimated',
        '2026-10-04T12:00:00.000+00:00'
      FROM c
    `);

    await expect(querySqliteUsageAggregate("summary", SINCE, UNTIL, databaseUrl)).rejects.toThrow();
    await expect(querySqliteUsageAggregate("mtd", SINCE, UNTIL, databaseUrl)).rejects.toThrow();

    await prisma.externalUsageEvent.deleteMany();
    await prisma.externalUsageEvent.create({
      data: event("after-cap", { sourceApp: "after-cap", costUsd: 0.5, label: "one-group" }),
    });
    const rows = await querySqliteUsageAggregate<Array<Record<string, unknown>>>("mtd", SINCE, UNTIL, databaseUrl);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: "openai", totalCostUsd: 0.5, eventCount: 1 });
  });
});
