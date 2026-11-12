import { prisma } from "@/lib/prisma";
import { sumMonthToDateExternalCostByProvider } from "@/lib/external-usage-events";
import { getProviderIntegrationProfile } from "@/lib/provider-integration-catalog";
import {
  canonicalProviderKey,
  resolveProviderIdentity,
} from "@/lib/provider-identity";
import { withInternalUsageWriteAdmission } from "@/lib/ingest-admission";

/**
 * Period-level reconciliation (DESIGN-usage-compliance-classifier §3d).
 *
 * For each active provider, compares what the apps SELF-REPORTED via pushed
 * telemetry against the provider's own AUTHORITATIVE month-to-date cost, and
 * records the delta as an auditable `ProviderUsageReconciliation` row.
 *
 * Two rules this module exists to enforce:
 *   1. A provider whose billing simply cannot be verified is labelled
 *      "unverifiable" EXPLICITLY — never skipped, so a structurally-blind
 *      provider can never read as silently reconciled/ok. That includes a
 *      provider with an authoritative cost but ZERO pushed telemetry: there is
 *      no self-reported figure to disagree with, so no delta is computed.
 *   2. Rows are UPSERTED on the (providerId, periodStart, periodEnd, keyRef)
 *      unique key, so repeated passes update one row per provider-period
 *      instead of destroying and recreating history.
 *
 * This is an audit layer ONLY. It never feeds the max() budget-spend logic in
 * budget-status.ts.
 */

const DEFAULT_ABS_TOLERANCE_USD = 0.01;
const DEFAULT_RATIO_TOLERANCE = 0.05;
const RAW_RETENTION_DAYS = 90;
const VERIFIED_SOURCE = "usage-snapshot";

/** Provider-wide rows use the "" sentinel — see the schema comment on keyRef. */
const PROVIDER_WIDE_KEY_REF = "";

export interface ProviderUsageReconciliationResult {
  examined: number;
  reconciled: number;
  discrepancies: number;
  unverifiable: number;
  pending: number;
  /** Kept for the maintenance summary. */
  reconciledCount: number;
}

function resolveTolerance(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Month bounds are computed as STABLE UTC instants. periodEnd must not be
 * "now": the unique key includes it, so a moving end would address a different
 * row every pass and defeat the upsert entirely.
 */
export function monthBounds(now: Date): { periodStart: Date; periodEnd: Date } {
  const periodStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  );
  const periodEnd = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)
  );
  return { periodStart, periodEnd };
}

export function isReconcilableVisibility(visibility: string): boolean {
  return visibility === "actual" || visibility === "partial";
}

export function reconciliationStatus(
  reportedCostUsd: number,
  verifiedCostUsd: number,
  absTolerance: number,
  ratioTolerance: number
): "ok" | "discrepancy" {
  const allowed = Math.max(
    absTolerance,
    Math.abs(verifiedCostUsd) * ratioTolerance
  );
  return Math.abs(verifiedCostUsd - reportedCostUsd) <= allowed
    ? "ok"
    : "discrepancy";
}

/**
 * Variable (usage) portion of a snapshot totalCost for reconciliation (Wave E / E12).
 * Pushed telemetry is usage-only; comparing it to a snapshot that still includes
 * plan fixed fees is apples-to-oranges and invents false discrepancies.
 */
export function snapshotVariableCostUsd(
  snapshotTotalCostUsd: number,
  fixedMonthlyCostUsd: number | null | undefined
): number {
  const fixed =
    fixedMonthlyCostUsd != null &&
    Number.isFinite(fixedMonthlyCostUsd) &&
    fixedMonthlyCostUsd > 0
      ? fixedMonthlyCostUsd
      : 0;
  return Math.max(0, snapshotTotalCostUsd - fixed);
}

export async function reconcileProviderUsage(
  now: Date = new Date()
): Promise<ProviderUsageReconciliationResult> {
  const { periodStart, periodEnd } = monthBounds(now);
  const rawCutoff = new Date(
    now.getTime() - RAW_RETENTION_DAYS * 24 * 60 * 60 * 1000
  );
  const absTolerance = resolveTolerance(
    "USAGE_RECONCILIATION_ABS_TOLERANCE_USD",
    DEFAULT_ABS_TOLERANCE_USD
  );
  const ratioTolerance = resolveTolerance(
    "USAGE_RECONCILIATION_RATIO_TOLERANCE",
    DEFAULT_RATIO_TOLERANCE
  );

  // ONE aggregation call per pass. This helper is on budget-status's hot path
  // (~336k-row groupBy) — the boot-OOM incident came from running two of these
  // concurrently, so it must never be called per-provider inside the loop.
  const [providers, pushedCosts] = await Promise.all([
    prisma.provider.findMany({
      where: { isActive: true },
      select: {
        id: true,
        name: true,
        type: true,
        plan: { select: { fixedMonthlyCostUsd: true } },
        snapshots: {
          where: {
            fetchedAt: { gte: periodStart },
            totalCost: { not: null },
            costScope: "calendar_month_to_date",
          },
          orderBy: { fetchedAt: "desc" },
          take: 1,
          select: { totalCost: true },
        },
      },
    }),
    sumMonthToDateExternalCostByProvider(periodStart, rawCutoff, now),
  ]);

  // Index the pushed-cost map by canonical provider key so alias spellings
  // (e.g. google_ai vs google-ai) reconcile against the same bucket.
  const pushedByCanonicalKey = new Map<
    string,
    { usagePushed: number; eventCount: number; pricedEventCount: number }
  >();
  for (const [name, cost] of pushedCosts.entries()) {
    const key = canonicalProviderKey(name);
    const existing = pushedByCanonicalKey.get(key);
    const eventCount =
      cost.pricedEventCount +
      cost.unpricedEventCount +
      cost.unclassifiedCostEventCount;
    if (existing) {
      existing.usagePushed += cost.usagePushed;
      existing.eventCount += eventCount;
      existing.pricedEventCount += cost.pricedEventCount;
    } else {
      pushedByCanonicalKey.set(key, {
        usagePushed: cost.usagePushed,
        eventCount,
        pricedEventCount: cost.pricedEventCount,
      });
    }
  }

  let reconciled = 0;
  let discrepancies = 0;
  let unverifiable = 0;
  let pending = 0;

  // A pushed-cost bucket is canonical-key scoped, but several ACTIVE Provider
  // rows can share one canonical key (Provider.name has no unique constraint;
  // alias spellings collapse too). Attributing the whole bucket to each row
  // would report the same pushed dollars N times and manufacture false
  // discrepancies on a perfectly reconciled month. Attributing to one owner
  // row while siblings are recorded as unverifiable still generates a false
  // discrepancy for a genuine split. Therefore, every row in a multi-row key
  // is marked unverifiable.
  // Keyed off the PROVIDER ROWS, not the pushed buckets: two same-key rows are
  // ambiguous whether or not any telemetry has been pushed yet, and a bucket
  // that arrives later must not suddenly be double-counted.
  const rowsByCanonicalKey = new Map<string, string[]>();
  for (const provider of providers) {
    const key = canonicalProviderKey(provider.name);
    const bucket = rowsByCanonicalKey.get(key);
    if (bucket) bucket.push(provider.id);
    else rowsByCanonicalKey.set(key, [provider.id]);
  }
  const ownerIdByCanonicalKey = new Map<string, string>();
  for (const [key, ids] of rowsByCanonicalKey.entries()) {
    if (ids.length === 1) {
      ownerIdByCanonicalKey.set(key, ids[0]);
    }
    // If ids.length > 1, no owner is set (remains undefined). Thus, all rows
    // for this key will have ambiguous attribution.
  }

  for (const provider of providers) {
    const canonicalKey = canonicalProviderKey(provider.name);
    const ownerId = ownerIdByCanonicalKey.get(canonicalKey);
    // If no single owner could be resolved, or this provider isn't the owner,
    // the attribution is ambiguous and its pushed slice cannot be separated.
    const ambiguousAttribution = ownerId == null || ownerId !== provider.id;
    const pushed =
      ambiguousAttribution
        ? { usagePushed: 0, eventCount: 0, pricedEventCount: 0 }
        : pushedByCanonicalKey.get(canonicalKey) ?? {
            usagePushed: 0,
            eventCount: 0,
            pricedEventCount: 0,
          };
    const reportedCostUsd = pushed.usagePushed;
    const reportedEventCount = pushed.eventCount;
    // Only PRICED events (a real, even $0.00, costUsd) are a self-reported
    // dollar figure worth comparing against the provider's own bill. An
    // unpriced/unclassified event (e.g. a producer pushing an activity ping
    // with costUsd: null because it tracks call volume, not spend) is not a
    // cost claim at all, so it must not count toward "telemetry exists" below.
    const reportedPricedEventCount = pushed.pricedEventCount;

    const visibility = getProviderIntegrationProfile(
      provider.name,
      provider.type
    ).billing.visibility;
    const snapshotTotal = provider.snapshots[0]?.totalCost ?? null;
    // Compare usage-pushed to the variable portion of the snapshot only (E12).
    const snapshotCost =
      snapshotTotal == null
        ? null
        : snapshotVariableCostUsd(
            snapshotTotal,
            provider.plan?.fixedMonthlyCostUsd
          );

    let status: string;
    let verifiedCostUsd: number | null = null;
    let deltaUsd: number | null = null;
    let deltaRatio: number | null = null;

    if (ambiguousAttribution) {
      // Explicit, never a silent skip and never a computed delta.
      status = "unverifiable";
      unverifiable += 1;
    } else if (!isReconcilableVisibility(visibility)) {
      // metadata | manual | none — structurally not verifiable. Recorded
      // EXPLICITLY so the dashboard can say "unverifiable" instead of implying
      // this provider was checked and found fine.
      status = "unverifiable";
      unverifiable += 1;
    } else if (snapshotCost == null) {
      // Verifiable in principle, but no authoritative month-to-date cost has
      // been polled yet this period.
      status = "pending";
      pending += 1;
    } else if (reportedPricedEventCount === 0) {
      // The provider's own bill is in hand, but nothing pushed a PRICED usage
      // event for it this period, so there is no self-reported dollar figure
      // to compare it against. Computing a delta here subtracts from ZERO and
      // reports the ENTIRE bill as a "discrepancy" — which is how a $0.71
      // Twilio month became a PagerDuty incident that no tolerance could ever
      // absorb (only a 100% ratio tolerance would, and that disables the check
      // for every provider). A provider with no telemetry source is not in
      // disagreement with itself; it is simply unverified, and saying so is
      // the honest answer. Ordered after the snapshot branch so "pending"
      // keeps its narrower meaning: waiting on the poll, not missing the
      // telemetry side.
      //
      // This is deliberately keyed on PRICED events, not raw event count
      // (reportedEventCount, kept on the row for display/debugging only): PD
      // #104/#105 was the same bug wearing a second costume. Congress.Trade
      // pushes Stripe "usage" pings with costUsd: null (it tracks call volume,
      // not spend), so reportedEventCount was 2 while reportedCostUsd stayed
      // $0 — the old zero-EVENT-COUNT guard missed it, subtracted the real
      // $0.45 bill from zero, and paged forever with no tolerance able to
      // absorb it. A null-cost event is not a cost claim, so it must not count
      // as "telemetry exists" any more than no event at all would. Gating on
      // reportedPricedEventCount instead catches this shape without reopening
      // the fixed Twilio case (its reportedPricedEventCount is also 0).
      //
      // Nothing here alerts — provider-alerts raises
      // usage_reconciliation_discrepancy only on status === "discrepancy" — and
      // because the counts are recomputed from live data every pass, a
      // provider that LATER starts pushing priced telemetry falls straight
      // through to normal reconciliation on the next run. The row is upserted
      // in place, so no manual reset or backfill is involved.
      status = "unverifiable";
      unverifiable += 1;
    } else {
      verifiedCostUsd = snapshotCost;
      deltaUsd = snapshotCost - reportedCostUsd;
      deltaRatio =
        reportedCostUsd !== 0 ? deltaUsd / reportedCostUsd : null;
      status = reconciliationStatus(
        reportedCostUsd,
        snapshotCost,
        absTolerance,
        ratioTolerance
      );
      if (status === "discrepancy") discrepancies += 1;
      reconciled += 1;
    }

    const row = {
      reportedCostUsd,
      reportedEventCount,
      verifiedCostUsd,
      verifiedSource: verifiedCostUsd == null ? null : VERIFIED_SOURCE,
      deltaUsd,
      deltaRatio,
      status,
      checkedAt: now,
    };

    await withInternalUsageWriteAdmission(async () => {
      await prisma.providerUsageReconciliation.upsert({
        where: {
          providerId_periodStart_periodEnd_keyRef: {
            providerId: provider.id,
            periodStart,
            periodEnd,
            keyRef: PROVIDER_WIDE_KEY_REF,
          },
        },
        create: {
          providerId: provider.id,
          periodStart,
          periodEnd,
          keyRef: PROVIDER_WIDE_KEY_REF,
          ...row,
        },
        update: row,
      });
    });
  }

  return {
    examined: providers.length,
    reconciled,
    discrepancies,
    unverifiable,
    pending,
    reconciledCount: reconciled + unverifiable + pending,
  };
}
