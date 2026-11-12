#!/usr/bin/env node
/**
 * Standalone one-time repair script to unflag mustKeepFunded on the Anthropic
 * provider plan. Run manually by the operator to clean up noisy balance
 * visibility alerts on existing installations.
 */
import { createPrismaClient } from "./lib/create-prisma-client.mjs";
import { sqliteDatabaseFileExists } from "./lib/sqlite-database-url.mjs";

const databaseUrl = process.env.DATABASE_URL ?? "";
if (databaseUrl && !sqliteDatabaseFileExists(databaseUrl)) {
  console.log("Anthropic funding repair: database does not exist yet.");
  process.exit(0);
}

const prisma = createPrismaClient();

async function run() {
  console.log("Checking Anthropic funding policy...");
  // Match case-insensitively since provider names match case-insensitively in JS
  const providers = await prisma.provider.findMany({
    select: { id: true, name: true },
  });
  
  const anthropic = providers.find((p) => p.name.toLowerCase() === "anthropic");
  if (!anthropic) {
    console.log("Anthropic provider not found.");
    return;
  }

  const plan = await prisma.providerPlan.findUnique({
    where: { providerId: anthropic.id },
  });

  if (plan?.mustKeepFunded) {
    await prisma.provider.update({
      where: { id: anthropic.id },
      data: {
        alertConfigGeneration: { increment: 1 },
        plan: { update: { mustKeepFunded: false } },
      },
    });
    console.log("Successfully set mustKeepFunded to false for Anthropic.");
  } else {
    console.log("Anthropic funding policy is already correct (mustKeepFunded = false) or plan is missing.");
  }
}

run()
  .catch((e) => {
    console.error("Failed to run Anthropic funding repair:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
