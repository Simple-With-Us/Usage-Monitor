import { describe, expect, it } from "vitest";

import {
  aggregateProviderFamilyMoney,
  aggregateProviderPortfolioMoney,
  type ProviderMoneyMember,
} from "@/lib/provider-money-aggregation";

const NOW = new Date("2026-07-18T12:00:00.000Z");

function member(
  id: string,
  overrides: Partial<ProviderMoneyMember> = {}
): ProviderMoneyMember {
  return {
    id,
    name: "openai",
    groupId: "openai",
    billingAccount: {
      matchKey: "billing-account-1",
      evidence: "shared_credential",
    },
    spentUsd: 23.67196375,
    projectedEomUsd: 40,
    snapshotCostUsd: 23.67196375,
    snapshotCostFetchedAt: "2026-07-18T11:00:00.000Z",
    snapshotFixedCostIncludedUsd: 0,
    pushedMonthToDateUsd: 0,
    receiptCashPaidUsd: 0,
    subscriptionMonthToDateUsd: 0,
    fixedMonthlyCostUsd: 0,
    linkedFixedDedupeUsd: 0,
    forecastedSubscriptionRenewalsUsd: 0,
    ...overrides,
  };
}

describe("provider billing-account money aggregation", () => {
  it("counts one canonical organization snapshot once and preserves distinct pushed app cost", () => {
    const result = aggregateProviderFamilyMoney(
      [
        member("st"),
        member("ct", {
          spentUsd: 27.8837226,
          pushedMonthToDateUsd: 27.8837226,
        }),
      ],
      NOW
    );

    expect(result).toMatchObject({
      exact: true,
      accountCount: 1,
      spentUsd: 27.8837226,
      ambiguity: "none",
    });
    expect(result.projectedEomUsd).toBeGreaterThan(result.spentUsd!);
    expect(result.spentUsd).not.toBeCloseTo(47.3439275);
    expect(result.spentUsd).not.toBeCloseTo(51.55568635);
  });

  it("sums provably different explicit provider accounts", () => {
    const result = aggregateProviderFamilyMoney(
      [
        member("account-a", {
          billingAccount: {
            matchKey: "billing-account-a",
            evidence: "explicit_account",
          },
          snapshotCostUsd: 12,
          spentUsd: 12,
        }),
        member("account-b", {
          billingAccount: {
            matchKey: "billing-account-b",
            evidence: "explicit_account",
          },
          snapshotCostUsd: 8,
          spentUsd: 8,
        }),
      ],
      NOW
    );

    expect(result).toMatchObject({
      exact: true,
      accountCount: 2,
      spentUsd: 20,
    });
  });

  it("does not treat different credentials as proof of different accounts", () => {
    const result = aggregateProviderFamilyMoney(
      [
        member("key-a"),
        member("key-b", {
          billingAccount: {
            matchKey: "billing-account-2",
            evidence: "shared_credential",
          },
        }),
      ],
      NOW
    );

    expect(result).toEqual({
      exact: false,
      spentUsd: null,
      projectedEomUsd: null,
      accountCount: null,
      ambiguity: "account_overlap_unproven",
    });
  });

  it("fails unresolved when same-account snapshots have incompatible billing windows", () => {
    const result = aggregateProviderFamilyMoney(
      [
        member("st", {
          snapshotCostWindowStart: "2026-07-01T00:00:00.000Z",
          snapshotCostWindowEnd: "2026-07-18T10:00:00.000Z",
          snapshotCostScope: "month_to_date",
        }),
        member("ct", {
          snapshotCostFetchedAt: "2026-07-18T11:30:00.000Z",
          snapshotCostWindowStart: "2026-07-15T00:00:00.000Z",
          snapshotCostWindowEnd: "2026-07-18T11:00:00.000Z",
          snapshotCostScope: "month_to_date",
        }),
      ],
      NOW
    );
    expect(result).toMatchObject({
      exact: false,
      ambiguity: "account_overlap_unproven",
    });
  });

  it("uses the latest compatible cumulative snapshot for one exact account", () => {
    const result = aggregateProviderFamilyMoney(
      [
        member("older", {
          snapshotCostUsd: 10,
          snapshotCostFetchedAt: "2026-07-18T10:00:00.000Z",
          snapshotCostWindowStart: "2026-07-01T00:00:00.000Z",
          snapshotCostWindowEnd: "2026-07-18T09:59:00.000Z",
          snapshotCostScope: "month_to_date",
        }),
        member("latest", {
          snapshotCostUsd: 12,
          snapshotCostFetchedAt: "2026-07-18T11:00:00.000Z",
          snapshotCostWindowStart: "2026-07-01T00:00:00.000Z",
          snapshotCostWindowEnd: "2026-07-18T10:59:00.000Z",
          snapshotCostScope: "MONTH_TO_DATE",
        }),
      ],
      NOW
    );
    expect(result).toMatchObject({ exact: true, spentUsd: 12 });
  });

  it("fails closed when any multi-row member lacks account identity", () => {
    const result = aggregateProviderFamilyMoney(
      [member("known"), member("missing", { billingAccount: null })],
      NOW
    );
    expect(result.exact).toBe(false);
    expect(result.ambiguity).toBe("account_identity_missing");
  });

  it("dedupes only the canonical fixed snapshot and keeps exact local fixed sources additive", () => {
    const result = aggregateProviderFamilyMoney(
      [
        member("st", {
          snapshotCostUsd: 15,
          snapshotFixedCostIncludedUsd: 5,
          subscriptionMonthToDateUsd: 5,
          pushedMonthToDateUsd: 5,
          linkedFixedDedupeUsd: 5,
          fixedMonthlyCostUsd: 3,
        }),
        member("ct", {
          snapshotCostUsd: 15,
          snapshotFixedCostIncludedUsd: 5,
          subscriptionMonthToDateUsd: 2,
          pushedMonthToDateUsd: 6,
        }),
      ],
      NOW
    );

    // variable=max($10 canonical, $4 pushed)=10; plan fixed $3 suppressed when
    // subscription MTD is present; fixed=$0+$5+$2+$5-$5=7 → spent=17.
    expect(result.spentUsd).toBe(17);
  });

  it("ignores non-additive component records because only canonical budget fields enter the formula", () => {
    const baseline = member("one", { snapshotCostUsd: 9 });
    const withComponents = {
      ...baseline,
      externalBilling: [
        { rollupRole: "component", amountUsd: 1000 },
        { rollupRole: "component", amountUsd: 2000 },
      ],
    } as ProviderMoneyMember;
    expect(aggregateProviderFamilyMoney([withComponents], NOW).spentUsd).toBe(
      aggregateProviderFamilyMoney([baseline], NOW).spentUsd
    );
  });

  it("uses exact account totals in portfolio spend/projection and excludes only unresolved families", () => {
    const providers = [
      member("st"),
      member("ct", {
        pushedMonthToDateUsd: 27.8837226,
        spentUsd: 27.8837226,
      }),
      member("github", {
        name: "github",
        groupId: null,
        billingAccount: null,
        spentUsd: 5,
        projectedEomUsd: 7,
        snapshotCostUsd: null,
      }),
      member("ambiguous-a", {
        name: "google-ai",
        billingAccount: null,
      }),
      member("ambiguous-b", {
        name: "google-ai",
        billingAccount: null,
      }),
    ];
    const result = aggregateProviderPortfolioMoney(providers, NOW);
    const openAi = aggregateProviderFamilyMoney(providers.slice(0, 2), NOW);

    expect(result.totalCost).toBeCloseTo(openAi.spentUsd! + 5);
    expect(result.totalProjectedMonthlyCost).toBeCloseTo(
      openAi.projectedEomUsd! + 7
    );
    expect(result.ambiguousCostFamilyCount).toBe(1);
    expect(result.incompleteCostFamilyCount).toBe(0);
    expect(result.families.length).toBe(3);
  });

  it("excludes null-spend exact families from portfolio total instead of coercing to $0", () => {
    const result = aggregateProviderPortfolioMoney(
      [
        member("unknown-only", {
          name: "voyage",
          spentUsd: null,
          projectedEomUsd: 0,
          snapshotCostUsd: null,
        }),
        member("known", {
          name: "openai",
          spentUsd: 10,
          projectedEomUsd: 12,
          snapshotCostUsd: 10,
        }),
      ],
      NOW
    );
    expect(result.totalCost).toBeCloseTo(10);
    expect(result.incompleteCostFamilyCount).toBe(1);
  });

  it("does not treat receipt cash as family variable spend", () => {
    const result = aggregateProviderFamilyMoney(
      [
        member("with-receipt", {
          snapshotCostUsd: 5,
          spentUsd: 5,
          receiptCashPaidUsd: 100,
          pushedMonthToDateUsd: 0,
        }),
      ],
      NOW
    );
    // Lone member pass-through keeps spentUsd from caller (5), not 100.
    expect(result.spentUsd).toBe(5);
  });

  it("drops plan fixed when subscription MTD is present on multi-member family", () => {
    const result = aggregateProviderFamilyMoney(
      [
        member("a", {
          fixedMonthlyCostUsd: 20,
          subscriptionMonthToDateUsd: 20,
          snapshotCostUsd: 0,
          spentUsd: 20,
        }),
        member("b", {
          fixedMonthlyCostUsd: 0,
          subscriptionMonthToDateUsd: 0,
          snapshotCostUsd: 0,
          spentUsd: 0,
          pushedMonthToDateUsd: 0,
        }),
      ],
      NOW
    );
    // plan fixed suppressed on member with subscription; only $20 sub + $0 snap
    expect(result.spentUsd).toBeCloseTo(20);
  });
});

describe("S2/S6: receipt floor removal + authoritative fixed accrual", () => {
  it("does not floor family projection at receipt cash after a top-up (S2)", () => {
    // Two members of one billing account: $5 observed usage, $500 prepaid
    // top-up. Pre-fix the family projection floored at $500; now receipts are
    // funding coverage only and the projection follows the usage forecast.
    const result = aggregateProviderFamilyMoney(
      [
        member("a", {
          snapshotCostUsd: 5,
          spentUsd: 5,
          receiptCashPaidUsd: 500,
        }),
        member("b", {
          snapshotCostUsd: null,
          snapshotCostFetchedAt: null,
          spentUsd: 0,
          receiptCashPaidUsd: 0,
        }),
      ],
      NOW // 2026-07-18T12:00Z → day 18.5 of 31
    );
    expect(result.exact).toBe(true);
    // Linear usage forecast: 5 / 18.5 * 31 ≈ 8.38 — nowhere near $500.
    expect(result.projectedEomUsd).toBeCloseTo((5 / 18.5) * 31, 6);
    expect(result.projectedEomUsd!).toBeLessThan(100);
  });

  it("consumes authoritative fixedAccruedUsd so portfolio totals equal budget-status totals (S6)", () => {
    // Fixture shaped after linked subscriptions + a charge correction:
    // member A's $25 snapshot fixed is fully deduped against its linked
    // materialized subscription (linkedFixedDedupeUsd=25); budget-status's
    // authoritative reconcile yields fixedAccruedUsd=25 for A. Member B has
    // no snapshot and a correction-adjusted accrual of $7 that the legacy
    // local re-derivation cannot see (it would compute $0 for B).
    const authoritative = [
      member("account-a", {
        billingAccount: {
          matchKey: "billing-account-a",
          evidence: "explicit_account",
        },
        snapshotCostUsd: 30,
        snapshotFixedCostIncludedUsd: 25,
        linkedFixedDedupeUsd: 25,
        subscriptionMonthToDateUsd: 25,
        pushedMonthToDateUsd: 25,
        fixedAccruedUsd: 25,
        spentUsd: 30,
        projectedEomUsd: 34,
      }),
      member("account-b", {
        billingAccount: {
          matchKey: "billing-account-b",
          evidence: "explicit_account",
        },
        snapshotCostUsd: null,
        snapshotCostFetchedAt: null,
        fixedAccruedUsd: 7,
        spentUsd: 7,
        projectedEomUsd: 9,
      }),
    ];
    const family = aggregateProviderFamilyMoney(authoritative, NOW);
    // A: fixed 25 + variable max(30-25, 0) = 30 (A's own spentUsd).
    // B: fixed 7 (authoritative) + variable 0 = 7 (B's own spentUsd).
    expect(family.spentUsd).toBe(30 + 7);

    // The portfolio rollup over the same members equals the sum of the
    // per-provider budget-status spend — no drift between the two
    // implementations.
    const portfolio = aggregateProviderPortfolioMoney(authoritative, NOW);
    expect(portfolio.totalCost).toBeCloseTo(30 + 7);
    expect(portfolio.ambiguousCostFamilyCount).toBe(0);
  });

  it("keeps the legacy fixed derivation when members lack authoritative accruals", () => {
    const legacy = aggregateProviderFamilyMoney(
      [
        member("a", {
          fixedMonthlyCostUsd: 20,
          subscriptionMonthToDateUsd: 20,
          snapshotCostUsd: 0,
          spentUsd: 20,
          fixedAccruedUsd: undefined,
        }),
        member("b", {
          snapshotCostUsd: 0,
          spentUsd: 0,
          fixedAccruedUsd: undefined,
        }),
      ],
      NOW
    );
    // Same result as the pre-S6 simplified derivation: plan fixed suppressed
    // by subscription MTD → $20.
    expect(legacy.spentUsd).toBeCloseTo(20);
  });
});
