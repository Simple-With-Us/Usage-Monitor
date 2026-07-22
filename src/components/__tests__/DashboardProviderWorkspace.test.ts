import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import DashboardProviderWorkspace, {
  compareFamiliesBy,
  emptyStateMessage,
  familyMatchesFilter,
  formatRelativeTime,
  formatShortDate,
  INITIAL_SORT_DIRECTION,
} from "@/components/DashboardProviderWorkspace";
import type { ExternalBillingRecord } from "@/components/ExternalBillingDetails";

type WorkspaceProps = ComponentProps<typeof DashboardProviderWorkspace>;
type WorkspaceProvider = WorkspaceProps["providers"][number];
type WorkspaceSubscription = WorkspaceProps["subscriptions"][number];
type Family = Parameters<typeof compareFamiliesBy>[1];

function family(overrides: Partial<Family> = {}): Family {
  return {
    key: "family",
    detailsId: "provider-family-details-family",
    displayName: "Family",
    providerName: "family",
    providers: [],
    subscriptions: [],
    providerExternalBilling: [],
    hiddenExternalBillingCount: 0,
    searchableExternalBilling: [],
    financialsAggregated: true,
    spentUsd: null,
    projectedUsd: null,
    budgetUsd: null,
    spendSortUsd: 0,
    credits: null,
    balance: null,
    alertCount: 0,
    criticalCount: 0,
    activeCount: 0,
    incompleteCostCount: 0,
    costCoverageCaveatCount: 0,
    costCoverageCaveatMessage: null,
    nextRenewalAt: null,
    latestFetchedAt: null,
    ...overrides,
  };
}

function extractTdInner(html: string, dataLabel: string): string {
  const pattern = new RegExp(`<td data-label="${dataLabel}"[^>]*>([\\s\\S]*?)<\\/td>`);
  const match = html.match(pattern);
  if (!match) throw new Error(`td not found for data-label="${dataLabel}"`);
  return match[1];
}

/**
 * Approximate "does this HTML fragment have exactly one top-level element
 * child, with no sibling elements and no bare text nodes at the top level"
 * check — guards the §5.2 mobile-grid single-wrapper contract without a DOM
 * (this harness is renderToStaticMarkup only, no jsdom).
 */
function hasSingleElementChild(html: string): boolean {
  const trimmed = html.trim();
  if (!trimmed.startsWith("<")) return false;
  const tagPattern = /<\/?[a-zA-Z][a-zA-Z0-9]*(?:\s[^>]*)?\/?>/g;
  let depth = 0;
  let sawOpen = false;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(trimmed))) {
    const tag = match[0];
    const isClosing = tag.startsWith("</");
    const isSelfClosing = /\/>$/.test(tag);
    if (isClosing) {
      depth -= 1;
    } else {
      sawOpen = true;
      if (!isSelfClosing) depth += 1;
    }
    if (sawOpen && depth === 0) {
      const remainder = trimmed.slice(tagPattern.lastIndex).trim();
      return remainder.length === 0;
    }
  }
  return false;
}

function provider(
  id: string,
  overrides: Partial<WorkspaceProvider> = {}
): WorkspaceProvider {
  return {
    id,
    name: "anthropic",
    displayName: `Anthropic (${id})`,
    type: "builtin",
    isActive: true,
    groupId: "anthropic",
    label: id,
    estimatedMonthlyCostUsd: 0,
    projectedEomUsd: 0,
    spentUsd: 0,
    spendCoverage: "complete",
    pushedCostCoverage: "complete",
    pushedPricedEventCount: 1,
    pushedUnpricedEventCount: 0,
    pushedUnclassifiedCostEventCount: 0,
    plan: null,
    billingMode: "actual",
    alerts: [],
    latestSnapshot: null,
    ...overrides,
  };
}

function subscription(
  id: string,
  providerId: string,
  overrides: Partial<WorkspaceSubscription> = {}
): WorkspaceSubscription {
  return {
    id,
    name: id,
    description: null,
    costUsd: 10,
    currency: "USD",
    interval: "monthly",
    intervalCount: 1,
    monthlyEquivalentUsd: 10,
    anchorDay: null,
    startDate: "2098-01-01T00:00:00.000Z",
    currentPeriodStart: "2098-01-01T00:00:00.000Z",
    nextRenewalAt: "2099-02-01T00:00:00.000Z",
    autoRenew: true,
    status: "active",
    notes: null,
    externalBillingSource: null,
    externalBillingId: null,
    knobEnv: null,
    freeTierKnobEnv: null,
    provider: { id: providerId, name: "anthropic", displayName: "Anthropic" },
    project: null,
    ...overrides,
  };
}

function externalBilling(
  overrides: Partial<ExternalBillingRecord> = {}
): ExternalBillingRecord {
  return {
    source: "provider-api",
    externalId: "external-1",
    kind: "subscription",
    serviceName: "Provider plan",
    planName: "Pro",
    status: "active",
    amountUsd: 10,
    currency: "USD",
    billingInterval: "monthly",
    currentPeriodStart: "2099-01-01T00:00:00.000Z",
    currentPeriodEnd: "2099-02-01T00:00:00.000Z",
    nextRenewalAt: "2099-02-01T00:00:00.000Z",
    requestLimit: null,
    requestLimitWindow: null,
    spendLimitUsd: null,
    spendLimitWindow: null,
    rollupRole: "canonical",
    dateKind: "renewal",
    syncedAt: "2026-07-15T00:00:00.000Z",
    ...overrides,
  };
}

function renderWorkspace(
  providers: WorkspaceProvider[],
  subscriptions: WorkspaceSubscription[] = [],
  initiallyExpanded = true
): string {
  return renderToStaticMarkup(
    createElement(DashboardProviderWorkspace, {
      providers,
      subscriptions,
      initiallyExpanded,
    })
  );
}

describe("DashboardProviderWorkspace", () => {
  it("reports unknown pending Gemini cost without presenting a false zero", () => {
    const html = renderWorkspace([
      provider("socratic-gemini", {
        name: "google-ai",
        displayName: "Google AI (SocraticTrade.com)",
        spentUsd: 0,
        projectedEomUsd: 0,
        spendCoverage: "unknown",
        pushedCostCoverage: "unknown",
        pushedPricedEventCount: 0,
        geminiBillingStatus: {
          state: "pending",
          errorCode: null,
          httpStatus: null,
          retryable: true,
          checkedAt: "2026-07-15T00:00:00.000Z",
        },
      }),
    ]);

    expect(html).toContain("Cost not reported");
    expect(html).toContain("Projection unavailable");
    expect(html).toContain(
      'aria-label="Google AI month-to-date spend: Cost not reported"'
    );
    expect(html).toContain("Projection unavailable · Unknown coverage");
    expect(html).not.toContain("$0.00");
  });

  it("preserves an authoritative actual zero", () => {
    const html = renderWorkspace([
      provider("socratic-gemini", {
        name: "google-ai",
        displayName: "Google AI",
        spentUsd: 0,
        projectedEomUsd: 0,
        spendCoverage: "complete",
      }),
    ]);

    expect(html).toContain(
      'aria-label="Google AI month-to-date spend: $0.00"'
    );
    expect(html).toContain(">$0.00</span>");
    expect(html).toContain("$0.00 projected · Complete coverage");
    expect(html).not.toContain("Cost not reported");
  });

  it("renders provider-specific brokerage and prepaid labels", () => {
    const tradierHtml = renderWorkspace([
      provider("tradier", {
        name: "tradier",
        groupId: "tradier",
        latestSnapshot: {
          balance: 5,
          totalCost: 0,
          totalRequests: 0,
          credits: 299,
          fetchedAt: "2026-07-15T00:00:00.000Z",
        },
      }),
    ]);
    const openRouterHtml = renderWorkspace([
      provider("openrouter", {
        name: "openrouter",
        groupId: "openrouter",
        latestSnapshot: {
          balance: 23.36,
          totalCost: 1.64,
          totalRequests: 10,
          credits: 25,
          fetchedAt: "2026-07-15T00:00:00.000Z",
        },
      }),
    ]);

    expect(tradierHtml).toContain("299 API requests remaining");
    expect(tradierHtml).toContain("$5.00 brokerage equity");
    expect(openRouterHtml).toContain("25 purchased credits");
    expect(openRouterHtml).toContain("$23.36 prepaid remaining");
  });

  it("does not aggregate ambiguous same-family financial values", () => {
    const html = renderWorkspace([
      provider("account-one", {
        spentUsd: 100,
        receiptCashPaidUsd: 47.25,
        receiptCashEventCount: 3,
        observedVariableUsageUsd: 40,
        estimatedApiEquivalentUsd: 9_000,
        projectedEomUsd: 150,
        plan: {
          fixedMonthlyCostUsd: null,
          monthlyBudgetUsd: 50,
          monthlyRequestLimit: null,
          renewalDate: null,
          billingInterval: "monthly",
          notes: null,
        },
        latestSnapshot: {
          balance: 5,
          totalCost: 100,
          totalRequests: 10,
          credits: 10,
          fetchedAt: "2026-07-15T00:00:00.000Z",
        },
      }),
      provider("account-two", {
        spentUsd: 200,
        projectedEomUsd: 250,
        plan: {
          fixedMonthlyCostUsd: null,
          monthlyBudgetUsd: 75,
          monthlyRequestLimit: null,
          renewalDate: null,
          billingInterval: "monthly",
          notes: null,
        },
        latestSnapshot: {
          balance: 7,
          totalCost: 200,
          totalRequests: 20,
          credits: 20,
          fetchedAt: "2026-07-15T00:00:00.000Z",
        },
      }),
    ]);

    expect(html).toContain("Account identity unresolved");
    expect(html).toContain("$100.00 spent");
    expect(html).toContain("$47.25 receipt cash");
    expect(html).toContain("$9,000.00 Claude estimate excluded");
    expect(html).toContain("$200.00 spent");
    expect(html).toContain("$50.00 budget");
    expect(html).toContain("$75.00 budget");
    expect(html).toContain("10 credits / $5.00 account balance");
    expect(html).toContain("20 credits / $7.00 account balance");
    expect(html).not.toContain("$300.00");
    expect(html).not.toContain("$125.00");
    expect(html).not.toContain("$400.00");
    expect(html).not.toContain("30 credits");
    expect(html).not.toContain("$12.00 account balance");
  });

  it("deduplicates linked provider billing and separates renewals from period and term ends", () => {
    const linkedRecord = externalBilling({
      source: "cloudflare-subscriptions",
      externalId: "pro-plan",
      serviceName: "SHOULD-NOT-RENDER",
      amountUsd: 19,
      currency: "EUR",
    });
    const periodRecord = externalBilling({
      externalId: "invoice-period",
      kind: "invoice",
      serviceName: "Usage period",
      status: "open",
      amountUsd: 5,
      currency: "EUR",
      dateKind: "period_end",
      nextRenewalAt: "2099-01-01T00:00:00.000Z",
    });
    const html = renderWorkspace(
      [
        provider("provider-one", {
          externalBilling: [linkedRecord, periodRecord, periodRecord],
        }),
        provider("provider-two"),
      ],
      [
        subscription("Cloudflare Pro", "provider-one", {
          costUsd: 19,
          currency: "EUR",
          monthlyEquivalentUsd: 19,
          externalBillingSource: "cloudflare-subscriptions",
          externalBillingId: "pro-plan",
        }),
        subscription("Ends with term", "provider-one", {
          autoRenew: false,
          nextRenewalAt: "2099-01-10T00:00:00.000Z",
        }),
        subscription("Canceled", "provider-one", {
          status: "canceled",
          nextRenewalAt: "2099-01-15T00:00:00.000Z",
        }),
        subscription("Expired term", "provider-one", {
          autoRenew: false,
          status: "active",
          effectiveStatus: "expired",
          nextRenewalAt: "2020-01-10T00:00:00.000Z",
        }),
      ]
    );

    expect(html).toContain("5 records");
    expect(html).not.toContain("SHOULD-NOT-RENDER");
    expect(html.match(/Usage period/g)).toHaveLength(1);
    expect(html).toContain("linked cloudflare-subscriptions");
    expect(html).toContain("Provider: Pro");
    expect(html).toContain("€19.00");
    expect(html).toContain("€5.00");
    expect(html).toContain("Period ends");
    expect(html).toContain("Term ends");
    expect(html).toContain("expired / monthly");
    expect(html).toContain("Term ended 1/10/2020");
    expect(html).toContain("Next renewal 2/1/2099");
  });

  it("collapses repeated accounts by default while preserving an accessible drill-down", () => {
    const html = renderWorkspace(
      [
        provider("provider-one"),
        provider("provider-two"),
        provider("provider-three"),
        provider("provider-four"),
      ],
      [],
      false
    );

    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("4 accounts / keys");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="provider-family-details-provider-one"');
    expect(html).toContain(
      'aria-label="Show Anthropic account and service details"'
    );
    expect(html).toContain(
      'id="provider-family-details-provider-one" hidden="" style="display:none"'
    );
    expect(html).toContain("table-group-cell");
    expect(html.match(/data-label="Provider family"/g)).toHaveLength(1);
    for (const id of [
      "provider-one",
      "provider-two",
      "provider-three",
      "provider-four",
    ]) {
      expect(html).not.toContain(`href="/providers/${id}"`);
    }
  });

  it("surfaces a cost coverage gap on the family row without requiring expansion", () => {
    const html = renderWorkspace(
      [
        provider("cloudflare-account", {
          name: "cloudflare",
          displayName: "Cloudflare",
          groupId: null,
          spentUsd: 5,
          spendCoverage: "complete",
          costCoverageCaveat: {
            code: "cloudflare_paygo_usage_unavailable",
            message: "Usage-based costs (D1, R2, Workers, Queues overage) are not visible for this account — only the fixed subscription fee is shown. Cost may be understated.",
          },
        }),
      ],
      [],
      false
    );

    // Single-account family: collapsed by default (PR #296).
    expect(html).toContain('aria-expanded="false"');
    const spendCell = extractTdInner(html, "Spend");
    expect(spendCell).toContain("Cost coverage gap");
  });

  it("does not show a cost coverage gap badge when no member provider has one", () => {
    const html = renderWorkspace([
      provider("cloudflare-account", {
        name: "cloudflare",
        displayName: "Cloudflare",
        groupId: null,
        spentUsd: 5,
        spendCoverage: "complete",
      }),
    ]);

    expect(html).not.toContain("Cost coverage gap");
  });

  it("does not show a stale cost coverage gap badge on the family row for a deactivated provider", () => {
    // A deactivated provider is no longer polled (fetchAllDueProviders only
    // covers isActive:true), so its last-recorded caveat can never be
    // cleared by a fresh snapshot. The family-row badge must not keep
    // displaying it indefinitely for an account that isn't even monitored.
    const html = renderWorkspace([
      provider("cloudflare-account", {
        name: "cloudflare",
        displayName: "Cloudflare",
        groupId: null,
        isActive: false,
        spentUsd: 5,
        spendCoverage: "complete",
        costCoverageCaveat: {
          code: "cloudflare_paygo_usage_unavailable",
          message: "Usage-based costs (D1, R2, Workers, Queues overage) are not visible for this account — only the fixed subscription fee is shown. Cost may be understated.",
        },
      }),
    ]);

    const spendCell = extractTdInner(html, "Spend");
    expect(spendCell).not.toContain("Cost coverage gap");
  });
});

describe("formatShortDate", () => {
  const now = Date.parse("2026-07-15T12:00:00.000Z");

  it("formats a same-year date without a year", () => {
    expect(formatShortDate("2026-06-03T00:00:00.000Z", now)).toBe("Jun 3");
  });

  it("formats a cross-year date with the year", () => {
    expect(formatShortDate("2025-06-03T00:00:00.000Z", now)).toBe("Jun 3, 2025");
  });

  it("formats a future renewal date instead of clamping (the regression this helper exists to prevent)", () => {
    expect(formatShortDate("2099-02-01T00:00:00.000Z", now)).toBe("Feb 1, 2099");
  });

  it("returns -- for unparseable input", () => {
    expect(formatShortDate("not-a-date", now)).toBe("--");
  });
});

describe("formatRelativeTime", () => {
  const now = Date.parse("2026-07-15T12:00:00.000Z");
  const before = (ms: number) => new Date(now - ms).toISOString();

  it("returns -- for null or unparseable input", () => {
    expect(formatRelativeTime(null, now)).toBe("--");
    expect(formatRelativeTime("not-a-date", now)).toBe("--");
  });

  it("buckets recent and future deltas as just now", () => {
    expect(formatRelativeTime(before(30_000), now)).toBe("just now");
    expect(formatRelativeTime(new Date(now + 5_000).toISOString(), now)).toBe("just now");
  });

  it("buckets minutes, hours, and days", () => {
    expect(formatRelativeTime(before(90_000), now)).toBe("1m ago");
    expect(formatRelativeTime(before(59 * 60_000), now)).toBe("59m ago");
    expect(formatRelativeTime(before(90 * 60_000), now)).toBe("1h ago");
    expect(formatRelativeTime(before(23.9 * 3_600_000), now)).toBe("23h ago");
    expect(formatRelativeTime(before(24 * 3_600_000), now)).toBe("1d ago");
    expect(formatRelativeTime(before(6.9 * 86_400_000), now)).toBe("6d ago");
  });

  it("delegates to formatShortDate at 7+ days", () => {
    const value = before(8 * 86_400_000);
    expect(formatRelativeTime(value, now)).toBe(formatShortDate(value, now));
  });
});

describe("compareFamiliesBy", () => {
  it("orders name ascending via localeCompare", () => {
    expect(
      compareFamiliesBy("name", family({ displayName: "Alpha" }), family({ displayName: "Beta" }))
    ).toBeLessThan(0);
  });

  it("orders spend ascending by spendSortUsd", () => {
    expect(
      compareFamiliesBy("spend", family({ spendSortUsd: 5 }), family({ spendSortUsd: 10 }))
    ).toBeLessThan(0);
  });

  it("orders credits ascending, null coerced to 0, tie-broken by balance", () => {
    expect(
      compareFamiliesBy("credits", family({ credits: null }), family({ credits: 5 }))
    ).toBeLessThan(0);
    expect(
      compareFamiliesBy(
        "credits",
        family({ credits: 0, balance: null }),
        family({ credits: 0, balance: 5 })
      )
    ).toBeLessThan(0);
  });

  it("orders services by renewal epoch, null as +Infinity, both-null guarded to 0 (NaN guard)", () => {
    expect(
      compareFamiliesBy(
        "services",
        family({ nextRenewalAt: "2030-01-01T00:00:00.000Z" }),
        family({ nextRenewalAt: null })
      )
    ).toBeLessThan(0);
    expect(
      compareFamiliesBy("services", family({ nextRenewalAt: null }), family({ nextRenewalAt: null }))
    ).toBe(0);
  });

  it("orders health ascending by criticalCount then alertCount", () => {
    expect(
      compareFamiliesBy(
        "health",
        family({ criticalCount: 0, alertCount: 1 }),
        family({ criticalCount: 1, alertCount: 0 })
      )
    ).toBeLessThan(0);
    expect(
      compareFamiliesBy(
        "health",
        family({ criticalCount: 0, alertCount: 1 }),
        family({ criticalCount: 0, alertCount: 2 })
      )
    ).toBeLessThan(0);
  });

  it("orders lastSync ascending, null sorts oldest", () => {
    expect(
      compareFamiliesBy(
        "lastSync",
        family({ latestFetchedAt: null }),
        family({ latestFetchedAt: "2026-01-01T00:00:00.000Z" })
      )
    ).toBeLessThan(0);
  });
});

describe("INITIAL_SORT_DIRECTION", () => {
  it("pins the exact per-column initial direction map so a refactor can't silently revert to uniform-asc", () => {
    expect(INITIAL_SORT_DIRECTION).toEqual({
      name: "asc",
      services: "asc",
      lastSync: "asc",
      spend: "desc",
      health: "desc",
      credits: "desc",
    });
  });
});

describe("familyMatchesFilter", () => {
  it("matches everything for 'all'", () => {
    expect(familyMatchesFilter(family(), "all")).toBe(true);
    expect(
      familyMatchesFilter(
        family({ alertCount: 0, activeCount: 0, incompleteCostCount: 0 }),
        "all"
      )
    ).toBe(true);
  });

  it("filters on open alerts", () => {
    expect(familyMatchesFilter(family({ alertCount: 1 }), "alerts")).toBe(true);
    expect(familyMatchesFilter(family({ alertCount: 0 }), "alerts")).toBe(false);
  });

  it("filters on active accounts", () => {
    expect(familyMatchesFilter(family({ activeCount: 1 }), "active")).toBe(true);
    expect(familyMatchesFilter(family({ activeCount: 0 }), "active")).toBe(false);
  });

  it("filters on incomplete cost coverage", () => {
    expect(familyMatchesFilter(family({ incompleteCostCount: 1 }), "incomplete")).toBe(true);
    expect(familyMatchesFilter(family({ incompleteCostCount: 0 }), "incomplete")).toBe(false);
  });
});

describe("emptyStateMessage", () => {
  it("returns the five exact strings from §3.6", () => {
    expect(emptyStateMessage("gpt", "all")).toBe(
      "No provider families match the current search."
    );
    expect(emptyStateMessage("gpt", "alerts")).toBe(
      "No provider families match the current search and filter."
    );
    expect(emptyStateMessage("", "alerts")).toBe(
      "No families with open alerts — all clear."
    );
    expect(emptyStateMessage("", "active")).toBe("No families with active accounts.");
    expect(emptyStateMessage("", "incomplete")).toBe(
      "No families with incomplete cost coverage."
    );
  });
});

describe("Lane B compact markup (default state: compact density, attention sort, All chip)", () => {
  it("renders a compact single-line Spend cell with a coverage dot, not the comfortable pill", () => {
    const html = renderWorkspace([provider("p1", { spentUsd: 42, spendCoverage: "complete" })]);
    const spendCell = extractTdInner(html, "Spend");
    expect(spendCell).toContain("h-2 w-2");
    expect(spendCell).not.toContain("rounded-full px-2 py-0.5");
  });

  it("keeps every compact cell to a single element child (mobile-grid wrapper contract)", () => {
    const html = renderWorkspace([provider("p1", { spentUsd: 42, spendCoverage: "complete" })]);
    for (const label of [
      "Provider family",
      "Spend",
      "Funds / quota",
      "Services",
      "Health",
      "Last sync",
    ]) {
      expect(hasSingleElementChild(extractTdInner(html, label))).toBe(true);
    }
  });

  it("defaults to Compact density (global), the All filter chip, and the Attention preset all pressed", () => {
    const html = renderWorkspace([provider("p1")]);
    expect(html).toContain('aria-label="Row density"');
    expect(html).toContain('aria-label="Filter provider families"');
    // Global display-density default is compact (Wave D / D3 unify).
    expect(html).toContain("Compact");
    expect((html.match(/aria-pressed="true"/g) ?? []).length).toBe(3);
  });

  it("renders all six sortable headers with aria-sort=\"none\" by default", () => {
    const html = renderWorkspace([provider("p1")]);
    expect((html.match(/aria-sort="none"/g) ?? []).length).toBe(6);
    expect(html).not.toContain('aria-sort="ascending"');
    expect(html).not.toContain('aria-sort="descending"');
  });

  it("still renders the non-aggregated caveat text in compact density", () => {
    const html = renderWorkspace([provider("account-one"), provider("account-two")]);
    expect(html).toContain("Account identity unresolved");
    expect(html).toContain("See exact account values below");
  });

  it("renders budget text visibly in the compact Spend cell", () => {
    const html = renderWorkspace([
      provider("p1", {
        spentUsd: 10,
        spendCoverage: "complete",
        plan: {
          fixedMonthlyCostUsd: null,
          monthlyBudgetUsd: 50,
          monthlyRequestLimit: null,
          renewalDate: null,
          billingInterval: "monthly",
          notes: null,
        },
      }),
    ]);
    const spendCell = extractTdInner(html, "Spend");
    expect(spendCell).toContain("$50.00 budget");
  });
});
