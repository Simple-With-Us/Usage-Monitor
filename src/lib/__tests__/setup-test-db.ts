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
  "secretConfig" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "alertConfigGeneration" INTEGER NOT NULL DEFAULT 0,
  "credits" REAL NOT NULL DEFAULT 0,
  "refreshIntervalMin" INTEGER NOT NULL DEFAULT 60,
  "groupId" TEXT,
  "billingAccountIdentity" TEXT,
  "category" TEXT NOT NULL DEFAULT 'api',
  "label" TEXT,
  "budgetControlsEnabled" BOOLEAN NOT NULL DEFAULT false,
  "budgetBreachState" TEXT NOT NULL DEFAULT 'ok',
  "budgetBreachStreak" INTEGER NOT NULL DEFAULT 0,
  "budgetControlPeriodStart" DATETIME,
  "budgetPausedAt" DATETIME,
  "budgetPauseReason" TEXT,
  "budgetPauseThresholdUsd" REAL,
  "budgetPauseObservedSpendUsd" REAL,
  "budgetControlLastActionAt" DATETIME,
  "keyDisableRecommended" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "BudgetControlEvent" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "providerId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "breachState" TEXT NOT NULL,
  "thresholdUsd" REAL,
  "observedSpendUsd" REAL,
  "breachStreak" INTEGER,
  "periodStart" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BudgetControlEvent_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider" ("id") ON DELETE CASCADE ON UPDATE CASCADE
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

CREATE TABLE "ProviderKeyIdentity" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "providerId" TEXT NOT NULL,
  "alias" TEXT NOT NULL,
  "description" TEXT,
  "providerReportedKeyIdFingerprint" TEXT,
  "status" TEXT NOT NULL DEFAULT 'active',
  "retiredAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "ProviderKeyIdentity_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "ProviderKeyBinding" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "identityId" TEXT NOT NULL,
  "projectId" TEXT,
  "projectName" TEXT,
  "producerId" TEXT NOT NULL,
  "producerKeyRef" TEXT NOT NULL,
  "providerConnectionRef" TEXT,
  "billingAccountRef" TEXT,
  "effectiveFrom" DATETIME NOT NULL,
  "effectiveTo" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProviderKeyBinding_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "ProviderKeyIdentity" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProviderKeyBinding_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE SET NULL ON UPDATE CASCADE
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

CREATE TABLE "ProviderExternalBilling" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "providerId" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "externalId" TEXT NOT NULL,
  "paidRecurringAuthoritative" BOOLEAN NOT NULL DEFAULT false,
  "kind" TEXT NOT NULL,
  "serviceName" TEXT,
  "planName" TEXT,
  "status" TEXT,
  "amountUsd" REAL,
  "currency" TEXT,
  "billingInterval" TEXT,
  "currentPeriodStart" DATETIME,
  "currentPeriodEnd" DATETIME,
  "nextRenewalAt" DATETIME,
  "requestLimit" REAL,
  "requestLimitWindow" TEXT,
  "spendLimitUsd" REAL,
  "spendLimitWindow" TEXT,
  "usageQuantity" REAL,
  "remainingQuantity" REAL,
  "usageUnit" TEXT,
  "rollupRole" TEXT,
  "dateKind" TEXT,
  "syncedAt" DATETIME NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "ProviderExternalBilling_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "Subscription" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "providerId" TEXT NOT NULL,
  "projectId" TEXT,
  "externalBillingSource" TEXT,
  "externalBillingId" TEXT,
  "externalBillingManaged" BOOLEAN NOT NULL DEFAULT false,
  "externalAdoptionGuardKey" TEXT,
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

CREATE TABLE "ExternalBillingChargeCorrection" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "providerId" TEXT NOT NULL,
  "managedSubscriptionId" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "externalId" TEXT NOT NULL,
  "originalPeriodStart" DATETIME NOT NULL,
  "originalPeriodEnd" DATETIME NOT NULL,
  "originalAmountUsd" REAL NOT NULL,
  "correctedPeriodStart" DATETIME NOT NULL,
  "correctedPeriodEnd" DATETIME NOT NULL,
  "correctedAmountUsd" REAL NOT NULL,
  "correctedGuardKey" TEXT NOT NULL,
  "observedAt" DATETIME NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "ExternalBillingChargeCorrection_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "UsageSnapshot" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "providerId" TEXT NOT NULL,
  "fetchedAt" DATETIME NOT NULL,
  "balance" REAL,
  "totalCost" REAL,
  "fixedCostIncludedUsd" REAL,
  "costWindowStart" DATETIME,
  "costWindowEnd" DATETIME,
  "costScope" TEXT,
  "costIncludesUnknownFixed" BOOLEAN NOT NULL DEFAULT false,
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
  "providerRequestId" TEXT,
  "verifiedCostUsd" REAL,
  "verifiedAt" DATETIME,
  "verificationStatus" TEXT,
  "verifiedSource" TEXT,
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
  "pricedEventCount" INTEGER,
  "unpricedEventCount" INTEGER,
  "unclassifiedCostEventCount" INTEGER,
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

CREATE TABLE "ProviderUsageReconciliation" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "providerId" TEXT NOT NULL,
  "periodStart" DATETIME NOT NULL,
  "periodEnd" DATETIME NOT NULL,
  "keyRef" TEXT NOT NULL DEFAULT '',
  "reportedCostUsd" REAL NOT NULL,
  "reportedEventCount" INTEGER NOT NULL,
  "verifiedCostUsd" REAL,
  "verifiedSource" TEXT,
  "deltaUsd" REAL,
  "deltaRatio" REAL,
  "status" TEXT NOT NULL,
  "checkedAt" DATETIME NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProviderUsageReconciliation_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider" ("id") ON DELETE CASCADE ON UPDATE CASCADE
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
  "incidentGeneration" INTEGER NOT NULL DEFAULT 1,
  "evidenceWatermarkAt" DATETIME,
  "evidenceSourceAt" DATETIME,
  "evidenceWatermarkState" TEXT NOT NULL DEFAULT 'legacy',
  "evidenceConfigGeneration" INTEGER NOT NULL DEFAULT 0,
  "pagerDutyAuditState" TEXT NOT NULL DEFAULT 'legacy_unknown',
  "operationClaimToken" TEXT,
  "operationClaimGeneration" INTEGER NOT NULL DEFAULT 0,
  "operationClaimExpiresAt" DATETIME,
  "operationClaimIncidentGeneration" INTEGER,
  "operationClaimConfigGeneration" INTEGER,
  "operationClaimEvidenceSourceAt" DATETIME,
  "operationClaimEvidenceAt" DATETIME,
  "operationClaimEvidenceState" TEXT,
  "lastSentAt" DATETIME,
  "sendCount" INTEGER NOT NULL DEFAULT 0,
  "resolvedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "ProviderAlertNotification_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "ProviderAlertChannelDelivery" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "notificationId" TEXT NOT NULL,
  "channelKey" TEXT NOT NULL,
  "channelKind" TEXT NOT NULL,
  "lastAttemptAt" DATETIME,
  "lastSucceededAt" DATETIME,
  "triggerClaimToken" TEXT,
  "triggerClaimGeneration" INTEGER NOT NULL DEFAULT 0,
  "triggerClaimExpiresAt" DATETIME,
  "triggerIncidentGeneration" INTEGER,
  "triggerOperationClaimGeneration" INTEGER,
  "lastSucceededIncidentGeneration" INTEGER,
  "pagerDutyDedupKey" TEXT,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "successCount" INTEGER NOT NULL DEFAULT 0,
  "resolveClaimToken" TEXT,
  "resolveClaimGeneration" INTEGER NOT NULL DEFAULT 0,
  "resolveClaimExpiresAt" DATETIME,
  "resolveIncidentGeneration" INTEGER,
  "resolveOperationClaimGeneration" INTEGER,
  "lastResolveAttemptAt" DATETIME,
  "lastResolvedAt" DATETIME,
  "lastResolvedIncidentGeneration" INTEGER,
  "resolveAttemptCount" INTEGER NOT NULL DEFAULT 0,
  "lastResolveError" TEXT,
  "lastError" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "ProviderAlertChannelDelivery_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "ProviderAlertNotification" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ProviderPlan_providerId_key" ON "ProviderPlan"("providerId");
CREATE UNIQUE INDEX "ProviderExternalBilling_providerId_source_externalId_key" ON "ProviderExternalBilling"("providerId", "source", "externalId");
CREATE INDEX "ProviderExternalBilling_providerId_status_idx" ON "ProviderExternalBilling"("providerId", "status");
CREATE UNIQUE INDEX "Project_name_key" ON "Project"("name");
CREATE UNIQUE INDEX "Project_nameKey_key" ON "Project"("nameKey");
CREATE UNIQUE INDEX "ProviderKeyIdentity_providerId_providerReportedKeyIdFingerprint_key" ON "ProviderKeyIdentity"("providerId", "providerReportedKeyIdFingerprint");
CREATE INDEX "ProviderKeyIdentity_providerId_status_idx" ON "ProviderKeyIdentity"("providerId", "status");
CREATE UNIQUE INDEX "ProviderKeyBinding_identityId_producerId_producerKeyRef_effectiveFrom_key" ON "ProviderKeyBinding"("identityId", "producerId", "producerKeyRef", "effectiveFrom");
CREATE INDEX "ProviderKeyBinding_producerId_producerKeyRef_effectiveFrom_effectiveTo_idx" ON "ProviderKeyBinding"("producerId", "producerKeyRef", "effectiveFrom", "effectiveTo");
CREATE INDEX "ProviderKeyBinding_identityId_effectiveFrom_idx" ON "ProviderKeyBinding"("identityId", "effectiveFrom");
CREATE INDEX "ProviderKeyBinding_projectId_effectiveFrom_idx" ON "ProviderKeyBinding"("projectId", "effectiveFrom");
CREATE UNIQUE INDEX "ProviderProjectAllocation_providerId_projectId_key" ON "ProviderProjectAllocation"("providerId", "projectId");
CREATE INDEX "UsageSnapshotDailyRollup_day_idx" ON "UsageSnapshotDailyRollup"("day");
CREATE UNIQUE INDEX "UsageSnapshotDailyRollup_providerId_day_key" ON "UsageSnapshotDailyRollup"("providerId", "day");
CREATE UNIQUE INDEX "ExternalUsageEvent_idempotencyKey_key" ON "ExternalUsageEvent"("idempotencyKey");
CREATE INDEX "ExternalUsageEvent_sourceApp_occurredAt_idx" ON "ExternalUsageEvent"("sourceApp", "occurredAt");
CREATE INDEX "ExternalUsageEvent_provider_occurredAt_idx" ON "ExternalUsageEvent"("provider", "occurredAt");
CREATE INDEX "ExternalUsageEvent_keyRef_occurredAt_idx" ON "ExternalUsageEvent"("keyRef", "occurredAt");
CREATE INDEX "ExternalUsageEvent_projectId_occurredAt_idx" ON "ExternalUsageEvent"("projectId", "occurredAt");
CREATE INDEX "ExternalUsageEvent_provider_verificationStatus_idx" ON "ExternalUsageEvent"("provider", "verificationStatus");
CREATE INDEX "ExternalUsageEvent_provider_providerRequestId_idx" ON "ExternalUsageEvent"("provider", "providerRequestId");
CREATE INDEX "ExternalUsageEventDailyRollup_sourceApp_day_idx" ON "ExternalUsageEventDailyRollup"("sourceApp", "day");
CREATE INDEX "ExternalUsageEventDailyRollup_provider_day_idx" ON "ExternalUsageEventDailyRollup"("provider", "day");
CREATE INDEX "ExternalUsageEventDailyRollup_projectId_day_idx" ON "ExternalUsageEventDailyRollup"("projectId", "day");
CREATE UNIQUE INDEX "ExternalUsageEventDailyRollup_day_groupKey_key" ON "ExternalUsageEventDailyRollup"("day", "groupKey");
CREATE INDEX "Subscription_providerId_idx" ON "Subscription"("providerId");
CREATE UNIQUE INDEX "Subscription_providerId_externalBillingSource_externalBillingId_key" ON "Subscription"("providerId", "externalBillingSource", "externalBillingId");
CREATE UNIQUE INDEX "Subscription_externalAdoptionGuardKey_key" ON "Subscription"("externalAdoptionGuardKey");
CREATE INDEX "Subscription_projectId_idx" ON "Subscription"("projectId");
CREATE INDEX "Subscription_status_nextRenewalAt_idx" ON "Subscription"("status", "nextRenewalAt");
CREATE UNIQUE INDEX "ExternalBillingChargeCorrection_managedSubscriptionId_originalPeriodStart_correctedGuardKey_key" ON "ExternalBillingChargeCorrection"("managedSubscriptionId", "originalPeriodStart", "correctedGuardKey");
CREATE INDEX "ExternalBillingChargeCorrection_providerId_originalPeriodStart_idx" ON "ExternalBillingChargeCorrection"("providerId", "originalPeriodStart");
CREATE INDEX "ExternalBillingChargeCorrection_providerId_correctedGuardKey_idx" ON "ExternalBillingChargeCorrection"("providerId", "correctedGuardKey");
CREATE INDEX "ExternalUsageEventTombstone_occurredAt_idx" ON "ExternalUsageEventTombstone"("occurredAt");
CREATE INDEX "ExternalUsageEventTombstone_prunedAt_idx" ON "ExternalUsageEventTombstone"("prunedAt");
CREATE UNIQUE INDEX "ProviderUsageReconciliation_providerId_periodStart_periodEnd_keyRef_key" ON "ProviderUsageReconciliation"("providerId", "periodStart", "periodEnd", "keyRef");
CREATE INDEX "ProviderUsageReconciliation_providerId_status_idx" ON "ProviderUsageReconciliation"("providerId", "status");
CREATE INDEX "OtlpMetricState_updatedAt_idx" ON "OtlpMetricState"("updatedAt");
CREATE UNIQUE INDEX "ProviderAlertNotification_stateKey_key" ON "ProviderAlertNotification"("stateKey");
CREATE INDEX "ProviderAlertNotification_providerId_resolvedAt_idx" ON "ProviderAlertNotification"("providerId", "resolvedAt");
CREATE INDEX "ProviderAlertNotification_lastSentAt_idx" ON "ProviderAlertNotification"("lastSentAt");
CREATE UNIQUE INDEX "ProviderAlertChannelDelivery_notificationId_channelKey_key" ON "ProviderAlertChannelDelivery"("notificationId", "channelKey");
CREATE INDEX "ProviderAlertChannelDelivery_notificationId_channelKind_idx" ON "ProviderAlertChannelDelivery"("notificationId", "channelKind");
CREATE INDEX "BudgetControlEvent_providerId_createdAt_idx" ON "BudgetControlEvent"("providerId", "createdAt");
CREATE INDEX "BudgetControlEvent_action_createdAt_idx" ON "BudgetControlEvent"("action", "createdAt");
`;

export function setupPrismaSqliteTestDb(dbPath: string): void {
  execFileSync("sqlite3", [dbPath], {
    input: TEST_SCHEMA_SQL,
    env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
    stdio: ["pipe", "pipe", "pipe"],
  });
}
