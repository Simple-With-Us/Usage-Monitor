PRAGMA foreign_keys=ON;

CREATE TABLE "Provider" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "type" TEXT NOT NULL DEFAULT 'builtin',
  "category" TEXT,
  "apiKey" TEXT,
  "config" JSONB,
  "secretConfig" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "credits" REAL NOT NULL DEFAULT 0,
  "refreshIntervalMin" INTEGER NOT NULL DEFAULT 60,
  "groupId" TEXT,
  "label" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
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
  CONSTRAINT "ProviderAlertNotification_providerId_fkey"
    FOREIGN KEY ("providerId") REFERENCES "Provider" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "ProviderAlertChannelDelivery" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "notificationId" TEXT NOT NULL,
  "channelKey" TEXT NOT NULL,
  "channelKind" TEXT NOT NULL,
  "lastAttemptAt" DATETIME,
  "lastSucceededAt" DATETIME,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "successCount" INTEGER NOT NULL DEFAULT 0,
  "lastResolveAttemptAt" DATETIME,
  "lastResolvedAt" DATETIME,
  "resolveAttemptCount" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "ProviderAlertChannelDelivery_notificationId_fkey"
    FOREIGN KEY ("notificationId") REFERENCES "ProviderAlertNotification" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ProviderAlertNotification_stateKey_key"
  ON "ProviderAlertNotification"("stateKey");
CREATE INDEX "ProviderAlertNotification_providerId_resolvedAt_idx"
  ON "ProviderAlertNotification"("providerId", "resolvedAt");
CREATE INDEX "ProviderAlertNotification_lastSentAt_idx"
  ON "ProviderAlertNotification"("lastSentAt");
CREATE UNIQUE INDEX "ProviderAlertChannelDelivery_notificationId_channelKey_key"
  ON "ProviderAlertChannelDelivery"("notificationId", "channelKey");
CREATE INDEX "ProviderAlertChannelDelivery_notificationId_channelKind_idx"
  ON "ProviderAlertChannelDelivery"("notificationId", "channelKind");
