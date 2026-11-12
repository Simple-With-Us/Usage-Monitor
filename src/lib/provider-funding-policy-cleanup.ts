import "server-only";

import { prisma } from "@/lib/prisma";
import { isLlmProviderName } from "@/lib/provider-definitions";

// Durable AppSetting key that records this one-time cleanup has already run.
// Once present, clearLlmMustKeepFundedFlags never touches ProviderPlan rows
// again — the owner remains free to turn Must keep funded back on for an
// LLM/AI provider from the dashboard, and this boot-time pass must not
// silently undo that choice on a later restart.
const CLEARED_MARKER_KEY = "llm_must_keep_funded_cleared_v1";

/**
 * One-time cleanup, not a standing policy: at the time this shipped, no
 * LLM/AI provider needed ProviderPlan.mustKeepFunded set (all chat inference
 * routed through OpenRouter, so no direct LLM vendor — Anthropic, OpenAI,
 * DeepSeek, ... — was a hard production dependency). This boot-time pass
 * (same callsite as deactivateDecommissionedBuiltInProviders in
 * src/instrumentation.ts) clears any flag that predated that cleanup, then
 * records completion in AppSetting so it runs exactly once. The owner
 * remains in control of the flag afterward — PUT /api/providers/[id] and
 * POST /api/providers accept mustKeepFunded=true for any provider, and
 * nothing re-clears it once this marker exists.
 *
 * Returns the number of providers whose flag was cleared (0 on every call
 * after the first successful pass, including when the marker exists).
 */
export async function clearLlmMustKeepFundedFlags(): Promise<number> {
  const alreadyRan = await prisma.appSetting.findUnique({
    where: { key: CLEARED_MARKER_KEY },
  });
  if (alreadyRan) return 0;

  const flaggedPlans = await prisma.providerPlan.findMany({
    where: { mustKeepFunded: true },
    select: {
      providerId: true,
      provider: { select: { name: true, displayName: true } },
    },
  });
  const targets = flaggedPlans.filter((plan) =>
    isLlmProviderName(plan.provider.name)
  );

  let cleared = 0;
  for (const target of targets) {
    // Clearing the flag changes the evaluated alert set without a new
    // snapshot, so bump the provider's alert revision in the same transaction
    // (mirroring how PUT /api/providers/[id] pairs plan edits with
    // alertConfigGeneration increments).
    const clearedCount = await prisma.$transaction(async (tx) => {
      const updated = await tx.providerPlan.updateMany({
        where: { providerId: target.providerId, mustKeepFunded: true },
        data: { mustKeepFunded: false },
      });
      if (updated.count > 0) {
        await tx.provider.update({
          where: { id: target.providerId },
          data: { alertConfigGeneration: { increment: 1 } },
        });
      }
      return updated.count;
    });
    if (clearedCount === 0) continue;
    cleared += 1;
    console.info(
      `[funding-policy] cleared mustKeepFunded on LLM provider ${target.provider.name} (${target.provider.displayName}) — this was a one-time cleanup; the owner may turn it back on from the dashboard`
    );
  }

  // Record completion (even when there was nothing to clear) so this never
  // runs again and can't fight a later owner re-enable.
  await prisma.appSetting.upsert({
    where: { key: CLEARED_MARKER_KEY },
    create: { key: CLEARED_MARKER_KEY, value: String(cleared) },
    update: {},
  });

  return cleared;
}
