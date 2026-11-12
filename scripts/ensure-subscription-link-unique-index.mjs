#!/usr/bin/env node
/**
 * Creates the audited, data-preserving unique index used by Prisma for exact
 * provider-billing links. Startup runs this only after the SQLite backup and
 * duplicate-link audit, avoiding Prisma's generic --accept-data-loss flag.
 */
import { createPrismaClient } from "./lib/create-prisma-client.mjs";
import { sqliteDatabaseFileExists } from "./lib/sqlite-database-url.mjs";

const databaseUrl = process.env.DATABASE_URL ?? "";
if (databaseUrl && !sqliteDatabaseFileExists(databaseUrl)) {
  console.log("subscription link index: no existing database; Prisma will create it");
  process.exit(0);
}

const prisma = createPrismaClient();
try {
  const columns = await prisma.$queryRawUnsafe('PRAGMA table_info("Subscription")');
  const columnNames = new Set(columns.map((column) => String(column.name)));
  const linkSchemaExists = [
    "providerId",
    "externalBillingSource",
    "externalBillingId",
  ].every((column) => columnNames.has(column));
  if (!linkSchemaExists) {
    console.log(
      "subscription link index: link table/columns are not present yet; migration will create them"
    );
  } else {
    await prisma.$executeRawUnsafe(
      'CREATE UNIQUE INDEX IF NOT EXISTS "Subscription_providerId_externalBillingSource_externalBillingId_key" ON "Subscription"("providerId", "externalBillingSource", "externalBillingId")'
    );
    console.log("subscription link index: unique identity constraint ready");
  }
} finally {
  await prisma.$disconnect();
}
