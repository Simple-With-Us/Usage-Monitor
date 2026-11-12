import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { parseNumber } from "@/lib/adapters/helpers";

const MAX_SNAPSHOTS_PER_PASS = 100;

type LegacyMistralSnapshotCandidate = {
  totalCost: number | null;
  fixedCostIncludedUsd: number | null;
  costWindowStart: Date | null;
  costWindowEnd: Date | null;
  costScope: string | null;
  costIncludesUnknownFixed: boolean;
  rawData: Prisma.JsonValue | null;
};

export interface MistralSnapshotQuarantineResult {
  examined: number;
  quarantined: number;
  externalBillingExamined: number;
  externalBillingQuarantined: number;
  truncated: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function sameInstant(left: Date | null, right: unknown): boolean {
  return (
    left != null &&
    typeof right === "string" &&
    Number.isFinite(Date.parse(right)) &&
    left.getTime() === Date.parse(right)
  );
}

/**
 * Matches only snapshots produced by the retired Mistral adapter path that
 * copied `/spend-limit`'s `completion.total_usage` (or fallback `usage`) into
 * `UsageSnapshot.totalCost`. This deliberately reconstructs every relevant
 * branch of that old implementation; arbitrary Mistral costs are not caught.
 */
export function isLegacyMistralSpendLimitCostSnapshot(
  snapshot: LegacyMistralSnapshotCandidate
): boolean {
  if (
    snapshot.totalCost == null ||
    snapshot.fixedCostIncludedUsd != null ||
    snapshot.costScope !== "calendar_month_to_date" ||
    snapshot.costIncludesUnknownFixed
  ) {
    return false;
  }

  const raw = asRecord(snapshot.rawData);
  const usage = asRecord(raw?.usage);
  const spendLimit = asRecord(raw?.spendLimit);
  const limits = asRecord(spendLimit?.limits);
  const completion = asRecord(limits?.completion);
  const capabilities = asRecord(raw?.capabilities);
  if (
    capabilities?.actualCost !== true ||
    typeof usage?.currency !== "string" ||
    usage.currency.trim().toUpperCase() !== "USD" ||
    !sameInstant(snapshot.costWindowStart, usage.start_date) ||
    !sameInstant(snapshot.costWindowEnd, usage.end_date)
  ) {
    return false;
  }

  // Exact old precedence: total_usage first, usage only when total_usage is
  // absent/unparseable. No tolerance or alternate field is accepted.
  const legacyReportedCost =
    parseNumber(completion?.total_usage) ?? parseNumber(completion?.usage);
  return legacyReportedCost != null && legacyReportedCost === snapshot.totalCost;
}

/**
 * Bounded and idempotent runtime correction. It runs independently of the
 * provider poll result, so a current 401 cannot preserve known-false cash.
 * Rows are retained for audit; only the false canonical money fields are
 * cleared. At most 100 snapshots are examined per maintenance pass.
 */
export async function quarantineLegacyMistralSpendLimitSnapshots(): Promise<MistralSnapshotQuarantineResult> {
  return prisma.$transaction(async (tx) => {
    const candidates = await tx.usageSnapshot.findMany({
      where: {
        provider: { is: { name: "mistral", type: "builtin" } },
        totalCost: { not: null },
        rawData: { not: Prisma.DbNull },
      },
      orderBy: [{ fetchedAt: "asc" }, { id: "asc" }],
      take: MAX_SNAPSHOTS_PER_PASS + 1,
      select: {
        id: true,
        totalCost: true,
        fixedCostIncludedUsd: true,
        costWindowStart: true,
        costWindowEnd: true,
        costScope: true,
        costIncludesUnknownFixed: true,
        rawData: true,
      },
    });
    const examined = candidates.slice(0, MAX_SNAPSHOTS_PER_PASS);
    const ids = examined
      .filter(isLegacyMistralSpendLimitCostSnapshot)
      .map((snapshot) => snapshot.id);
    const update = ids.length > 0
      ? await tx.usageSnapshot.updateMany({
          where: { id: { in: ids }, totalCost: { not: null } },
          data: {
            balance: null,
            totalCost: null,
            fixedCostIncludedUsd: null,
            costWindowStart: null,
            costWindowEnd: null,
            costScope: "unknown",
            costIncludesUnknownFixed: false,
            credits: null,
          },
        })
      : { count: 0 };

    // The retired adapter also copied the same false amount into a stable
    // ProviderExternalBilling row. A current Admin-key 401 produces no new
    // reconciliation record, so correct that exact legacy identity here too.
    // New rows have rollupRole="canonical" and a different planName; requiring
    // every old discriminator prevents a broad Mistral billing rewrite.
    const externalCandidates = await tx.providerExternalBilling.findMany({
      where: {
        provider: { is: { name: "mistral", type: "builtin" } },
        source: "mistral-usage-billing",
        kind: "billing_period",
        planName: "Mistral organization usage",
        currency: "USD",
        amountUsd: { not: null },
        rollupRole: null,
        currentPeriodStart: { not: null },
        currentPeriodEnd: { not: null },
      },
      orderBy: [{ syncedAt: "asc" }, { id: "asc" }],
      take: MAX_SNAPSHOTS_PER_PASS + 1,
      select: {
        id: true,
        externalId: true,
        currentPeriodStart: true,
        currentPeriodEnd: true,
      },
    });
    const examinedExternalBilling = externalCandidates.slice(
      0,
      MAX_SNAPSHOTS_PER_PASS
    );
    const externalIds = examinedExternalBilling
      .filter((record) => {
        const start = record.currentPeriodStart;
        const end = record.currentPeriodEnd;
        return (
          start != null &&
          end != null &&
          end > start &&
          record.externalId === start.toISOString().slice(0, 7)
        );
      })
      .map((record) => record.id);
    const externalUpdate = externalIds.length > 0
      ? await tx.providerExternalBilling.updateMany({
          where: {
            id: { in: externalIds },
            amountUsd: { not: null },
            rollupRole: null,
          },
          data: {
            amountUsd: null,
            status: "cost_unavailable",
            rollupRole: "canonical",
            dateKind: "report_through",
          },
        })
      : { count: 0 };

    return {
      examined: examined.length,
      quarantined: update.count,
      externalBillingExamined: examinedExternalBilling.length,
      externalBillingQuarantined: externalUpdate.count,
      truncated:
        candidates.length > MAX_SNAPSHOTS_PER_PASS ||
        externalCandidates.length > MAX_SNAPSHOTS_PER_PASS,
    };
  });
}
