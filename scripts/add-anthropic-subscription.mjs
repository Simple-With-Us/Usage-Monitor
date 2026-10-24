#!/usr/bin/env node
/**
 * Adds an Anthropic Pro subscription to the database.
 * Run this from Render's Shell tab for the deployed `api-usage-monitor` web service:
 * 
 *   node scripts/add-anthropic-subscription.mjs
 */

import { createPrismaClient } from "./lib/create-prisma-client.mjs";

const prisma = createPrismaClient();

function log(message) {
  console.log(`[add-anthropic-sub] ${message}`);
}

async function addAnthropicSubscription() {
  const provider = await prisma.provider.findFirst({
    where: { name: "anthropic" },
  });

  if (!provider) {
    log("Anthropic provider not found! Please ensure it is synced.");
    return;
  }

  const existing = await prisma.subscription.findFirst({
    where: { providerId: provider.id, name: "Claude Pro" },
  });

  if (existing) {
    log(`Subscription "Claude Pro" already exists (id=${existing.id}). Skipping.`);
    return;
  }

  const now = new Date();
  
  // Assuming start date one month ago
  const startDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, now.getUTCDate()));
  const currentPeriodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const nextMonth = now.getUTCMonth() + 1;
  const nextRenewalAt = new Date(Date.UTC(now.getUTCFullYear(), nextMonth, now.getUTCDate()));

  log(`Creating subscription "Claude Pro" ($20/mo)...`);
  
  const subscription = await prisma.subscription.create({
    data: {
      providerId: provider.id,
      name: "Claude Pro",
      costUsd: 20,
      currency: "USD",
      interval: "monthly",
      intervalCount: 1,
      startDate: startDate,
      currentPeriodStart: currentPeriodStart,
      nextRenewalAt: nextRenewalAt,
      autoRenew: true,
      status: "active",
      notes: "Claude Pro $20/mo subscription. Manual import.",
      knobEnv: {},
    },
  });

  log(`Successfully created subscription: ${subscription.id}`);
}

async function main() {
  log("Starting...");
  await addAnthropicSubscription();
  log("Done.");
}

main()
  .catch((error) => {
    console.error("[add-anthropic-sub] FAILED:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
