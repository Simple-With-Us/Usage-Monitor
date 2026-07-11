#!/usr/bin/env node

/**
 * Reconstruct deltas from historical Claude Code cumulative COST samples that
 * older receiver versions persisted as additive rows. Other Claude counters
 * are intentionally out of scope for production safety.
 *
 * Dry-run (default):
 *   node scripts/repair-claude-cumulative-cost.mjs
 * Apply only after a verified DB backup, while the app scheduler is stopped:
 *   node scripts/repair-claude-cumulative-cost.mjs --apply --backup-acknowledged
 */
import { PrismaClient } from "@prisma/client";
import {
  applyClaudeCumulativeCostRepair,
  planClaudeCumulativeCostRepair,
} from "./lib/claude-cost-repair.mjs";

const allowed = new Set(["--apply", "--backup-acknowledged"]);
const args = new Set(process.argv.slice(2));
for (const arg of args) {
  if (!allowed.has(arg)) throw new Error(`Unknown argument: ${arg}`);
}
const apply = args.has("--apply");
const backupAcknowledged = args.has("--backup-acknowledged");
if (!apply && backupAcknowledged) {
  throw new Error("--backup-acknowledged is only valid with --apply");
}
if (apply && !backupAcknowledged) {
  throw new Error("--apply requires --backup-acknowledged after verifying a current DB backup");
}

const prisma = new PrismaClient();
try {
  const plan = await planClaudeCumulativeCostRepair(prisma);
  console.log(JSON.stringify({ ...plan.report, mode: apply ? "apply" : "dry-run" }, null, 2));
  if (apply && plan.repairs.length > 0) {
    const result = await prisma.$transaction(
      (tx) => applyClaudeCumulativeCostRepair(tx, plan),
      { timeout: 300_000 }
    );
    console.log(JSON.stringify(result));
  }
} finally {
  await prisma.$disconnect();
}
