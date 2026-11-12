import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const preGenerationFixturePath = path.join(
  import.meta.dirname,
  "fixtures/alert-persistence-pre-generation.sql"
);

describe("alert persistence migration", () => {
  it("adds incident and claim fencing columns without rewriting legacy uncertainty", () => {
    const work = fs.mkdtempSync(
      path.join(os.tmpdir(), "alert-persistence-migration-")
    );
    const dbPath = path.join(work, "legacy.db");

    try {
      const legacy = new DatabaseSync(dbPath);
      try {
        legacy.exec(fs.readFileSync(preGenerationFixturePath, "utf8"));
        legacy
          .prepare(
            `INSERT INTO "Provider"
              ("id", "name", "displayName", "createdAt")
             VALUES (?, ?, ?, ?)`
          )
          .run("provider-legacy", "legacy", "Legacy", "2026-07-19 12:00:00");
        legacy
          .prepare(
            `INSERT INTO "ProviderAlertNotification"
              ("id", "providerId", "stateKey", "alertCode", "severity",
               "providerName", "providerDisplayName", "message",
               "firstDetectedAt", "lastDetectedAt", "createdAt", "updatedAt")
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            "notification-legacy",
            "provider-legacy",
            "provider-legacy:balance_low",
            "balance_low",
            "warning",
            "legacy",
            "Legacy",
            "legacy incident",
            "2026-07-19 12:00:00",
            "2026-07-19 12:00:00",
            "2026-07-19 12:00:00",
            "2026-07-19 12:00:00"
          );
        legacy
          .prepare(
            `INSERT INTO "ProviderAlertChannelDelivery"
              ("id", "notificationId", "channelKey", "channelKind",
               "lastAttemptAt", "lastError", "createdAt", "updatedAt")
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            "channel-legacy",
            "notification-legacy",
            "pagerduty:legacy-fingerprint",
            "pagerduty",
            "2026-07-19 12:00:00",
            "delivery_outcome_unknown",
            "2026-07-19 12:00:00",
            "2026-07-19 12:00:00"
          );
      } finally {
        legacy.close();
      }

      execFileSync("node", [path.join(repoRoot, "scripts/migrate-safe.mjs")], {
        cwd: repoRoot,
        env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
        stdio: "pipe",
      });

      const migrated = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const provider = migrated
          .prepare(
            `SELECT "alertConfigGeneration" FROM "Provider" WHERE "id" = ?`
          )
          .get("provider-legacy") as
          | { alertConfigGeneration: number }
          | undefined;
        expect(provider).toEqual({ alertConfigGeneration: 0 });

        const notification = migrated
          .prepare(
            `SELECT "incidentGeneration", "pagerDutyAuditState",
                    "operationClaimToken", "operationClaimGeneration",
                    "operationClaimExpiresAt", "operationClaimIncidentGeneration",
                    "operationClaimConfigGeneration",
                    "operationClaimEvidenceSourceAt",
                    "operationClaimEvidenceAt", "operationClaimEvidenceState",
                    "evidenceSourceAt", "evidenceWatermarkAt", "evidenceWatermarkState",
                    "evidenceConfigGeneration"
             FROM "ProviderAlertNotification" WHERE "id" = ?`
          )
          .get("notification-legacy") as
          | {
              incidentGeneration: number;
              pagerDutyAuditState: string;
              operationClaimToken: string | null;
              operationClaimGeneration: number;
              operationClaimExpiresAt: string | null;
              operationClaimIncidentGeneration: number | null;
              operationClaimConfigGeneration: number | null;
              operationClaimEvidenceSourceAt: string | null;
              operationClaimEvidenceAt: string | null;
              operationClaimEvidenceState: string | null;
              evidenceSourceAt: string | null;
              evidenceWatermarkAt: string | null;
              evidenceWatermarkState: string;
              evidenceConfigGeneration: number;
            }
          | undefined;
        expect(notification).toEqual({
          incidentGeneration: 1,
          pagerDutyAuditState: "legacy_unknown",
          operationClaimToken: null,
          operationClaimGeneration: 0,
          operationClaimExpiresAt: null,
          operationClaimIncidentGeneration: null,
          operationClaimConfigGeneration: null,
          operationClaimEvidenceSourceAt: null,
          operationClaimEvidenceAt: null,
          operationClaimEvidenceState: null,
          evidenceSourceAt: null,
          evidenceWatermarkAt: null,
          evidenceWatermarkState: "legacy",
          evidenceConfigGeneration: 0,
        });

        const channel = migrated
          .prepare(
            `SELECT "triggerClaimGeneration", "triggerIncidentGeneration",
                    "triggerOperationClaimGeneration",
                    "lastSucceededIncidentGeneration", "pagerDutyDedupKey",
                    "resolveClaimGeneration", "resolveClaimToken",
                    "resolveIncidentGeneration", "resolveOperationClaimGeneration",
                    "lastResolvedIncidentGeneration",
                    "lastError"
             FROM "ProviderAlertChannelDelivery" WHERE "id" = ?`
          )
          .get("channel-legacy") as Record<string, unknown> | undefined;
        expect(channel).toMatchObject({
          triggerClaimGeneration: 0,
          triggerIncidentGeneration: null,
          triggerOperationClaimGeneration: null,
          lastSucceededIncidentGeneration: null,
          pagerDutyDedupKey: null,
          resolveClaimGeneration: 0,
          resolveClaimToken: null,
          resolveIncidentGeneration: null,
          resolveOperationClaimGeneration: null,
          lastResolvedIncidentGeneration: null,
          lastError: "delivery_outcome_unknown",
        });
      } finally {
        migrated.close();
      }
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }, 180_000);
});
