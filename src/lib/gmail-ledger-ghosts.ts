import { prisma } from "@/lib/prisma";
import { retractSubscriptionChargesInTransaction } from "@/lib/subscription-materializer";

/**
 * One-time repair for the 2026-08-12 seed that created active catalog rows
 * and let the materializer invent August cash.  Gmail shows those terms were
 * not paid this month.  After notes change, later ticks are no-ops so an
 * owner can later activate a real paid term.
 */
const GHOSTS = [
  {
    providerName: "massive",
    name: "Stocks Starter",
    notes: "annual available $288/yr",
    nextName: "Stocks Starter",
    nextCostUsd: 29,
    nextNotes:
      "Paused 2026-08-21: Gmail Stripe $29 renewals failed in July; no August receipt.  Not paid this month.",
  },
  {
    providerName: "fmp",
    name: "Starter",
    notes: "billed annually $264/yr",
    nextName: "Starter",
    nextCostUsd: 29,
    nextNotes:
      "Paused 2026-08-21: Gmail last paid receipt #2240-0152 on 2026-06-22; July $31.90 failed and API was suspended 2026-07-27.  Not paid this month.",
  },
  {
    providerName: "anthropic",
    name: "Claude Max / Team",
    notes: "Active Claude Pro subscription ($20/mo)",
    nextName: "Claude Pro",
    nextCostUsd: 20,
    nextNotes:
      "Paused 2026-08-21: Gmail has Pro $21.32 and Max upgrades on 2026-07-02/03, then Max canceled (access ended 2026-08-03).  No August Anthropic receipt in Gmail.",
  },
  {
    providerName: "kimi",
    name: "Kimi VIP",
    notes: "Active Kimi / Moonshot AI VIP subscription ($15/mo)",
    nextName: "Kimi Apple IAP",
    nextCostUsd: 199,
    nextNotes:
      "Paused 2026-08-21: owner email 2026-08-11 says $199 Apple IAP.  Seeded $15/$200 August charge was not a receipt.  Apple receipt is on iCloud.",
  },
] as const;

export async function pauseGmailUnverifiedSeedSubscriptions(): Promise<{
  paused: number;
  retracted: number;
}> {
  const providers = await prisma.provider.findMany({
    select: { id: true, name: true },
  });
  const providerIdByName = new Map(
    providers.map((provider) => [provider.name.toLowerCase(), provider.id])
  );

  let paused = 0;
  let retracted = 0;
  for (const ghost of GHOSTS) {
    const providerId = providerIdByName.get(ghost.providerName);
    if (!providerId) continue;
    const rows = await prisma.subscription.findMany({
      where: {
        providerId,
        name: ghost.name,
        status: "active",
        notes: ghost.notes,
      },
      select: { id: true },
    });
    for (const row of rows) {
      const result = await prisma.$transaction(async (tx) => {
        const retractedCharges = await retractSubscriptionChargesInTransaction(
          tx,
          row.id,
          // Pre-#1307 seed rows were stamped `actual`.  This repair must
          // still delete those invented charges.  Pause / delete keep
          // receipt-backed Cloudflare rows.
          { includeReceiptBacked: true }
        );
        await tx.subscription.update({
          where: { id: row.id },
          data: {
            status: "considering",
            autoRenew: false,
            lastChargedPeriodStart: null,
            name: ghost.nextName,
            costUsd: ghost.nextCostUsd,
            notes: ghost.nextNotes,
          },
        });
        return retractedCharges.deleted;
      });
      paused += 1;
      retracted += result;
    }
  }
  return { paused, retracted };
}
