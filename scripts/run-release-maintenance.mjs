#!/usr/bin/env node

/**
 * Exact-plan startup release-maintenance orchestrator.
 *
 * RELEASE_MAINTENANCE_PLAN_ID unset/blank is a no-op. A non-empty unknown ID
 * fails closed. The registry is intentionally explicit so future maintenance
 * steps can be integrated without creating a generic "run pending work" path.
 */

import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import {
  PROVIDER_SUBSCRIPTION_PLAN_HASH,
  PROVIDER_SUBSCRIPTION_PLAN_ID,
  runProviderSubscriptionReleasePlan,
} from "./provider-subscription-release-plan.mjs";

const PLAN_REGISTRY = new Map([
  [
    PROVIDER_SUBSCRIPTION_PLAN_ID,
    {
      planHash: PROVIDER_SUBSCRIPTION_PLAN_HASH,
      run: runProviderSubscriptionReleasePlan,
    },
  ],
]);

export function resolveRequestedPlan(raw = process.env.RELEASE_MAINTENANCE_PLAN_ID) {
  const planId = raw?.trim() ?? "";
  if (!planId) return null;
  const entry = PLAN_REGISTRY.get(planId);
  if (!entry) {
    throw new Error(`Unknown RELEASE_MAINTENANCE_PLAN_ID: ${planId}`);
  }
  return { planId, ...entry };
}

export async function main(argv = process.argv.slice(2)) {
  const unknownArgs = argv.filter((arg) => arg !== "--validate-config");
  if (unknownArgs.length > 0) {
    throw new Error(`Unknown argument: ${unknownArgs[0]}`);
  }
  const validateOnly = argv.includes("--validate-config");
  const selected = resolveRequestedPlan();
  if (!selected) {
    console.log("[release-maintenance] no exact plan selected; no-op");
    return { status: "no_plan" };
  }
  if (validateOnly) {
    console.log(
      `[release-maintenance] validated plan ${selected.planId} (${selected.planHash})`
    );
    return { status: "validated", ...selected };
  }

  const prisma = new PrismaClient();
  try {
    const result = await selected.run({ prisma, apply: true });
    console.log(
      result.alreadyCompleted
        ? `[release-maintenance] receipt already exists for ${selected.planId}; no-op`
        : `[release-maintenance] completed ${selected.planId} (${selected.planHash})`
    );
    return {
      status: result.alreadyCompleted ? "already_completed" : "completed",
      planId: selected.planId,
      planHash: selected.planHash,
      receipt: result.receipt,
    };
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(
      `[release-maintenance] ERROR: ${
        error instanceof Error ? error.message : "unknown failure"
      }`
    );
    process.exitCode = 1;
  });
}
