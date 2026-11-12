import { calculateEomForecast } from "@/lib/forecasting";
import { canonicalProviderKey } from "@/lib/provider-identity";

export interface ProviderMoneyMember {
  id: string;
  name: string;
  groupId: string | null;
  billingAccount?: {
    matchKey: string;
    evidence: "explicit_account" | "shared_credential";
  } | null;
  spentUsd?: number | null;
  projectedEomUsd: number;
  snapshotCostUsd?: number | null;
  snapshotCostFetchedAt?: string | null;
  snapshotCostWindowStart?: string | null;
  snapshotCostWindowEnd?: string | null;
  snapshotCostScope?: string | null;
  snapshotFixedCostIncludedUsd?: number;
  pushedMonthToDateUsd?: number;
  receiptCashPaidUsd?: number;
  subscriptionMonthToDateUsd?: number;
  fixedMonthlyCostUsd?: number;
  linkedFixedDedupeUsd?: number;
  forecastedSubscriptionRenewalsUsd?: number;
  /**
   * S6: the AUTHORITATIVE per-provider fixed-cost accrual from
   * computeBudgetStatus (plan fixed vs subscription dedup, linked external
   * billing periods, charge corrections). When present on every member of an
   * account, the family math consumes it instead of re-deriving fixed-cost
   * reconciliation locally. Absent (legacy callers), the legacy derivation
   * below is kept as a fallback.
   */
  fixedAccruedUsd?: number | null;
}

export interface ProviderFamilyMoney {
  exact: boolean;
  spentUsd: number | null;
  projectedEomUsd: number | null;
  accountCount: number | null;
  ambiguity: "none" | "account_identity_missing" | "account_overlap_unproven";
}

function money(value: number | null | undefined): number {
  return Number.isFinite(value) ? (value as number) : 0;
}

/**
 * The part of a member's fixed accrual that is REPRESENTED IN ITS OWN
 * SNAPSHOT: snapshot-declared fixed (clamped to the snapshot total) minus the
 * linked-subscription dedupe. When several members share one billing account
 * (and therefore one canonical snapshot), this slice must be counted once per
 * account, not once per member.
 */
function netSnapshotFixedUsd(member: ProviderMoneyMember): number {
  const snapshotFixed = Math.max(
    0,
    Math.min(
      money(member.snapshotFixedCostIncludedUsd),
      money(member.snapshotCostUsd)
    )
  );
  return Math.max(
    0,
    snapshotFixed - Math.max(0, money(member.linkedFixedDedupeUsd))
  );
}

function aggregateExactAccount(
  members: ProviderMoneyMember[],
  now: Date
): { spentUsd: number; projectedEomUsd: number } | null {
  const snapshots = members
    .filter((member) => member.snapshotCostUsd != null)
    .map((member) => ({
      member,
      costUsd: money(member.snapshotCostUsd),
      fixedUsd: Math.max(0, money(member.snapshotFixedCostIncludedUsd)),
      fetchedAt: Date.parse(member.snapshotCostFetchedAt ?? ""),
      windowStart: member.snapshotCostWindowStart ?? null,
      windowEnd: member.snapshotCostWindowEnd ?? null,
      scope: member.snapshotCostScope?.trim().toLowerCase() || null,
    }));
  let canonicalSnapshot: (typeof snapshots)[number] = {
    member: members[0],
    costUsd: 0,
    fixedUsd: 0,
    fetchedAt: Number.NaN,
    windowStart: null,
    windowEnd: null,
    scope: null,
  };
  if (snapshots.length === 1) {
    canonicalSnapshot = snapshots[0];
  } else if (snapshots.length > 1) {
    const dated = snapshots.filter((snapshot) => Number.isFinite(snapshot.fetchedAt));
    if (dated.length !== snapshots.length) return null;
    const ordered = dated.toSorted((left, right) => right.fetchedAt - left.fetchedAt);
    canonicalSnapshot = ordered[0];
    const sameStartAndScope = ordered.every(
      (snapshot) =>
        snapshot.windowStart === canonicalSnapshot.windowStart &&
        snapshot.scope === canonicalSnapshot.scope
    );
    if (!sameStartAndScope) return null;

    const canonicalEnd = canonicalSnapshot.windowEnd == null
      ? null
      : Date.parse(canonicalSnapshot.windowEnd);
    if (canonicalSnapshot.windowEnd != null && !Number.isFinite(canonicalEnd)) {
      return null;
    }
    for (const snapshot of ordered.slice(1)) {
      if ((snapshot.windowEnd == null) !== (canonicalSnapshot.windowEnd == null)) {
        return null;
      }
      if (snapshot.windowEnd != null) {
        const end = Date.parse(snapshot.windowEnd);
        if (!Number.isFinite(end) || end > canonicalEnd!) return null;
      }
    }
  }
  const canonicalMember =
    snapshots.length > 0 ? canonicalSnapshot.member : null;

  const canonicalFixedUsd = Math.min(
    canonicalSnapshot.fixedUsd,
    canonicalSnapshot.costUsd
  );
  const canonicalVariableUsd = Math.max(
    0,
    canonicalSnapshot.costUsd - canonicalFixedUsd
  );
  const pushedVariableUsd = members.reduce(
    (sum, member) =>
      sum +
      Math.max(
        0,
        money(member.pushedMonthToDateUsd) -
          money(member.subscriptionMonthToDateUsd)
      ),
    0
  );
  // Variable *consumption* only: prepaid receipt cash is funding evidence,
  // not usage. max(snapshot, push) remains the usage merge (same-account
  // multi-app: push is summed, snapshot is canonical once).
  const observedVariableUsd = Math.max(
    canonicalVariableUsd,
    pushedVariableUsd
  );
  const variableSpendUsd = observedVariableUsd;

  let fixedAccruedUsd: number;
  if (members.every((member) => Number.isFinite(member.fixedAccruedUsd))) {
    // S6: consume computeBudgetStatus's authoritative per-provider fixed-cost
    // reconciliation (linked external billing periods + charge corrections +
    // plan-vs-subscription dedup) instead of re-deriving a simplified version
    // here. Each member's accrual already contains its snapshot-represented
    // fixed slice; strip that slice per member and add the CANONICAL
    // snapshot's slice back exactly once so the shared account snapshot is
    // never double-counted across members of one billing account.
    const nonSnapshotFixedUsd = members.reduce(
      (sum, member) =>
        sum +
        Math.max(
          0,
          money(member.fixedAccruedUsd) - netSnapshotFixedUsd(member)
        ),
      0
    );
    fixedAccruedUsd =
      nonSnapshotFixedUsd +
      (canonicalMember ? netSnapshotFixedUsd(canonicalMember) : 0);
  } else {
    // Legacy fallback for callers that do not pass authoritative accruals:
    // prefer subscription events over plan fixed when both appear on a family
    // member (double-count guard aligned with budget-status).
    const localFixedUsd = members.reduce((sum, member) => {
      const subscriptionUsd = money(member.subscriptionMonthToDateUsd);
      const planFixedUsd =
        subscriptionUsd > 0 ? 0 : money(member.fixedMonthlyCostUsd);
      return sum + planFixedUsd + subscriptionUsd;
    }, 0);
    const linkedFixedDedupeUsd = Math.min(
      canonicalFixedUsd,
      members.reduce(
        (sum, member) => sum + Math.max(0, money(member.linkedFixedDedupeUsd)),
        0
      )
    );
    fixedAccruedUsd =
      localFixedUsd + canonicalFixedUsd - linkedFixedDedupeUsd;
  }
  // S2: prepaid receipt cash is funding coverage, NEVER projected
  // consumption. Floor the projection at max(observed, linear forecast)
  // only — a large top-up over small usage must not project a fabricated
  // end-of-month breach.
  const projectedVariableUsd = Math.max(
    observedVariableUsd,
    calculateEomForecast(observedVariableUsd, 0, now)
  );
  const futureRenewalsUsd = members.reduce(
    (sum, member) => sum + money(member.forecastedSubscriptionRenewalsUsd),
    0
  );

  return {
    spentUsd: fixedAccruedUsd + variableSpendUsd,
    projectedEomUsd:
      fixedAccruedUsd + projectedVariableUsd + futureRenewalsUsd,
  };
}

export function aggregateProviderFamilyMoney(
  members: ProviderMoneyMember[],
  now: Date = new Date()
): ProviderFamilyMoney {
  if (members.length === 0) {
    return {
      exact: true,
      spentUsd: 0,
      projectedEomUsd: 0,
      accountCount: 0,
      ambiguity: "none",
    };
  }
  if (members.length === 1) {
    // A lone member is never combined with anything, so this is a direct
    // pass-through rather than an aggregation. Deliberately preserve a null
    // spentUsd (the caller's coverage-aware "unknown, not zero" signal)
    // instead of coercing it through `money()`, which exists only to give
    // additive multi-member math a safe zero identity element. Coercing here
    // would present an untrustworthy/unknown amount as an authoritative
    // exact $0.00 in the family total, a false-zero money-path bug.
    const spentUsd = members[0].spentUsd ?? null;
    return {
      exact: true,
      spentUsd,
      projectedEomUsd: spentUsd == null ? null : money(members[0].projectedEomUsd),
      accountCount: 1,
      ambiguity: "none",
    };
  }
  if (members.some((member) => member.billingAccount == null)) {
    return {
      exact: false,
      spentUsd: null,
      projectedEomUsd: null,
      accountCount: null,
      ambiguity: "account_identity_missing",
    };
  }

  const identities = new Map<string, ProviderMoneyMember[]>();
  for (const member of members) {
    const key = member.billingAccount!.matchKey;
    const group = identities.get(key);
    if (group) group.push(member);
    else identities.set(key, [member]);
  }
  const allOneIdentity = identities.size === 1;
  const allExplicit = members.every(
    (member) => member.billingAccount?.evidence === "explicit_account"
  );
  if (!allOneIdentity && !allExplicit) {
    return {
      exact: false,
      spentUsd: null,
      projectedEomUsd: null,
      accountCount: null,
      ambiguity: "account_overlap_unproven",
    };
  }

  let spentUsd = 0;
  let projectedEomUsd = 0;
  for (const accountMembers of identities.values()) {
    const account = aggregateExactAccount(accountMembers, now);
    if (!account) {
      return {
        exact: false,
        spentUsd: null,
        projectedEomUsd: null,
        accountCount: identities.size,
        ambiguity: "account_overlap_unproven",
      };
    }
    spentUsd += account.spentUsd;
    projectedEomUsd += account.projectedEomUsd;
  }
  return {
    exact: true,
    spentUsd,
    projectedEomUsd,
    accountCount: identities.size,
    ambiguity: "none",
  };
}

export function aggregateProviderPortfolioMoney(
  providers: ProviderMoneyMember[],
  now: Date = new Date()
): {
  totalCost: number;
  totalProjectedMonthlyCost: number;
  ambiguousCostFamilyCount: number;
  /** Families with exact=true but null spent (unknown/unpriced), excluded from total. */
  incompleteCostFamilyCount: number;
  /** Family-level rows for charts / UI that must match KPI aggregation. */
  families: Array<{
    key: string;
    displayName: string;
    spentUsd: number | null;
    projectedEomUsd: number | null;
    exact: boolean;
    memberCount: number;
  }>;
} {
  const families = new Map<string, ProviderMoneyMember[]>();
  for (const provider of providers) {
    const key = canonicalProviderKey(provider.name) || provider.id;
    const family = families.get(key);
    if (family) family.push(provider);
    else families.set(key, [provider]);
  }

  let totalCost = 0;
  let totalProjectedMonthlyCost = 0;
  let ambiguousCostFamilyCount = 0;
  let incompleteCostFamilyCount = 0;
  const familyRows: Array<{
    key: string;
    displayName: string;
    spentUsd: number | null;
    projectedEomUsd: number | null;
    exact: boolean;
    memberCount: number;
  }> = [];
  for (const [key, family] of families.entries()) {
    const aggregate = aggregateProviderFamilyMoney(family, now);
    const displayName =
      family.find((m) => m.name)?.name ??
      family[0]?.id ??
      key;
    familyRows.push({
      key,
      displayName,
      spentUsd: aggregate.spentUsd,
      projectedEomUsd: aggregate.projectedEomUsd,
      exact: aggregate.exact,
      memberCount: family.length,
    });
    if (!aggregate.exact) {
      ambiguousCostFamilyCount += 1;
      continue;
    }
    // Never coerce unknown (null) spend into an authoritative $0 portfolio total.
    if (aggregate.spentUsd == null) {
      incompleteCostFamilyCount += 1;
      continue;
    }
    totalCost += aggregate.spentUsd;
    if (aggregate.projectedEomUsd != null) {
      totalProjectedMonthlyCost += aggregate.projectedEomUsd;
    }
  }
  return {
    totalCost,
    totalProjectedMonthlyCost,
    ambiguousCostFamilyCount,
    incompleteCostFamilyCount,
    families: familyRows,
  };
}
