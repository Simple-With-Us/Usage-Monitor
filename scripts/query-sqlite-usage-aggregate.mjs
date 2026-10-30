import { createRequire } from "node:module";
import { isAbsolute } from "node:path";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const [mode, databasePath, since, until, ...extraArgs] = process.argv.slice(2);
const MODES = new Set(["summary", "daily", "derived", "mtd"]);
const MAX_GROUP_ROWS = 10_000;
const validDate = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+00:00$/.test(value) &&
  !Number.isNaN(Date.parse(value));

if (
  !MODES.has(mode) ||
  !databasePath ||
  !isAbsolute(databasePath) ||
  !validDate(since) ||
  (mode !== "derived" && !validDate(until)) ||
  extraArgs.length > 0
) {
  process.stderr.write('{"errorName":"InvalidArguments"}\n');
  process.exit(2);
}

const receiptExclusion = `(
  "sourceApp" <> 'billing-receipt-import'
  OR "service" IS NULL OR "service" <> 'api-prepaid-funding'
  OR "label" IS NULL OR "label" <> 'receipt_cash_paid'
  OR "billingMode" <> 'actual' OR "metricType" <> 'cost'
  OR "confidence" <> 'actual'
)`;

const queries = {
  summary: `
    WITH "aggregate" AS (
    SELECT
      "sourceApp", "environment", "provider", "service", "label", "projectId",
      "metricType", "unit", "limit", "limitWindow",
      COUNT(*) AS "eventCount",
      COUNT("costUsd") AS "pricedEventCount",
      SUM("costUsd") AS "totalCostUsd",
      SUM("requests") AS "totalRequests",
      SUM("quantity") AS "totalQuantity",
      MAX("occurredAt" || char(1) || "id") AS "packedLatest"
    FROM "ExternalUsageEvent"
    WHERE "occurredAt" >= ? AND "occurredAt" <= ?
      AND "metricType" NOT IN ('quota_sync', 'credit_balance')
      AND ${receiptExclusion}
    GROUP BY
      "sourceApp", "environment", "provider", "service", "label", "projectId",
      "metricType", "unit", "limit", "limitWindow"
    )
    SELECT * FROM "aggregate"
    ORDER BY "packedLatest" ASC
    LIMIT ${MAX_GROUP_ROWS + 1}
  `,
  daily: `
    SELECT
      date("occurredAt") AS "day",
      COALESCE(SUM("costUsd"), 0) AS "totalUsd"
    FROM "ExternalUsageEvent"
    WHERE "occurredAt" >= ? AND "occurredAt" <= ?
      AND "metricType" NOT IN ('quota_sync', 'credit_balance')
    GROUP BY date("occurredAt")
    ORDER BY "day" ASC
    LIMIT ${MAX_GROUP_ROWS + 1}
  `,
  derived: `
    SELECT
      COALESCE(SUM(json_extract("metadata", '$._derivedCostUsd')), 0) AS "totalUsd",
      COUNT(json_extract("metadata", '$._derivedCostUsd')) AS "eventCount"
    FROM "ExternalUsageEvent"
    WHERE "occurredAt" >= ?
  `,
  mtd: `
    SELECT
      "provider", "sourceApp", "service", "label", "projectId", "metricType",
      SUM("costUsd") AS "totalCostUsd",
      COUNT(*) AS "eventCount",
      COUNT("costUsd") AS "pricedEventCount"
    FROM "ExternalUsageEvent"
    WHERE "occurredAt" >= ? AND "occurredAt" <= ?
      AND "metricType" NOT IN ('quota_sync', 'credit_balance')
      AND ${receiptExclusion}
    GROUP BY "provider", "sourceApp", "service", "label", "projectId", "metricType"
    LIMIT ${MAX_GROUP_ROWS + 1}
  `,
};

let db;
try {
  db = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
    timeout: 1_000,
  });
  db.pragma("cache_size = -2000");
  db.pragma("mmap_size = 0");
  db.pragma("temp_store = FILE");
  const params = mode === "derived" ? [since] : [since, until];
  const rows = db.prepare(queries[mode]).all(...params);
  if (mode !== "derived" && rows.length > MAX_GROUP_ROWS) {
    throw new Error("Aggregate result exceeds the row limit");
  }
  process.stdout.write(JSON.stringify(rows));
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({ errorName: error instanceof Error ? error.name : "Error" })}\n`
  );
  process.exitCode = 1;
} finally {
  db?.close();
}
