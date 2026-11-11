#!/usr/bin/env node
/**
 * Script to seed or update the Cursor ($21.32/mo) subscription.
 * Usage: node scripts/add-cursor-subscription.mjs
 */

import { createPrismaClient } from "./lib/create-prisma-client.mjs";

const prisma = createPrismaClient();

function log(message) {
  console.log(`[add-cursor-sub] ${message}`);
}

async function main() {
  const allProviders = await prisma.provider.findMany();
  let provider = allProviders.find(
    (p) => p.name.toLowerCase() === "cursor" || p.displayName.toLowerCase() === "cursor"
  );

  if (!provider) {
    log("Creating Provider row for Cursor...");
    provider = await prisma.provider.create({
      data: {
        name: "cursor",
        displayName: "Cursor",
        type: "generic",
        category: "Developer Platform",
        isActive: true,
      },
    });
  }

  const existingSub = await prisma.subscription.findFirst({
    where: { providerId: provider.id, name: "Cursor Pro" },
  });

  // Period start: 2026-07-24, Renewal: 2026-08-24
  const currentPeriodStart = new Date(Date.UTC(2026, 6, 24)); // July 24, 2026
  const nextRenewalAt = new Date(Date.UTC(2026, 7, 24)); // August 24, 2026

  if (existingSub) {
    log(`Updating existing Cursor Pro subscription (id=${existingSub.id}) to $21.32/mo...`);
    const updated = await prisma.subscription.update({
      where: { id: existingSub.id },
      data: {
        costUsd: 21.32,
        currentPeriodStart,
        nextRenewalAt,
        status: "active",
        notes: "Cursor Pro $21.32/mo recurring subscription.",
      },
    });
    log(`Updated Cursor Pro subscription: id=${updated.id}, costUsd=$${updated.costUsd}`);
  } else {
    log("Creating Cursor Pro subscription ($21.32/mo)...");
    const created = await prisma.subscription.create({
      data: {
        providerId: provider.id,
        name: "Cursor Pro",
        costUsd: 21.32,
        currency: "USD",
        interval: "monthly",
        intervalCount: 1,
        startDate: new Date(Date.UTC(2026, 5, 20)), // June 20, 2026
        currentPeriodStart,
        nextRenewalAt,
        autoRenew: true,
        status: "active",
        notes: "Cursor Pro $21.32/mo recurring subscription.",
        knobEnv: {},
      },
    });
    log(`Created Cursor Pro subscription: id=${created.id}, costUsd=$${created.costUsd}`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
