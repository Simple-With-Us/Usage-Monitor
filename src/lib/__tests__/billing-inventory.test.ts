import { describe, expect, it } from "vitest";
import {
  buildBillingInventory,
  type BillingInventoryProvider,
  type BillingInventorySubscription,
} from "@/lib/billing-inventory";

const NOW = Date.parse("2026-07-12T12:00:00.000Z");

function provider(
  overrides: Partial<BillingInventoryProvider> = {}
): BillingInventoryProvider {
  return {
    id: "provider-cloudflare",
    name: "cloudflare",
    displayName: "Cloudflare",
    type: "builtin",
    isActive: true,
    refreshIntervalMin: 60,
    spentUsd: 5,
    projectedEomUsd: 5,
    billingMode: "actual",
    plan: {
      fixedMonthlyCostUsd: null,
      monthlyBudgetUsd: 25,
      monthlyRequestLimit: null,
      renewalDate: null,
      billingInterval: "monthly",
    },
    latestSnapshot: {
      totalRequests: 1200,
      credits: null,
      fetchedAt: "2026-07-12T11:30:00.000Z",
    },
    externalBilling: [],
    ...overrides,
  };
}

function subscription(
  overrides: Partial<BillingInventorySubscription> = {}
): BillingInventorySubscription {
  return {
    id: "subscription-workers",
    name: "Cloudflare Workers",
    description: "Workers Paid",
    costUsd: 5,
    currency: "USD",
    interval: "monthly",
    intervalCount: 1,
    monthlyEquivalentUsd: 5,
    nextRenewalAt: "2026-07-15T00:00:00.000Z",
    autoRenew: true,
    status: "active",
    externalBillingSource: null,
    externalBillingId: null,
    knobEnv: { PROVIDER_QUOTA_WORKERS_REQUESTS: "10000000" },
    freeTierKnobEnv: { PROVIDER_QUOTA_WORKERS_REQUESTS: "100000" },
    provider: {
      id: "provider-cloudflare",
      name: "cloudflare",
      displayName: "Cloudflare",
    },
    project: null,
    ...overrides,
  };
}

describe("buildBillingInventory", () => {
  it("shows a locally tracked paid service with renewal and paid-tier capacity", () => {
    const inventory = buildBillingInventory([provider()], [subscription()], NOW);

    expect(inventory.items).toHaveLength(1);
    expect(inventory.items[0]).toMatchObject({
      serviceName: "Cloudflare Workers",
      tierName: "Workers Paid",
      provenance: "tracked",
      nextRenewalAt: "2026-07-15T00:00:00.000Z",
      monthlyEquivalentUsd: 5,
    });
    expect(inventory.items[0].capacityChanges).toEqual([
      expect.objectContaining({
        label: "Quota Workers Requests",
        freeTierValue: "100000",
        paidTierValue: "10000000",
      }),
    ]);
    expect(inventory.summary).toMatchObject({
      trackedSubscriptions: 1,
      monthlyRecurringUsd: 5,
      nextRenewalAt: "2026-07-15T00:00:00.000Z",
    });
  });

  it("merges an explicitly linked provider record instead of rendering or charging it twice", () => {
    const external = {
      source: "cloudflare-subscriptions",
      externalId: "cf-sub-1",
      kind: "subscription",
      planName: "Workers Paid",
      status: "active",
      amountUsd: 5,
      currency: "USD",
      billingInterval: "monthly",
      currentPeriodStart: "2026-07-01T00:00:00.000Z",
      currentPeriodEnd: "2026-08-01T00:00:00.000Z",
      nextRenewalAt: "2026-08-01T00:00:00.000Z",
      requestLimit: 10_000_000,
      requestLimitWindow: "month",
      spendLimitUsd: null,
      spendLimitWindow: null,
      syncedAt: "2026-07-12T11:00:00.000Z",
    };
    const inventory = buildBillingInventory(
      [provider({ externalBilling: [external] })],
      [
        subscription({
          externalBillingSource: external.source,
          externalBillingId: external.externalId,
        }),
      ],
      NOW
    );

    expect(inventory.items).toHaveLength(1);
    expect(inventory.items[0]).toMatchObject({
      provenance: "linked",
      source: "cloudflare-subscriptions",
      requestLimit: 10_000_000,
      requestUsage: null,
      creditsRemaining: null,
      spendMonthToDateUsd: null,
      nextRenewalAt: "2026-08-01T00:00:00.000Z",
    });
    expect(inventory.summary.automaticRecords).toBe(1);
    expect(inventory.summary.monthlyRecurringUsd).toBe(5);
  });

  it("preserves multiple automatically discovered provider services", () => {
    const record = (externalId: string, planName: string) => ({
      source: "cloudflare-subscriptions",
      externalId,
      kind: "subscription",
      planName,
      status: "active",
      amountUsd: 5,
      currency: "USD",
      billingInterval: "monthly",
      currentPeriodStart: "2026-07-01T00:00:00.000Z",
      currentPeriodEnd: "2026-08-01T00:00:00.000Z",
      nextRenewalAt: "2026-08-01T00:00:00.000Z",
      requestLimit: null,
      requestLimitWindow: null,
      spendLimitUsd: null,
      spendLimitWindow: null,
      syncedAt: "2026-07-12T11:00:00.000Z",
    });
    const inventory = buildBillingInventory(
      [
        provider({
          externalBilling: [
            record("workers", "Workers Paid"),
            record("images", "Cloudflare Images"),
          ],
        }),
      ],
      [],
      NOW
    );

    expect(inventory.items.map((item) => item.serviceName).sort()).toEqual([
      "Cloudflare Images",
      "Workers Paid",
    ]);
    expect(inventory.summary.automaticRecords).toBe(2);
    expect(inventory.summary.monthlyRecurringUsd).toBe(10);
  });

  it("uses provider-plan fields only as a fallback when no recurring service record exists", () => {
    const planProvider = provider({
      externalBilling: [],
      plan: {
        fixedMonthlyCostUsd: 19,
        monthlyBudgetUsd: 50,
        monthlyRequestLimit: 100_000,
        renewalDate: "2026-07-20T00:00:00.000Z",
        billingInterval: "monthly",
      },
    });
    const withFallback = buildBillingInventory([planProvider], [], NOW);
    expect(withFallback.items).toHaveLength(1);
    expect(withFallback.items[0]).toMatchObject({
      provenance: "provider-plan",
      monthlyEquivalentUsd: 19,
    });

    const withSubscription = buildBillingInventory(
      [planProvider],
      [subscription()],
      NOW
    );
    expect(withSubscription.items).toHaveLength(1);
    expect(withSubscription.items[0].provenance).toBe("tracked");

    const metadataOnly = buildBillingInventory(
      [
        provider({
          ...planProvider,
          externalBilling: [
            {
              source: "provider-quota",
              externalId: "quota",
              kind: "plan",
              serviceName: "API quota",
              planName: "Account limits",
              status: "active",
              amountUsd: null,
              currency: null,
              billingInterval: null,
              currentPeriodStart: null,
              currentPeriodEnd: "2026-08-01T00:00:00.000Z",
              nextRenewalAt: "2026-08-01T00:00:00.000Z",
              requestLimit: 100_000,
              requestLimitWindow: "month",
              spendLimitUsd: null,
              spendLimitWindow: null,
              rollupRole: "metadata",
              dateKind: "quota_reset",
              syncedAt: "2026-07-12T11:00:00.000Z",
            },
          ],
        }),
      ],
      [],
      NOW
    );
    expect(metadataOnly.items).toHaveLength(2);
    expect(metadataOnly.summary.monthlyRecurringUsd).toBe(19);
    expect(metadataOnly.summary.nextRenewalAt).toBe("2026-07-20T00:00:00.000Z");

    const consideringCandidate = buildBillingInventory(
      [planProvider],
      [subscription({ status: "considering" })],
      NOW
    );
    expect(consideringCandidate.items.map((item) => item.provenance).sort()).toEqual([
      "provider-plan",
      "tracked",
    ]);
    expect(consideringCandidate.summary.monthlyRecurringUsd).toBe(19);
  });

  it("keeps unknown-currency provider amounts out of USD summaries and links", () => {
    const external = {
      source: "provider-billing",
      externalId: "unknown-currency",
      kind: "subscription",
      planName: "Paid",
      status: "active",
      amountUsd: 5,
      currency: null,
      billingInterval: "monthly",
      currentPeriodStart: "2026-07-01T00:00:00.000Z",
      currentPeriodEnd: "2026-08-01T00:00:00.000Z",
      nextRenewalAt: "2026-08-01T00:00:00.000Z",
      requestLimit: null,
      requestLimitWindow: null,
      spendLimitUsd: null,
      spendLimitWindow: null,
      syncedAt: "2026-07-12T11:00:00.000Z",
    };
    const inventory = buildBillingInventory(
      [provider({ externalBilling: [external] })],
      [
        subscription({
          externalBillingSource: external.source,
          externalBillingId: external.externalId,
        }),
      ],
      NOW
    );

    expect(inventory.items).toHaveLength(2);
    expect(inventory.items.find((item) => item.provenance === "automatic")).toMatchObject({
      currency: "UNKNOWN",
      monthlyEquivalentUsd: null,
    });
    expect(inventory.summary.monthlyRecurringUsd).toBe(5);
  });

  it("shows a non-renewing term end and expires it from recurring totals after the term", () => {
    const activeTerm = buildBillingInventory(
      [provider()],
      [subscription({ autoRenew: false })],
      NOW
    );
    expect(activeTerm.items[0]).toMatchObject({
      status: "active",
      dateKind: "contract_end",
      nextRenewalAt: "2026-07-15T00:00:00.000Z",
    });
    expect(activeTerm.summary.nextRenewalAt).toBeNull();
    expect(activeTerm.summary.monthlyRecurringUsd).toBe(5);

    const expiredTerm = buildBillingInventory(
      [provider()],
      [
        subscription({
          autoRenew: false,
          nextRenewalAt: "2026-07-10T00:00:00.000Z",
        }),
      ],
      NOW
    );
    expect(expiredTerm.items[0].status).toBe("expired");
    expect(expiredTerm.summary.monthlyRecurringUsd).toBe(0);
  });

  it("does not let an expired local term hide an active linked provider service", () => {
    const external = {
      source: "cloudflare-subscriptions",
      externalId: "workers",
      kind: "subscription",
      serviceName: "Cloudflare Workers",
      planName: "Workers Paid",
      status: "active",
      amountUsd: 5,
      currency: "USD",
      billingInterval: "monthly",
      currentPeriodStart: "2026-07-01T00:00:00.000Z",
      currentPeriodEnd: "2026-08-01T00:00:00.000Z",
      nextRenewalAt: "2026-08-01T00:00:00.000Z",
      requestLimit: null,
      requestLimitWindow: null,
      spendLimitUsd: null,
      spendLimitWindow: null,
      syncedAt: "2026-07-12T11:00:00.000Z",
    };
    const inventory = buildBillingInventory(
      [provider({ externalBilling: [external] })],
      [
        subscription({
          autoRenew: false,
          nextRenewalAt: "2026-07-10T00:00:00.000Z",
          externalBillingSource: external.source,
          externalBillingId: external.externalId,
        }),
      ],
      NOW
    );

    expect(inventory.items).toHaveLength(2);
    expect(inventory.items.map((item) => item.status).sort()).toEqual([
      "active",
      "expired",
    ]);
    expect(inventory.items.map((item) => item.provenance).sort()).toEqual([
      "automatic",
      "tracked",
    ]);
  });

  it("keeps provider and local rows separate when an identity link no longer matches", () => {
    const external = {
      source: "cloudflare-subscriptions",
      externalId: "workers",
      kind: "subscription",
      serviceName: "Cloudflare Workers",
      planName: "Workers Paid",
      status: "active",
      amountUsd: 20,
      currency: "USD",
      billingInterval: "monthly",
      currentPeriodStart: "2026-07-01T00:00:00.000Z",
      currentPeriodEnd: "2026-08-01T00:00:00.000Z",
      nextRenewalAt: "2026-08-01T00:00:00.000Z",
      requestLimit: null,
      requestLimitWindow: null,
      spendLimitUsd: null,
      spendLimitWindow: null,
      rollupRole: "canonical",
      dateKind: "renewal",
      syncedAt: "2026-07-12T11:00:00.000Z",
    };
    const inventory = buildBillingInventory(
      [provider({ externalBilling: [external] })],
      [
        subscription({
          status: "canceled",
          costUsd: 5,
          monthlyEquivalentUsd: 5,
          externalBillingSource: external.source,
          externalBillingId: external.externalId,
        }),
      ],
      NOW
    );

    expect(inventory.items).toHaveLength(2);
    expect(inventory.items.map((item) => item.provenance).sort()).toEqual([
      "automatic",
      "tracked",
    ]);
    expect(inventory.items.find((item) => item.provenance === "automatic")).toMatchObject({
      amount: 20,
      status: "active",
    });
  });

  it("never consumes one provider record for more than one local subscription", () => {
    const external = {
      source: "cloudflare-subscriptions",
      externalId: "workers",
      kind: "subscription",
      planName: "Workers Paid",
      status: "active",
      amountUsd: 5,
      currency: "USD",
      billingInterval: "monthly",
      currentPeriodStart: "2026-07-01T00:00:00.000Z",
      currentPeriodEnd: "2026-08-01T00:00:00.000Z",
      nextRenewalAt: "2026-08-01T00:00:00.000Z",
      requestLimit: null,
      requestLimitWindow: null,
      spendLimitUsd: null,
      spendLimitWindow: null,
      syncedAt: "2026-07-12T11:00:00.000Z",
    };
    const linked = subscription({
      externalBillingSource: external.source,
      externalBillingId: external.externalId,
    });
    const inventory = buildBillingInventory(
      [provider({ externalBilling: [external] })],
      [linked, { ...linked, id: "duplicate-link", name: "Duplicate local row" }],
      NOW
    );

    expect(inventory.items).toHaveLength(2);
    expect(inventory.items.filter((item) => item.provenance === "linked")).toHaveLength(1);
    expect(inventory.items.filter((item) => item.provenance === "tracked")).toHaveLength(1);
  });

  it("does not promote a quota reset or billing-period boundary to the next renewal", () => {
    const inventory = buildBillingInventory(
      [
        provider({
          externalBilling: [
            {
              source: "provider-quota",
              externalId: "quota",
              kind: "account",
              serviceName: "API quota",
              planName: null,
              status: "active",
              amountUsd: null,
              currency: null,
              billingInterval: null,
              currentPeriodStart: null,
              currentPeriodEnd: "2026-07-13T00:00:00.000Z",
              nextRenewalAt: "2026-07-13T00:00:00.000Z",
              requestLimit: 100,
              requestLimitWindow: "day",
              spendLimitUsd: null,
              spendLimitWindow: null,
              dateKind: "quota_reset",
              syncedAt: "2026-07-12T11:00:00.000Z",
            },
          ],
        }),
      ],
      [],
      NOW
    );

    expect(inventory.items[0].nextRenewalAt).toBe("2026-07-13T00:00:00.000Z");
    expect(inventory.items[0].dateKind).toBe("quota_reset");
    expect(inventory.summary.nextRenewalAt).toBeNull();
    expect(inventory.summary.activeServices).toBe(0);
    expect(inventory.summary.automaticRecords).toBe(0);
  });

  it("does not count a pending provider billing placeholder as an active service", () => {
    const inventory = buildBillingInventory(
      [
        provider({
          externalBilling: [
            {
              source: "google-cloud-billing-export",
              externalId: "gemini-mtd:project-a",
              kind: "billing_period",
              serviceName: "Gemini API",
              planName: "Cloud Billing export",
              status: "pending",
              amountUsd: null,
              currency: "USD",
              billingInterval: null,
              currentPeriodStart: "2026-07-01T00:00:00.000Z",
              currentPeriodEnd: null,
              nextRenewalAt: null,
              requestLimit: null,
              requestLimitWindow: null,
              spendLimitUsd: null,
              spendLimitWindow: null,
              syncedAt: "2026-07-12T11:00:00.000Z",
            },
          ],
        }),
      ],
      [],
      NOW
    );

    expect(inventory.items).toHaveLength(1);
    expect(inventory.items[0].status).toBe("pending");
    expect(inventory.summary.automaticRecords).toBe(1);
    expect(inventory.summary.activeServices).toBe(0);
  });

  it("classifies providers with automatic capability but no synced record separately from manual providers", () => {
    const inventory = buildBillingInventory(
      [
        provider({ id: "openai", name: "openai", displayName: "OpenAI" }),
        provider({ id: "voyage", name: "voyage", displayName: "Voyage AI" }),
        provider({
          id: "relay",
          name: "ag***-s**c-relay",
          displayName: "Ag*** S**c Relay",
          type: "builtin",
        }),
      ],
      [],
      NOW
    );

    expect(inventory.coverage.find((entry) => entry.providerId === "openai")?.status).toBe("available");
    expect(inventory.coverage.find((entry) => entry.providerId === "voyage")?.status).toBe("manual");
    expect(inventory.coverage.find((entry) => entry.providerId === "relay")?.status).toBe("not-applicable");
  });

  it("does not present unavailable Anthropic individual-account billing as setup-ready", () => {
    const inventory = buildBillingInventory(
      [
        provider({
          id: "anthropic-individual",
          name: "anthropic",
          displayName: "Anthropic individual",
        }),
        provider({
          id: "anthropic-org",
          name: "anthropic",
          displayName: "Anthropic organization",
          anthropicAdminApiConfigured: true,
        }),
      ],
      [],
      NOW
    );

    expect(
      inventory.coverage.find(
        (entry) => entry.providerId === "anthropic-individual"
      )
    ).toMatchObject({
      status: "manual",
      summary: expect.stringMatching(/no organization Admin API key is configured/i),
    });
    expect(
      inventory.coverage.find((entry) => entry.providerId === "anthropic-org")
    ).toMatchObject({ status: "available" });
  });

  it("reports a stale linked provider confirmation instead of claiming no confirmation exists", () => {
    const external = {
      source: "cloudflare-subscriptions",
      externalId: "workers",
      kind: "subscription",
      planName: "Workers Paid",
      status: "active",
      amountUsd: 5,
      currency: "USD",
      billingInterval: "monthly",
      currentPeriodStart: "2026-07-01T00:00:00.000Z",
      currentPeriodEnd: "2026-08-01T00:00:00.000Z",
      nextRenewalAt: "2026-08-01T00:00:00.000Z",
      requestLimit: null,
      requestLimitWindow: null,
      spendLimitUsd: null,
      spendLimitWindow: null,
      syncedAt: "2026-07-10T00:00:00.000Z",
    };
    const inventory = buildBillingInventory(
      [provider({ externalBilling: [external] })],
      [
        subscription({
          externalBillingSource: external.source,
          externalBillingId: external.externalId,
        }),
      ],
      NOW
    );

    expect(inventory.coverage[0]).toMatchObject({
      status: "tracked",
      summary: expect.stringMatching(/taking a new snapshot/i),
    });
  });

  it("only labels coverage stale when the usage snapshot itself is old", () => {
    const external = {
      source: "cloudflare-subscriptions",
      externalId: "workers",
      kind: "subscription",
      planName: "Workers Paid",
      status: "active",
      amountUsd: 5,
      currency: "USD",
      billingInterval: "monthly",
      currentPeriodStart: "2026-07-01T00:00:00.000Z",
      currentPeriodEnd: "2026-08-01T00:00:00.000Z",
      nextRenewalAt: "2026-08-01T00:00:00.000Z",
      requestLimit: null,
      requestLimitWindow: null,
      spendLimitUsd: null,
      spendLimitWindow: null,
      syncedAt: "2026-07-10T00:00:00.000Z",
    };
    const inventory = buildBillingInventory(
      [
        provider({
          externalBilling: [external],
          latestSnapshot: {
            totalRequests: 10,
            credits: null,
            fetchedAt: "2026-07-10T00:00:00.000Z",
          },
        }),
      ],
      [
        subscription({
          externalBillingSource: external.source,
          externalBillingId: external.externalId,
        }),
      ],
      NOW
    );

    expect(inventory.coverage[0]).toMatchObject({
      status: "stale",
      summary: expect.stringMatching(/last usage snapshot is old/i),
    });
  });

  it("never presents a no-poll provider as fetchable or waiting for setup", () => {
    const inventory = buildBillingInventory(
      [
        provider({
          id: "fmp",
          name: "fmp",
          displayName: "FMP",
          type: "builtin",
          latestSnapshot: null,
          externalBilling: [],
        }),
      ],
      [],
      NOW
    );
    expect(inventory.coverage[0]).toMatchObject({
      status: "manual",
      summary: expect.stringMatching(/MANUALLY ONLY/i),
    });
  });
});
