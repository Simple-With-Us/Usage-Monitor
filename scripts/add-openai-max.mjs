#!/usr/bin/env node
/**
 * Adds an OpenAI ChatGPT Max subscription to the database.
 * Run this from Render's Shell tab for the deployed `api-usage-monitor` web service:
 * 
 *   node scripts/add-openai-max.mjs
 */

import { createPrismaClient } from "./lib/create-prisma-client.mjs";

const prisma = createPrismaClient();

function log(message) {
  console.log(`[add-openai-max] ${message}`);
}

async function addOpenAiMaxSubscription() {
  const provider = await prisma.provider.findFirst({
    where: { name: "openai" },
  });

  if (!provider) {
    log("OpenAI provider not found! Please ensure it is synced.");
    return;
  }

  const existing = await prisma.subscription.findFirst({
    where: { providerId: provider.id, name: "ChatGPT Max" },
  });

  if (existing) {
    log(`Subscription "ChatGPT Max" already exists (id=${existing.id}). Skipping.`);
    return;
  }

  const now = new Date();
  
  // The user stated they got it exactly a month ago (June 22, 2026, assuming today is July 22, 2026)
  // We'll set the startDate to one month ago.
  const startDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, now.getUTCDate()));
  
  const currentPeriodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  
  const nextMonth = now.getUTCMonth() + 1;
  const nextRenewalAt = new Date(Date.UTC(now.getUTCFullYear(), nextMonth, now.getUTCDate()));

  log(`Creating subscription "ChatGPT Max" ($200/mo)...`);
  
  const subscription = await prisma.subscription.create({
    data: {
      providerId: provider.id,
      name: "ChatGPT Max",
      costUsd: 200,
      currency: "USD",
      interval: "monthly",
      intervalCount: 1,
      startDate: startDate,
      currentPeriodStart: currentPeriodStart,
      nextRenewalAt: nextRenewalAt,
      autoRenew: true,
      status: "active",
      notes: "ChatGPT Max $200/mo subscription. Manual import.",
      knobEnv: {},
    },
  });

  log(`Successfully created subscription: ${subscription.id}`);
}

async function main() {
  log("Starting...");
  await addOpenAiMaxSubscription();
  log("Done.");
}

main()
  .catch((error) => {
    console.error("[add-openai-max] FAILED:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
