import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { setupPrismaSqliteTestDb } from "./setup-test-db";
import type { SubscriptionInsightRow } from "../subscription-insights";

let dbPath: string;
let prisma: typeof import("@/lib/prisma").prisma;
let detectDuplicateSubscriptions: typeof import("../subscription-insights").detectDuplicateSubscriptions;
let detectPriceChanges: typeof import("../subscription-insights").detectPriceChanges;
let detectUnusedSubscriptions: typeof import("../subscription-insights").detectUnusedSubscriptions;
let loadSubscriptionInsightAlerts: typeof import("../subscription-insights").loadSubscriptionInsightAlerts;

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subscription-insights-test-"));
  dbPath = path.join(dir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.ENCRYPTION_KEY = "44".repeat(32);

  setupPrismaSqliteTestDb(dbPath);

  // subscription-insights.ts statically imports @/lib/prisma, which
  // instantiates the client at module load — so EVERY import of it (and of
  // prisma) must stay dynamic, after DATABASE_URL points at the temp schema
  // above. A static import would bind the client to the ambient DATABASE_URL
  // (works locally where dev.db has the schema; P2021 in CI where it doesn't).
  ({ prisma } = await import("@/lib/prisma"));
  ({
    detectDuplicateSubscriptions,
    detectPriceChanges,
    detectUnusedSubscriptions,
    loadSubscriptionInsightAlerts,
  } = await import("../subscription-insights"));
}, 60_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (dbPath && fs.existsSync(dbPath)) {
    fs.rmSync(dbPath, { force: true });
  }
  delete process.env.ENCRYPTION_KEY;
}, 30_000);

beforeEach(async () => {
  await prisma.externalUsageEvent.deleteMany();
  await prisma.providerExternalBilling.deleteMany();
  await prisma.subscription.deleteMany();
  await prisma.providerPlan.deleteMany();
  await prisma.provider.deleteMany();
});

function sub(overrides: Partial<SubscriptionInsightRow>): SubscriptionInsightRow {
  return {
    id: "sub-1",
    providerId: "prov-1",
    providerName: "Anthropic",
    name: "Claude Pro",
    status: "active",
    costUsd: 20,
    currency: "USD",
    interval: "monthly",
    intervalCount: 1,
    currentPeriodStart: new Date("2026-07-01T00:00:00.000Z"),
    lastChargedPeriodStart: new Date("2026-07-01T00:00:00.000Z"),
    externalBillingManaged: false,
    externalBillingSource: null,
    externalBillingId: null,
    ...overrides,
  };
}

describe("detectUnusedSubscriptions (S14a)", () => {
  it("flags an active, already-charged subscription with ~zero variable usage this period", () => {
    const findings = detectUnusedSubscriptions(
      [sub({})],
      new Map([["sub-1", 0]])
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      providerId: "prov-1",
      code: "unused_subscription",
      scope: "sub-1",
    });
    expect(findings[0]!.message).toContain("Claude Pro");
    expect(findings[0]!.message).toContain("$20.00");
    expect(findings[0]!.message).toContain("Anthropic");
  });

  it("does not flag a subscription with real usage, no charge yet, or a non-active status", () => {
    // Usage above the epsilon.
    expect(
      detectUnusedSubscriptions([sub({})], new Map([["sub-1", 3.5]]))
    ).toHaveLength(0);
    // Never charged: nothing paid for yet, "unused" would be premature.
    expect(
      detectUnusedSubscriptions([sub({ lastChargedPeriodStart: null })], new Map())
    ).toHaveLength(0);
    // Paused / considering / canceled subscriptions are out of scope.
    for (const status of ["paused", "considering", "canceled"]) {
      expect(
        detectUnusedSubscriptions([sub({ status })], new Map([["sub-1", 0]]))
      ).toHaveLength(0);
    }
  });
});

describe("detectDuplicateSubscriptions (S14b)", () => {
  it("flags two active owner subscriptions with identical amount/currency/cadence on one provider", () => {
    const findings = detectDuplicateSubscriptions([
      sub({ id: "sub-1", name: "Plan A" }),
      sub({ id: "sub-2", name: "Plan B" }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      providerId: "prov-1",
      code: "possible_duplicate_subscription",
    });
    expect(findings[0]!.message).toContain('"Plan A"');
    expect(findings[0]!.message).toContain('"Plan B"');
    // Scope is stable for the group (dedup-safe across ticks).
    expect(findings[0]!.scope).toBe("duplicate:2000:usd:monthly:1");
  });

  it("ignores differing amounts, cadences, providers, non-owner rows, and inactive rows", () => {
    // Different amount.
    expect(
      detectDuplicateSubscriptions([sub({ id: "a" }), sub({ id: "b", costUsd: 25 })])
    ).toHaveLength(0);
    // Different cadence.
    expect(
      detectDuplicateSubscriptions([sub({ id: "a" }), sub({ id: "b", intervalCount: 3 })])
    ).toHaveLength(0);
    // Different provider.
    expect(
      detectDuplicateSubscriptions([sub({ id: "a" }), sub({ id: "b", providerId: "prov-2" })])
    ).toHaveLength(0);
    // Auto-managed rows are one authority's data, not an owner mistake.
    expect(
      detectDuplicateSubscriptions([
        sub({ id: "a", externalBillingManaged: true }),
        sub({ id: "b", externalBillingManaged: true }),
      ])
    ).toHaveLength(0);
    // Inactive rows excluded.
    expect(
      detectDuplicateSubscriptions([sub({ id: "a" }), sub({ id: "b", status: "paused" })])
    ).toHaveLength(0);
  });
});

describe("detectPriceChanges (S14c)", () => {
  const now = new Date("2026-07-20T12:00:00.000Z");
  const linked = sub({
    externalBillingSource: "anthropic-billing",
    externalBillingId: "sub_123",
  });
  const externalRow = {
    providerId: "prov-1",
    source: "anthropic-billing",
    externalId: "sub_123",
    paidRecurringAuthoritative: true,
    status: "active",
    amountUsd: 25,
    currency: "USD",
    syncedAt: new Date("2026-07-20T10:00:00.000Z"),
  };
  const freshness = new Map([["prov-1", 24 * 60 * 60 * 1000]]);

  it("flags an owner-linked subscription whose fresh authoritative external term differs", () => {
    const findings = detectPriceChanges([linked], [externalRow], now, freshness);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      providerId: "prov-1",
      code: "price_change_detected",
      scope: "sub-1",
    });
    expect(findings[0]!.message).toContain("$20.00");
    expect(findings[0]!.message).toContain("$25.00");
  });

  it("stays silent when amounts match, the row is stale, non-authoritative, terminal, or the sub is managed", () => {
    // Same amount.
    expect(
      detectPriceChanges([linked], [{ ...externalRow, amountUsd: 20 }], now, freshness)
    ).toHaveLength(0);
    // Stale observation (outside freshness window).
    expect(
      detectPriceChanges(
        [linked],
        [{ ...externalRow, syncedAt: new Date("2026-07-18T10:00:00.000Z") }],
        now,
        freshness
      )
    ).toHaveLength(0);
    // Not authoritative.
    expect(
      detectPriceChanges(
        [linked],
        [{ ...externalRow, paidRecurringAuthoritative: false }],
        now,
        freshness
      )
    ).toHaveLength(0);
    // Terminal external status.
    expect(
      detectPriceChanges([linked], [{ ...externalRow, status: "canceled" }], now, freshness)
    ).toHaveLength(0);
    // Auto-managed rows are handled by the correction path, not this detector.
    expect(
      detectPriceChanges([sub({ ...linked, externalBillingManaged: true })], [externalRow], now, freshness)
    ).toHaveLength(0);
    // Unlinked rows have nothing to compare against.
    expect(
      detectPriceChanges([sub({})], [externalRow], now, freshness)
    ).toHaveLength(0);
  });
});

describe("loadSubscriptionInsightAlerts (integration)", () => {
  it("emits an unused_subscription alert for a charged subscription on a provider with zero usage", async () => {
    const provider = await prisma.provider.create({
      data: { name: "Anthropic", displayName: "Anthropic", type: "builtin", refreshIntervalMin: 60 },
    });
    await prisma.subscription.create({
      data: {
        providerId: provider.id,
        name: "Claude Pro",
        costUsd: 20,
        interval: "monthly",
        startDate: new Date("2026-06-01T00:00:00.000Z"),
        currentPeriodStart: new Date("2026-07-01T00:00:00.000Z"),
        nextRenewalAt: new Date("2026-08-01T00:00:00.000Z"),
        lastChargedPeriodStart: new Date("2026-07-01T00:00:00.000Z"),
        status: "active",
      },
    });

    const alerts = await loadSubscriptionInsightAlerts(new Date("2026-07-20T12:00:00.000Z"));
    const providerAlerts = alerts.get(provider.id) ?? [];
    expect(providerAlerts).toEqual([
      expect.objectContaining({
        code: "unused_subscription",
        severity: "info",
        scope: expect.any(String),
      }),
    ]);
  });

  it("does not flag the subscription when the provider has variable usage in the period", async () => {
    const provider = await prisma.provider.create({
      data: { name: "Anthropic", displayName: "Anthropic", type: "builtin", refreshIntervalMin: 60 },
    });
    await prisma.subscription.create({
      data: {
        providerId: provider.id,
        name: "Claude Pro",
        costUsd: 20,
        interval: "monthly",
        startDate: new Date("2026-06-01T00:00:00.000Z"),
        currentPeriodStart: new Date("2026-07-01T00:00:00.000Z"),
        nextRenewalAt: new Date("2026-08-01T00:00:00.000Z"),
        lastChargedPeriodStart: new Date("2026-07-01T00:00:00.000Z"),
        status: "active",
      },
    });
    await prisma.externalUsageEvent.create({
      data: {
        idempotencyKey: "usage-event-1",
        sourceApp: "test-producer",
        provider: "Anthropic",
        billingMode: "actual",
        metricType: "usage",
        confidence: "exact",
        costUsd: 12.5,
        occurredAt: new Date("2026-07-15T10:00:00.000Z"),
      },
    });

    const alerts = await loadSubscriptionInsightAlerts(new Date("2026-07-20T12:00:00.000Z"));
    expect(alerts.get(provider.id) ?? []).toHaveLength(0);
  });

  it("ignores subscriptions on inactive providers", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "Anthropic",
        displayName: "Anthropic",
        type: "builtin",
        refreshIntervalMin: 60,
        isActive: false,
      },
    });
    await prisma.subscription.create({
      data: {
        providerId: provider.id,
        name: "Claude Pro",
        costUsd: 20,
        interval: "monthly",
        startDate: new Date("2026-06-01T00:00:00.000Z"),
        currentPeriodStart: new Date("2026-07-01T00:00:00.000Z"),
        nextRenewalAt: new Date("2026-08-01T00:00:00.000Z"),
        lastChargedPeriodStart: new Date("2026-07-01T00:00:00.000Z"),
        status: "active",
      },
    });

    const alerts = await loadSubscriptionInsightAlerts(new Date("2026-07-20T12:00:00.000Z"));
    expect(alerts.size).toBe(0);
  });
});
