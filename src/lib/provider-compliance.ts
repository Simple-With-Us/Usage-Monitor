import { prisma } from "@/lib/prisma";
import { getProviderIntegrationProfile } from "@/lib/provider-integration-catalog";
import { monthBounds } from "@/lib/provider-usage-reconciliation";

/**
 * Read-only compliance summary for one provider (DESIGN §3f).
 *
 * Surfaces the audit layer built in §3c/§3d so drift is visible instead of
 * merely recorded: how much of this provider's pushed telemetry was actually
 * verified against the provider's own numbers, how much money the two sides
 * disagree about, and — crucially — an explicit "unverifiable" state for
 * providers whose billing simply cannot be checked.
 *
 * This is display-only. It never feeds budgets, alerts, or the max() spend
 * logic; it reports what the audit layer already persisted.
 */

export type ComplianceState =
  | "verified"
  | "discrepancy"
  | "partial"
  | "pending"
  | "unverifiable";

export interface ProviderComplianceSummary {
  /** Overall badge state for this provider. */
  state: ComplianceState;
  /**
   * Share of generation-id-carrying events that reached a settled verification
   * (match or discrepancy), 0..1. Null when nothing is verifiable at all.
   */
  verifiedCoverage: number | null;
  verifiableEventCount: number;
  verifiedEventCount: number;
  matchedEventCount: number;
  discrepancyEventCount: number;
  pendingEventCount: number;
  /** Events whose retry budget was exhausted or that carry no verifiable source. */
  unverifiableEventCount: number;
  /** Signed provider-verified minus self-reported, for the current period. */
  periodDeltaUsd: number | null;
  periodReportedCostUsd: number | null;
  periodVerifiedCostUsd: number | null;
  periodStatus: string | null;
  /** Why this provider cannot be verified, when that is the case. */
  unverifiableReason: string | null;
  checkedAt: Date | null;
}

const UNVERIFIABLE_REASONS: Record<string, string> = {
  metadata:
    "This provider exposes usage metadata only — it publishes no authoritative cash total to reconcile against.",
  manual:
    "This provider has no billing API; its cost is entered manually, so there is nothing to verify automatically.",
  none: "This provider exposes no billing surface at all.",
};

export function isVerifiableVisibility(visibility: string): boolean {
  return visibility === "actual" || visibility === "partial";
}

/**
 * Share of permanently-failed events above which a provider may no longer be
 * called "Verified". Event-level "unverifiable" is written ONLY by the
 * verification worker's retry-exhausted branch, i.e. a check was attempted
 * MAX_VERIFICATION_ATTEMPTS times and failed every time (expired/foreign
 * generation id, sustained 429/5xx). That is a verification FAILURE, not a
 * benign "not applicable" — so a material population of them must visibly
 * degrade the badge instead of being quietly discounted.
 */
const MAX_EXHAUSTED_SHARE_FOR_VERIFIED = 0.05;

/**
 * Derives the badge state. Ordering is deliberate: a real money disagreement
 * outranks incomplete coverage, and "unverifiable" is never allowed to read as
 * healthy — an unverifiable provider is explicitly labelled, never silently ok.
 */
export function deriveComplianceState(input: {
  verifiable: boolean;
  verifiableEventCount: number;
  verifiedEventCount: number;
  discrepancyEventCount: number;
  unverifiableEventCount: number;
  periodStatus: string | null;
}): ComplianceState {
  if (!input.verifiable) return "unverifiable";
  if (input.discrepancyEventCount > 0 || input.periodStatus === "discrepancy") {
    return "discrepancy";
  }
  if (input.periodStatus === "unverifiable") return "unverifiable";
  if (input.verifiableEventCount === 0) {
    // Nothing can settle. If the period had calls and every one of them
    // exhausted its retries, say so rather than implying a check is still
    // coming — or, worse, reporting a clean period as "verified".
    if (input.unverifiableEventCount > 0) return "unverifiable";
    return input.periodStatus === "ok" ? "verified" : "pending";
  }
  if (input.verifiedEventCount === 0) return "pending";
  if (input.verifiedEventCount < input.verifiableEventCount) return "partial";
  // Every event that could settle did settle — but a material share of this
  // provider's calls exhausted their retries and were never checked at all.
  // Claiming "Verified" here would be exactly the silent-OK this initiative
  // exists to prevent.
  if (
    input.unverifiableEventCount >
    (input.verifiableEventCount + input.unverifiableEventCount) *
      MAX_EXHAUSTED_SHARE_FOR_VERIFIED
  ) {
    return "partial";
  }
  return "verified";
}

function emptyStatusCounts() {
  return {
    matchedEventCount: 0,
    discrepancyEventCount: 0,
    pendingEventCount: 0,
    unverifiableEventCount: 0,
  };
}

function applyStatusGroup(
  counts: ReturnType<typeof emptyStatusCounts>,
  status: string | null,
  count: number
): void {
  switch (status) {
    case "match":
      counts.matchedEventCount += count;
      break;
    case "discrepancy":
      counts.discrepancyEventCount += count;
      break;
    case "unverifiable":
      counts.unverifiableEventCount += count;
      break;
    default:
      counts.pendingEventCount += count;
      break;
  }
}

function summarizeFromCounts(
  provider: { id: string; name: string; type: string },
  counts: ReturnType<typeof emptyStatusCounts>,
  reconciliation: {
    status: string | null;
    deltaUsd: number | null;
    reportedCostUsd: number | null;
    verifiedCostUsd: number | null;
    checkedAt: Date | null;
  } | null
): ProviderComplianceSummary {
  const visibility = getProviderIntegrationProfile(
    provider.name,
    provider.type
  ).billing.visibility;
  const verifiable = isVerifiableVisibility(visibility);
  const verifiedEventCount =
    counts.matchedEventCount + counts.discrepancyEventCount;
  const verifiableEventCount =
    verifiedEventCount +
    counts.pendingEventCount +
    counts.unverifiableEventCount;
  const coverageDenominator =
    verifiedEventCount +
    counts.pendingEventCount +
    counts.unverifiableEventCount;

  return {
    state: deriveComplianceState({
      verifiable,
      verifiableEventCount: verifiedEventCount + counts.pendingEventCount,
      verifiedEventCount,
      discrepancyEventCount: counts.discrepancyEventCount,
      unverifiableEventCount: counts.unverifiableEventCount,
      periodStatus: reconciliation?.status ?? null,
    }),
    verifiedCoverage:
      coverageDenominator > 0 ? verifiedEventCount / coverageDenominator : null,
    verifiableEventCount,
    verifiedEventCount,
    matchedEventCount: counts.matchedEventCount,
    discrepancyEventCount: counts.discrepancyEventCount,
    pendingEventCount: counts.pendingEventCount,
    unverifiableEventCount: counts.unverifiableEventCount,
    periodDeltaUsd: reconciliation?.deltaUsd ?? null,
    periodReportedCostUsd: reconciliation?.reportedCostUsd ?? null,
    periodVerifiedCostUsd: reconciliation?.verifiedCostUsd ?? null,
    periodStatus: reconciliation?.status ?? null,
    unverifiableReason: !verifiable
      ? UNVERIFIABLE_REASONS[visibility] ?? null
      : reconciliation?.status === "unverifiable"
        ? "This period could not be attributed to a single provider record — more than one active provider shares this identity, so its pushed usage cannot be split between them."
        : verifiedEventCount === 0 && counts.unverifiableEventCount > 0
          ? "Every recorded call this period exhausted its verification retries — the provider could not confirm any of them."
          : null,
    checkedAt: reconciliation?.checkedAt ?? null,
  };
}

export async function getProviderComplianceSummary(
  provider: { id: string; name: string; type: string },
  now: Date = new Date()
): Promise<ProviderComplianceSummary> {
  const map = await getProviderComplianceSummariesBatch([provider], now);
  return (
    map.get(provider.id) ??
    summarizeFromCounts(provider, emptyStatusCounts(), null)
  );
}

/**
 * Wave J: batched compliance for the providers list / dashboard.
 *
 * ONE groupBy across all providers (keyed by provider name + verificationStatus)
 * + ONE findMany of current-period reconciliation rows, then fan out in memory.
 * Avoids O(N) queries that would thrash SQLite on the dashboard load path.
 */
export async function getProviderComplianceSummariesBatch(
  providers: readonly { id: string; name: string; type: string }[],
  now: Date = new Date()
): Promise<Map<string, ProviderComplianceSummary>> {
  const out = new Map<string, ProviderComplianceSummary>();
  if (providers.length === 0) return out;

  const { periodStart, periodEnd } = monthBounds(now);
  const providerIds = providers.map((p) => p.id);
  // ExternalUsageEvent.provider is free-text; SQLite string compare is
  // case-sensitive. Query with exact stored provider names, then fan out in
  // JS with a case-insensitive secondary map for any casing drift.
  const exactNames = [
    ...new Set(providers.map((p) => p.name).filter((n) => n.trim().length > 0)),
  ];
  const nameToProviders = new Map<string, (typeof providers)[number][]>();
  for (const provider of providers) {
    const key = provider.name.trim().toLowerCase();
    const list = nameToProviders.get(key) ?? [];
    list.push(provider);
    nameToProviders.set(key, list);
  }

  const [statusGroups, reconciliations] = await Promise.all([
    prisma.externalUsageEvent.groupBy({
      by: ["provider", "verificationStatus"],
      where: {
        provider: { in: exactNames },
        providerRequestId: { not: null },
        occurredAt: { gte: periodStart, lt: periodEnd },
      },
      _count: { _all: true },
    }),
    prisma.providerUsageReconciliation.findMany({
      where: {
        providerId: { in: providerIds },
        periodStart,
        periodEnd,
        keyRef: "",
      },
      select: {
        providerId: true,
        status: true,
        deltaUsd: true,
        reportedCostUsd: true,
        verifiedCostUsd: true,
        checkedAt: true,
      },
    }),
  ]);

  const countsByProviderId = new Map<string, ReturnType<typeof emptyStatusCounts>>();
  for (const provider of providers) {
    countsByProviderId.set(provider.id, emptyStatusCounts());
  }

  for (const group of statusGroups) {
    // Prefer exact-name match first, then case-insensitive fan-out.
    const exact = providers.filter((p) => p.name === group.provider);
    const matched =
      exact.length > 0
        ? exact
        : (nameToProviders.get(group.provider.trim().toLowerCase()) ?? []);
    // When multiple provider rows share a name, attribute the event counts to
    // every row (same as prior per-provider name-keyed queries). Reconciliation
    // rows remain id-scoped and disambiguate money-level state.
    for (const provider of matched) {
      const counts = countsByProviderId.get(provider.id) ?? emptyStatusCounts();
      applyStatusGroup(counts, group.verificationStatus, group._count._all);
      countsByProviderId.set(provider.id, counts);
    }
  }

  const reconByProviderId = new Map(
    reconciliations.map((row) => [row.providerId, row] as const)
  );

  for (const provider of providers) {
    out.set(
      provider.id,
      summarizeFromCounts(
        provider,
        countsByProviderId.get(provider.id) ?? emptyStatusCounts(),
        reconByProviderId.get(provider.id) ?? null
      )
    );
  }
  return out;
}
