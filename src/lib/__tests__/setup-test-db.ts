import { execFileSync } from "child_process";

const TEST_SCHEMA_SQL = `
PRAGMA foreign_keys=ON;

CREATE TABLE "Provider" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "type" TEXT NOT NULL DEFAULT 'builtin',
  "apiKey" TEXT,
  "config" JSONB,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "credits" REAL NOT NULL DEFAULT 0,
  "refreshIntervalMin" INTEGER NOT NULL DEFAULT 60,
  "groupId" TEXT,
  "category" TEXT NOT NULL DEFAULT 'api',
  "label" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "Project" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "nameKey" TEXT,
  "description" TEXT,
  "monthlyBudgetUsd" REAL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "ProviderProjectAllocation" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "providerId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "percentage" REAL NOT NULL DEFAULT 100,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "ProviderProjectAllocation_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProviderProjectAllocation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "ProviderPlan" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "providerId" TEXT NOT NULL,
  "billingMode" TEXT NOT NULL DEFAULT 'manual',
  "fixedMonthlyCostUsd" REAL,
  "monthlyBudgetUsd" REAL,
  "monthlyRequestLimit" INTEGER,
  "lowBalanceUsd" REAL,
  "lowCredits" REAL,
  "renewalDate" DATETIME,
  "billingInterval" TEXT DEFAULT 'monthly',
  "mustKeepFunded" BOOLEAN NOT NULL DEFAULT false,
  "notes" TEXT,
  "knobEnv" JSONB,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "ProviderPlan_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "Subscription" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "providerId" TEXT NOT NULL,
  "projectId" TEXT,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "costUsd" REAL NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "interval" TEXT NOT NULL DEFAULT 'monthly',
  "intervalCount" INTEGER NOT NULL DEFAULT 1,
  "anchorDay" INTEGER,
  "startDate" DATETIME NOT NULL,
  "currentPeriodStart" DATETIME NOT NULL,
  "nextRenewalAt" DATETIME NOT NULL,
  "lastChargedPeriodStart" DATETIME,
  "autoRenew" BOOLEAN NOT NULL DEFAULT true,
  "status" TEXT NOT NULL DEFAULT 'active',
  "canceledAt" DATETIME,
  "notes" TEXT,
  "knobEnv" JSONB,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "Subscription_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Subscription_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "UsageSnapshot" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "providerId" TEXT NOT NULL,
  "fetchedAt" DATETIME NOT NULL,
  "balance" REAL,
  "totalCost" REAL,
  "totalRequests" INTEGER,
  "credits" REAL,
  "rawData" JSONB,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UsageSnapshot_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "UsageSnapshotDailyRollup" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "providerId" TEXT NOT NULL,
  "day" DATETIME NOT NULL,
  "sampleCount" INTEGER NOT NULL DEFAULT 0,
  "firstFetchedAt" DATETIME NOT NULL,
  "lastFetchedAt" DATETIME NOT NULL,
  "latestBalance" REAL,
  "latestTotalCost" REAL,
  "latestTotalRequests" INTEGER,
  "latestCredits" REAL,
  "minBalance" REAL,
  "maxBalance" REAL,
  "maxTotalCost" REAL,
  "maxTotalRequests" INTEGER,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "UsageSnapshotDailyRollup_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "ExternalUsageEvent" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "idempotencyKey" TEXT NOT NULL,
  "sourceApp" TEXT NOT NULL,
  "environment" TEXT,
  "provider" TEXT NOT NULL,
  "service" TEXT,
  "label" TEXT,
  "keyRef" TEXT,
  "billingMode" TEXT NOT NULL DEFAULT 'estimated',
  "metricType" TEXT NOT NULL DEFAULT 'usage',
  "quantity" REAL,
  "unit" TEXT,
  "costUsd" REAL,
  "requests" INTEGER,
  "credits" REAL,
  "limit" REAL,
  "limitWindow" TEXT,
  "tier" TEXT,
  "confidence" TEXT NOT NULL DEFAULT 'estimated',
  "windowStart" DATETIME,
  "windowEnd" DATETIME,
  "occurredAt" DATETIME NOT NULL,
  "metadata" JSONB,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "projectId" TEXT,
  CONSTRAINT "ExternalUsageEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "ExternalUsageEventDailyRollup" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "day" DATETIME NOT NULL,
  "groupKey" TEXT NOT NULL,
  "sourceApp" TEXT NOT NULL,
  "environment" TEXT,
  "provider" TEXT NOT NULL,
  "service" TEXT,
  "label" TEXT,
  "keyRef" TEXT,
  "billingMode" TEXT NOT NULL,
  "metricType" TEXT NOT NULL,
  "unit" TEXT,
  "limitWindow" TEXT,
  "tier" TEXT,
  "confidence" TEXT NOT NULL,
  "eventCount" INTEGER NOT NULL DEFAULT 0,
  "totalCostUsd" REAL NOT NULL DEFAULT 0,
  "totalRequests" INTEGER NOT NULL DEFAULT 0,
  "totalQuantity" REAL NOT NULL DEFAULT 0,
  "totalCredits" REAL NOT NULL DEFAULT 0,
  "maxLimit" REAL,
  "latestOccurredAt" DATETIME NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  "projectId" TEXT
);

CREATE TABLE "ExternalUsageEventTombstone" (
  "idempotencyKey" TEXT NOT NULL PRIMARY KEY,
  "occurredAt" DATETIME NOT NULL,
  "prunedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "OtlpMetricState" (
  "seriesKey" TEXT NOT NULL PRIMARY KEY,
  "metricName" TEXT NOT NULL,
  "startTimeUnixNano" TEXT,
  "lastTimeUnixNano" TEXT NOT NULL,
  "lastValue" REAL NOT NULL,
  "lastPointKey" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "ProviderAlertNotification" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "providerId" TEXT NOT NULL,
  "stateKey" TEXT NOT NULL,
  "alertCode" TEXT NOT NULL,
  "severity" TEXT NOT NULL,
  "providerName" TEXT NOT NULL,
  "providerDisplayName" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "firstDetectedAt" DATETIME NOT NULL,
  "lastDetectedAt" DATETIME NOT NULL,
  "lastSentAt" DATETIME,
  "sendCount" INTEGER NOT NULL DEFAULT 0,
  "resolvedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "ProviderAlertNotification_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ProviderPlan_providerId_key" ON "ProviderPlan"("providerId");
CREATE UNIQUE INDEX "Project_name_key" ON "Project"("name");
CREATE UNIQUE INDEX "Project_nameKey_key" ON "Project"("nameKey");
CREATE UNIQUE INDEX "ProviderProjectAllocation_providerId_projectId_key" ON "ProviderProjectAllocation"("providerId", "projectId");
CREATE INDEX "UsageSnapshotDailyRollup_day_idx" ON "UsageSnapshotDailyRollup"("day");
CREATE UNIQUE INDEX "UsageSnapshotDailyRollup_providerId_day_key" ON "UsageSnapshotDailyRollup"("providerId", "day");
CREATE UNIQUE INDEX "ExternalUsageEvent_idempotencyKey_key" ON "ExternalUsageEvent"("idempotencyKey");
CREATE INDEX "ExternalUsageEvent_sourceApp_occurredAt_idx" ON "ExternalUsageEvent"("sourceApp", "occurredAt");
CREATE INDEX "ExternalUsageEvent_provider_occurredAt_idx" ON "ExternalUsageEvent"("provider", "occurredAt");
CREATE INDEX "ExternalUsageEvent_keyRef_occurredAt_idx" ON "ExternalUsageEvent"("keyRef", "occurredAt");
CREATE INDEX "ExternalUsageEvent_projectId_occurredAt_idx" ON "ExternalUsageEvent"("projectId", "occurredAt");
CREATE INDEX "ExternalUsageEventDailyRollup_sourceApp_day_idx" ON "ExternalUsageEventDailyRollup"("sourceApp", "day");
CREATE INDEX "ExternalUsageEventDailyRollup_provider_day_idx" ON "ExternalUsageEventDailyRollup"("provider", "day");
CREATE INDEX "ExternalUsageEventDailyRollup_projectId_day_idx" ON "ExternalUsageEventDailyRollup"("projectId", "day");
CREATE UNIQUE INDEX "ExternalUsageEventDailyRollup_day_groupKey_key" ON "ExternalUsageEventDailyRollup"("day", "groupKey");
CREATE INDEX "Subscription_providerId_idx" ON "Subscription"("providerId");
CREATE INDEX "Subscription_projectId_idx" ON "Subscription"("projectId");
CREATE INDEX "Subscription_status_nextRenewalAt_idx" ON "Subscription"("status", "nextRenewalAt");
CREATE INDEX "ExternalUsageEventTombstone_occurredAt_idx" ON "ExternalUsageEventTombstone"("occurredAt");
CREATE INDEX "ExternalUsageEventTombstone_prunedAt_idx" ON "ExternalUsageEventTombstone"("prunedAt");
CREATE INDEX "OtlpMetricState_updatedAt_idx" ON "OtlpMetricState"("updatedAt");
CREATE UNIQUE INDEX "ProviderAlertNotification_stateKey_key" ON "ProviderAlertNotification"("stateKey");
CREATE INDEX "ProviderAlertNotification_providerId_resolvedAt_idx" ON "ProviderAlertNotification"("providerId", "resolvedAt");
CREATE INDEX "ProviderAlertNotification_lastSentAt_idx" ON "ProviderAlertNotification"("lastSentAt");
`;

export function setupPrismaSqliteTestDb(dbPath: string): void {
  execFileSync("sqlite3", [dbPath], {
    input: TEST_SCHEMA_SQL,
    env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
    stdio: ["pipe", "pipe", "pipe"],
  });
}
