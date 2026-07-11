#!/usr/bin/env node
/**
 * Read-only audit for legacy Subscription rows whose numeric `costUsd` could
 * be mislabeled with a non-USD currency. Budget and materialization math does
 * not perform FX conversion, so this script reports evidence only and never
 * guesses a conversion or mutates data.
 *
 * Usage:
 *   npm run audit:subscription-currency
 *   npm run audit:subscription-currency -- --json
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const jsonOutput = process.argv.includes("--json");

async function main() {
  const subscriptions = await prisma.subscription.findMany({
    select: {
      id: true,
      name: true,
      currency: true,
      costUsd: true,
      status: true,
      provider: { select: { id: true, name: true, displayName: true } },
    },
    orderBy: [{ currency: "asc" }, { providerId: "asc" }, { name: "asc" }],
  });

  const findings = subscriptions
    .filter((subscription) => subscription.currency.trim().toUpperCase() !== "USD")
    .map((subscription) => ({
      subscriptionId: subscription.id,
      subscriptionName: subscription.name,
      providerId: subscription.provider.id,
      providerName: subscription.provider.name,
      providerDisplayName: subscription.provider.displayName,
      currency: subscription.currency,
      costUsd: subscription.costUsd,
      status: subscription.status,
    }));

  if (jsonOutput) {
    console.log(JSON.stringify({ readOnly: true, count: findings.length, findings }, null, 2));
    return;
  }

  console.log("[subscription-currency-audit] READ ONLY — no rows will be changed.");
  console.log(`[subscription-currency-audit] Non-USD rows: ${findings.length}`);
  if (findings.length > 0) console.table(findings);
}

main()
  .catch((error) => {
    console.error("[subscription-currency-audit] Failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
