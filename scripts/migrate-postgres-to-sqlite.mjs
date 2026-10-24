#!/usr/bin/env node
/**
 * One-time data migration: old Postgres database -> new SQLite file.
 *
 * Copies every existing row from the OLD Render Postgres database
 * (api-usage-monitor-db) into the NEW SQLite database file used by the
 * single-web-service deployment, across all 4 tables, preserving ids,
 * timestamps, and (for ExternalUsageEvent) the existing idempotencyKey
 * values verbatim.
 *
 * Run this EXACTLY ONCE, after the new render.yaml (SQLite + disk, no
 * separate Postgres/cron resources) has been deployed, and BEFORE the old
 * Postgres database is deleted.
 *
 * All destination writes run inside a single prisma.$transaction, so a
 * failure partway through (network blip, a bad row, etc.) rolls back
 * everything written so far - the destination SQLite database is left
 * exactly as it was before the run (empty, if this is the first attempt),
 * and it is always safe to just re-run the script. There is no partial-
 * migration state to clean up by hand.
 *
 * POST-MIGRATION DEPENDENCY NOTE (2026-07-29, review finding E7/O11): the
 * `pg` (and `@types/pg`) packages were removed from package.json after the
 * Postgres -> SQLite cutover completed, since this script is the ONLY pg
 * consumer and the migration is finished. If this script ever needs to run
 * again, reinstall them ephemerally first, e.g.:
 *
 *   npm install --no-save pg@^8.22.0 @types/pg@^8.20.0
 *
 * (the lockfile entry was dropped too; any pg 8.x works with this script).
 *
 * HOW TO RUN THIS (read carefully - this touches real production data):
 *
 *   This script must be run from Render's Shell tab for the deployed
 *   `api-usage-monitor` web service - NOT from a local machine. The
 *   destination is a SQLite file on a Render disk mounted at /data, which is
 *   only reachable from that Render instance itself (there is no network
 *   endpoint for it the way there is for a managed Postgres database). So:
 *
 *     1. Open the Render dashboard -> api-usage-monitor (web service) -> Shell.
 *     2. In that shell, DATABASE_URL is already set correctly (it points at
 *        the new SQLite file, e.g. file:/data/prod.db) - you do not need to
 *        set it yourself.
 *     3. Set SOURCE_DATABASE_URL to the OLD Postgres connection string
 *        (copy it from the Render dashboard: Databases -> api-usage-monitor-db
 *        -> Connections -> "External Connection String" or "Internal
 *        Connection String" depending on what's reachable from the shell).
 *     4. Run:
 *          SOURCE_DATABASE_URL="postgresql://..." node scripts/migrate-postgres-to-sqlite.mjs
 *
 *   Required env vars:
 *     - SOURCE_DATABASE_URL  the OLD Postgres connection string (required)
 *     - DATABASE_URL         the NEW SQLite file path (already set in the
 *                            deployed environment; this is the same env var
 *                            Prisma/the app normally uses)
 */

import { Client } from "pg";
import { createPrismaClient } from "./lib/create-prisma-client.mjs";

async function main() {
  const sourceUrl = process.env.SOURCE_DATABASE_URL;
  if (!sourceUrl) {
    console.error(
      "ERROR: SOURCE_DATABASE_URL is not set. It must be the OLD Postgres connection string.\n" +
        "Example: SOURCE_DATABASE_URL=\"postgresql://user:pass@host:5432/db\" node scripts/migrate-postgres-to-sqlite.mjs"
    );
    process.exit(1);
  }

  const pg = new Client({ connectionString: sourceUrl });
  const prisma = createPrismaClient();

  try {
    await pg.connect();
    console.log("Connected to source Postgres database.");

    // Read all source rows up front (outside the destination transaction -
    // Postgres reads here are non-mutating, so there's nothing to roll back
    // on that side).
    const providerRows = (await pg.query('SELECT * FROM "Provider"')).rows;
    console.log(`Provider: ${providerRows.length} rows found in source.`);

    const providerPlanRows = (await pg.query('SELECT * FROM "ProviderPlan"')).rows;
    console.log(`ProviderPlan: ${providerPlanRows.length} rows found in source.`);

    const usageSnapshotRows = (await pg.query('SELECT * FROM "UsageSnapshot"')).rows;
    console.log(`UsageSnapshot: ${usageSnapshotRows.length} rows found in source.`);

    const externalUsageEventRows = (
      await pg.query('SELECT * FROM "ExternalUsageEvent"')
    ).rows;
    console.log(
      `ExternalUsageEvent: ${externalUsageEventRows.length} rows found in source.`
    );

    // Write everything to the destination SQLite database inside a single
    // transaction. If anything fails partway through (a bad row, a
    // constraint violation, etc.), Prisma rolls back every write made in
    // this block, so the destination is left exactly as it was before the
    // run - safe to just fix the issue and re-run the whole script.
    await prisma.$transaction(async (tx) => {
      // 1. Provider (no foreign keys)
      for (const row of providerRows) {
        await tx.provider.create({
          data: {
            id: row.id,
            name: row.name,
            displayName: row.displayName,
            type: row.type,
            apiKey: row.apiKey,
            config: row.config ?? undefined,
            isActive: row.isActive,
            credits: row.credits,
            refreshIntervalMin: row.refreshIntervalMin,
            groupId: row.groupId,
            label: row.label,
            createdAt: row.createdAt,
          },
        });
      }
      console.log(`Provider: ${providerRows.length} rows migrated.`);

      // 2. ProviderPlan (references Provider.id)
      for (const row of providerPlanRows) {
        await tx.providerPlan.create({
          data: {
            id: row.id,
            providerId: row.providerId,
            billingMode: row.billingMode,
            fixedMonthlyCostUsd: row.fixedMonthlyCostUsd,
            monthlyBudgetUsd: row.monthlyBudgetUsd,
            monthlyRequestLimit: row.monthlyRequestLimit,
            lowBalanceUsd: row.lowBalanceUsd,
            lowCredits: row.lowCredits,
            renewalDate: row.renewalDate,
            mustKeepFunded: row.mustKeepFunded,
            notes: row.notes,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          },
        });
      }
      console.log(`ProviderPlan: ${providerPlanRows.length} rows migrated.`);

      // 3. UsageSnapshot (references Provider.id)
      for (const row of usageSnapshotRows) {
        await tx.usageSnapshot.create({
          data: {
            id: row.id,
            providerId: row.providerId,
            fetchedAt: row.fetchedAt,
            balance: row.balance,
            totalCost: row.totalCost,
            fixedCostIncludedUsd: row.fixedCostIncludedUsd,
            costWindowStart: row.costWindowStart,
            costWindowEnd: row.costWindowEnd,
            costScope: row.costScope,
            costIncludesUnknownFixed: row.costIncludesUnknownFixed ?? false,
            totalRequests: row.totalRequests,
            credits: row.credits,
            rawData: row.rawData ?? undefined,
            createdAt: row.createdAt,
          },
        });
      }
      console.log(`UsageSnapshot: ${usageSnapshotRows.length} rows migrated.`);

      // 4. ExternalUsageEvent (no foreign keys, order doesn't matter for it)
      for (const row of externalUsageEventRows) {
        await tx.externalUsageEvent.create({
          data: {
            id: row.id,
            idempotencyKey: row.idempotencyKey,
            sourceApp: row.sourceApp,
            environment: row.environment,
            provider: row.provider,
            service: row.service,
            label: row.label,
            keyRef: row.keyRef,
            billingMode: row.billingMode,
            metricType: row.metricType,
            quantity: row.quantity,
            unit: row.unit,
            costUsd: row.costUsd,
            requests: row.requests,
            credits: row.credits,
            limit: row.limit,
            limitWindow: row.limitWindow,
            tier: row.tier,
            confidence: row.confidence,
            windowStart: row.windowStart,
            windowEnd: row.windowEnd,
            occurredAt: row.occurredAt,
            metadata: row.metadata ?? undefined,
            createdAt: row.createdAt,
          },
        });
      }
      console.log(
        `ExternalUsageEvent: ${externalUsageEventRows.length} rows migrated.`
      );
    });

    console.log("Migration complete.");
  } catch (error) {
    console.error("Migration failed:", error);
    process.exitCode = 1;
  } finally {
    await pg.end().catch(() => {});
    await prisma.$disconnect().catch(() => {});
  }

  if (process.exitCode) {
    process.exit(process.exitCode);
  }
}

main();
