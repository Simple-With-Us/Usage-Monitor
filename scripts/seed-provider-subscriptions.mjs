#!/usr/bin/env node

/**
 * Dry-run-first CLI for the immutable provider/subscription release plan.
 *
 * Preflight only (default; zero writes):
 *   node scripts/seed-provider-subscriptions.mjs
 *
 * Apply the one exact plan. Business writes and the durable receipt commit in
 * one transaction, with the receipt inserted only after postconditions pass:
 *   node scripts/seed-provider-subscriptions.mjs \
 *     --apply --plan-id provider-subscriptions-2026-07-10-v1
 */

import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import {
  PROVIDER_SUBSCRIPTION_PLAN_ID,
  ReleasePlanConflictError,
  runProviderSubscriptionReleasePlan,
} from "./provider-subscription-release-plan.mjs";

function parseArgs(argv) {
  const options = { apply: false, json: false, planId: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--plan-id") {
      options.planId = argv[index + 1] ?? null;
      index += 1;
    } else if (arg === "--help") {
      console.log(
        `Usage: node scripts/seed-provider-subscriptions.mjs [--json] [--apply --plan-id ${PROVIDER_SUBSCRIPTION_PLAN_ID}]`
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (options.apply && options.planId !== PROVIDER_SUBSCRIPTION_PLAN_ID) {
    throw new Error(
      `--apply requires --plan-id ${PROVIDER_SUBSCRIPTION_PLAN_ID}`
    );
  }
  if (
    options.planId != null &&
    options.planId !== PROVIDER_SUBSCRIPTION_PLAN_ID
  ) {
    throw new Error(`Unknown release-maintenance plan: ${options.planId}`);
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const prisma = new PrismaClient();
  try {
    const result = await runProviderSubscriptionReleasePlan({
      prisma,
      apply: options.apply,
    });
    const output = {
      mode: options.apply ? "apply" : "dry-run",
      applied: result.applied,
      alreadyCompleted: result.alreadyCompleted,
      ...result.report,
      ...(result.receipt ? { receipt: result.receipt } : {}),
    };
    console.log(JSON.stringify(output, null, options.json ? 2 : 2));
    return output;
  } catch (error) {
    if (error instanceof ReleasePlanConflictError && error.conflicts.length) {
      for (const conflict of error.conflicts) {
        console.error(`[seed-provider-subscriptions] CONFLICT: ${conflict}`);
      }
    }
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(
      `[seed-provider-subscriptions] ERROR: ${
        error instanceof Error ? error.message : "unknown failure"
      }`
    );
    process.exitCode = 1;
  });
}
