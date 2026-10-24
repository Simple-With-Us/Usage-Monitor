#!/usr/bin/env node
/**
 * Read-only startup/deploy preflight for the one-local-charge-per-provider-
 * billing-identity invariant. It prints identities and counts, never costs,
 * notes, credentials, or provider configuration.
 */
import { existsSync } from "node:fs";
import { createPrismaClient } from "./lib/create-prisma-client.mjs";

const databaseUrl = process.env.DATABASE_URL ?? "";
const sqlitePath = databaseUrl.match(/^file:(.+)$/)?.[1];
if (sqlitePath && !existsSync(sqlitePath)) {
  console.log("subscription link audit: no existing database; nothing to audit");
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
      "subscription link audit: link table/columns are not present yet; migration will create them"
    );
  } else {
    const links = await prisma.subscription.findMany({
      where: {
        externalBillingSource: { not: null },
        externalBillingId: { not: null },
      },
      select: {
        providerId: true,
        externalBillingSource: true,
        externalBillingId: true,
      },
    });
    const counts = new Map();
    for (const link of links) {
      const key = JSON.stringify([
        link.providerId,
        link.externalBillingSource,
        link.externalBillingId,
      ]);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const duplicates = [...counts.entries()]
      .filter(([, count]) => count > 1)
      .sort(([left], [right]) => left.localeCompare(right));
    if (duplicates.length === 0) {
      console.log(`subscription link audit: ${links.length} linked row(s), no duplicate identities`);
    } else {
      console.error(
        `subscription link audit: ${duplicates.length} duplicate provider billing identity group(s) found`
      );
      for (const [key, count] of duplicates) {
        const [providerId, source, externalId] = JSON.parse(key);
        console.error(
          `duplicate link: provider=${providerId} source=${source} externalId=${externalId} rows=${count}`
        );
      }
      console.error(
        "Resolve duplicate local links after verifying a SQLite backup; one external identity cannot dedupe multiple materialized charges."
      );
      process.exitCode = 1;
    }
  }
} finally {
  await prisma.$disconnect();
}
