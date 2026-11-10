import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { initialCycle, isSubscriptionInterval } from "../subscriptions";
import { setupPrismaSqliteTestDb } from "./setup-test-db";

// Everything that transitively imports @/lib/prisma is loaded DYNAMICALLY after
// DATABASE_URL points at the test DB — otherwise the prisma singleton binds to
// the wrong database at module-load time (matches the retention-integration
// test's pattern).
let dbPath: string;
let prisma: typeof import("@/lib/prisma").prisma;
let planSubscriptionCharges: typeof import("../subscription-materializer").planSubscriptionCharges;
let materializeDueSubscriptions: typeof import("../subscription-materializer").materializeDueSubscriptions;
let computeProjectBudgetStatus: typeof import("../budget-status").computeProjectBudgetStatus;
let computeBudgetStatus: typeof import("../budget-status").computeBudgetStatus;
let quarantineLegacyMistralSpendLimitSnapshots: typeof import("../mistral-snapshot-quarantine").quarantineLegacyMistralSpendLimitSnapshots;
let putSubscription: typeof import("@/app/api/subscriptions/[id]/route").PUT;
let deleteSubscription: typeof import("@/app/api/subscriptions/[id]/route").DELETE;
let retractSubscriptionCharges: typeof import("../subscription-materializer").retractSubscriptionCharges;
let geminiBillingConfigFingerprint: typeof import("../gemini-key-status").geminiBillingConfigFingerprint;

const NOW = new Date("2026-07-15T12:00:00.000Z");

interface FakeSub {
  id: string;
  name: string;
  costUsd: number;
  currency: string;
  interval: string;
  intervalCount: number;
  projectId: string | null;
  autoRenew: boolean;
  currentPeriodStart: Date;
  nextRenewalAt: Date;
  lastChargedPeriodStart: Date | null;
  externalBillingManaged?: boolean;
  externalBillingSource?: string | null;
  externalBillingId?: string | null;
  provider: { name: string };
}

function fakeSubscription(overrides: Partial<FakeSub> = {}): FakeSub {
  const interval = overrides.interval ?? "monthly";
  const intervalCount = overrides.intervalCount ?? 1;
  const currentPeriodStart =
    overrides.currentPeriodStart ?? new Date("2026-07-01T00:00:00Z");
  return {
    id: "sub-1",
    name: "Test plan",
    costUsd: 20,
    currency: "USD",
    interval,
    intervalCount,
    projectId: "proj-1",
    autoRenew: true,
    currentPeriodStart,
    nextRenewalAt:
      overrides.nextRenewalAt ??
      initialCycle({
        startDate: currentPeriodStart,
        interval: isSubscriptionInterval(interval) ? interval : "monthly",
        intervalCount,
        anchorDay: null,
      }).nextRenewalAt,
    lastChargedPeriodStart: null,
    provider: { name: "anthropic" },
    ...overrides,
  };
}

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subscription-materializer-test-"));
  dbPath = path.join(dir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  setupPrismaSqliteTestDb(dbPath);

  ({ prisma } = await import("@/lib/prisma"));
  ({
    planSubscriptionCharges,
    materializeDueSubscriptions,
    retractSubscriptionCharges,
  } = await import("../subscription-materializer"));
  ({ computeProjectBudgetStatus, computeBudgetStatus } = await import("../budget-status"));
  ({ quarantineLegacyMistralSpendLimitSnapshots } = await import(
    "../mistral-snapshot-quarantine"
  ));
  ({ geminiBillingConfigFingerprint } = await import("../gemini-key-status"));
  ({ PUT: putSubscription, DELETE: deleteSubscription } = await import(
    "@/app/api/subscriptions/[id]/route"
  ));
}, 60_000);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await prisma?.$disconnect();
  if (dbPath && fs.existsSync(dbPath)) fs.rmSync(dbPath, { force: true });
});

describe("planSubscriptionCharges", () => {
  it("charges only the current period on first run", () => {
    const plan = planSubscriptionCharges(fakeSubscription(), new Date("2026-07-15T00:00:00Z"));
    expect(plan).not.toBeNull();
    expect(plan!.inputs).toHaveLength(1);
    expect(plan!.inputs[0].metricType).toBe("subscription");
    expect(plan!.inputs[0].projectId).toBe("proj-1");
    expect(plan!.inputs[0].costUsd).toBe(20);
    expect(plan!.inputs[0].confidence).toBe("estimated");
    expect(plan!.inputs[0].metadata).toMatchObject({
      modeled: true,
      chargeBasis: "modeled",
    });
    expect(plan!.currentPeriodStart.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(plan!.nextRenewalAt.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  it("honors an authoritative prorated end for the current provider-linked period", () => {
    const plan = planSubscriptionCharges(
      fakeSubscription({
        currentPeriodStart: new Date("2026-07-12T00:00:00Z"),
        nextRenewalAt: new Date("2026-08-01T00:00:00Z"),
      }),
      new Date("2026-07-15T00:00:00Z")
    );

    expect(plan?.inputs).toHaveLength(1);
    expect(plan?.inputs[0].windowStart?.toISOString()).toBe(
      "2026-07-12T00:00:00.000Z"
    );
    expect(plan?.inputs[0].windowEnd?.toISOString()).toBe(
      "2026-08-01T00:00:00.000Z"
    );
    expect(plan?.nextRenewalAt.toISOString()).toBe(
      "2026-08-01T00:00:00.000Z"
    );
  });

  it("backfills every elapsed period since currentPeriodStart", () => {
    const plan = planSubscriptionCharges(
      fakeSubscription({ currentPeriodStart: new Date("2026-05-01T00:00:00Z") }),
      new Date("2026-07-15T00:00:00Z")
    );
    expect(plan!.inputs).toHaveLength(3);
    expect(plan!.currentPeriodStart.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  it("returns null when the current period is already charged", () => {
    const plan = planSubscriptionCharges(
      fakeSubscription({ lastChargedPeriodStart: new Date("2026-07-01T00:00:00Z") }),
      new Date("2026-07-15T00:00:00Z")
    );
    expect(plan).toBeNull();
  });

  it("gives each period a distinct idempotency key", () => {
    const plan = planSubscriptionCharges(
      fakeSubscription({ currentPeriodStart: new Date("2026-05-01T00:00:00Z") }),
      new Date("2026-07-15T00:00:00Z")
    );
    const keys = new Set(plan!.inputs.map((i) => i.idempotencyKey));
    expect(keys.size).toBe(3);
  });

  it("charges a non-auto-renewing subscription only for its first term", () => {
    const plan = planSubscriptionCharges(
      fakeSubscription({
        autoRenew: false,
        currentPeriodStart: new Date("2026-05-01T00:00:00Z"),
      }),
      new Date("2026-07-15T00:00:00Z")
    );
    expect(plan!.inputs).toHaveLength(1);
    expect(plan!.currentPeriodStart.toISOString()).toBe("2026-05-01T00:00:00.000Z");
    expect(plan!.inputs[0].windowStart?.toISOString()).toBe(
      "2026-05-01T00:00:00.000Z"
    );
    expect(plan!.inputs[0].windowEnd?.toISOString()).toBe(
      "2026-06-01T00:00:00.000Z"
    );
  });
});

describe("materializeDueSubscriptions + project attribution (integration)", () => {
  beforeEach(async () => {
    await prisma.externalUsageEvent.deleteMany();
    await prisma.subscription.deleteMany();
    await prisma.providerProjectAllocation.deleteMany();
    await prisma.usageSnapshot.deleteMany();
    await prisma.providerPlan.deleteMany();
    await prisma.project.deleteMany();
    await prisma.provider.deleteMany();
  });

  async function createSubscription(providerId: string, extra: Record<string, unknown> = {}) {
    const { currentPeriodStart, nextRenewalAt } = initialCycle({
      startDate: new Date("2026-07-01T00:00:00Z"),
      interval: "monthly",
      intervalCount: 1,
      anchorDay: null,
    });
    return prisma.subscription.create({
      data: {
        providerId,
        name: "Claude Max",
        costUsd: 30,
        interval: "monthly",
        intervalCount: 1,
        startDate: new Date("2026-07-01T00:00:00Z"),
        currentPeriodStart,
        nextRenewalAt,
        ...extra,
      },
    });
  }

  it("skips non-USD subscriptions loudly instead of charging them as USD (S8)", async () => {
    const provider = await prisma.provider.create({
      data: { name: "eur-provider", displayName: "EUR Provider", type: "push", refreshIntervalMin: 60 },
    });
    const { currentPeriodStart, nextRenewalAt } = initialCycle({
      startDate: new Date("2026-07-01T00:00:00Z"),
      interval: "monthly",
      intervalCount: 1,
      anchorDay: null,
    });
    // API validation rejects non-USD creation (subscription-input.ts), so
    // this row simulates a legacy/direct-DB survivor.
    await prisma.subscription.create({
      data: {
        providerId: provider.id,
        name: "EUR plan",
        costUsd: 100,
        currency: "EUR",
        interval: "monthly",
        intervalCount: 1,
        startDate: new Date("2026-07-01T00:00:00Z"),
        currentPeriodStart,
        nextRenewalAt,
      },
    });
    await prisma.subscription.create({
      data: {
        providerId: provider.id,
        name: "USD plan",
        costUsd: 30,
        currency: "USD",
        interval: "monthly",
        intervalCount: 1,
        startDate: new Date("2026-07-01T00:00:00Z"),
        currentPeriodStart,
        nextRenewalAt,
      },
    });

    const result = await materializeDueSubscriptions(NOW);

    // The EUR row is suppressed and counted; the USD sibling still charges.
    expect(result.nonUsdSkipped).toBe(1);
    expect(result.charged).toBe(1);
    expect(result.eventsWritten).toBe(1);
    const events = await prisma.externalUsageEvent.findMany();
    expect(events).toHaveLength(1);
    expect(events[0].service).toBe("USD plan");
    expect(events[0].costUsd).toBe(30);

    // Re-running keeps the EUR row suppressed (watermark never advances).
    const second = await materializeDueSubscriptions(NOW);
    expect(second.nonUsdSkipped).toBe(1);
    expect(second.charged).toBe(0);
    expect(await prisma.externalUsageEvent.count()).toBe(1);
  });

  it("materializes one charge per period and attributes it to the project budget", async () => {
    const provider = await prisma.provider.create({
      data: { name: "anthropic", displayName: "Anthropic", type: "push", refreshIntervalMin: 60 },
    });
    const project = await prisma.project.create({
      data: { name: "Socratic Trade", monthlyBudgetUsd: 100 },
    });
    const { currentPeriodStart, nextRenewalAt } = initialCycle({
      startDate: new Date("2026-07-01T00:00:00Z"),
      interval: "monthly",
      intervalCount: 1,
      anchorDay: null,
    });
    await prisma.subscription.create({
      data: {
        providerId: provider.id,
        projectId: project.id,
        name: "Claude Max",
        costUsd: 30,
        interval: "monthly",
        intervalCount: 1,
        startDate: new Date("2026-07-01T00:00:00Z"),
        currentPeriodStart,
        nextRenewalAt,
      },
    });

    const first = await materializeDueSubscriptions(NOW);
    expect(first.charged).toBe(1);
    expect(first.eventsWritten).toBe(1);

    const events = await prisma.externalUsageEvent.findMany();
    expect(events).toHaveLength(1);
    expect(events[0].metricType).toBe("subscription");
    expect(events[0].projectId).toBe(project.id);
    expect(events[0].costUsd).toBe(30);

    // Re-running is idempotent: no new charge for the same period.
    const second = await materializeDueSubscriptions(NOW);
    expect(second.eventsWritten).toBe(0);
    expect(await prisma.externalUsageEvent.count()).toBe(1);

    // The subscription cost shows up as direct project spend.
    const status = await computeProjectBudgetStatus(NOW);
    const projStatus = status.projects.find((p) => p.id === project.id);
    expect(projStatus?.directUsd).toBeCloseTo(30);
    expect(projStatus?.spentUsd).toBeCloseTo(30);
  });

  it("adds a subscription fee ON TOP of a poll-tracked provider's snapshot cost", async () => {
    // Regression: max(snapshot, pushed) must not swallow a disjoint subscription
    // fee. Provider has a $80 metered snapshot AND a $30 subscription -> $110.
    const provider = await prisma.provider.create({
      data: {
        name: "openai",
        displayName: "OpenAI",
        type: "builtin",
        refreshIntervalMin: 60,
        plan: { create: { billingMode: "actual", monthlyBudgetUsd: 200 } },
      },
    });
    await prisma.usageSnapshot.create({
      data: { providerId: provider.id, fetchedAt: NOW, totalCost: 80 },
    });
    await createSubscription(provider.id);

    await materializeDueSubscriptions(NOW);

    const status = await computeBudgetStatus(NOW);
    const prov = status.providers.find((p) => p.id === provider.id)!;
    expect(prov.spentUsd).toBeCloseTo(110);
    expect(prov.fixedAccruedUsd).toBeCloseTo(30);
    // The $30 subscription is a discrete fixed charge; only the $80 metered
    // portion is extrapolated over the remainder of July.
    expect(prov.projectedEomUsd).toBeCloseTo(190);
  });

  it("keeps Claude's API-equivalent estimate out of cash spend and project budgets", async () => {
    // Regression fixture for the user's asserted target scenario. The $9k
    // Claude Code value models historical OTLP rows that were stored as
    // billingMode=actual; the exact source/service identity still makes it
    // analytics-only. This fixture does not assert the live subscription state.
    const provider = await prisma.provider.create({
      data: {
        name: "anthropic",
        displayName: "Anthropic",
        type: "push",
        refreshIntervalMin: 60,
        plan: { create: { billingMode: "actual", monthlyBudgetUsd: 500 } },
      },
    });
    const project = await prisma.project.create({
      data: { name: "Coding", monthlyBudgetUsd: 500 },
    });
    await prisma.providerProjectAllocation.create({
      data: { providerId: provider.id, projectId: project.id, percentage: 100 },
    });
    await prisma.usageSnapshot.create({
      data: { providerId: provider.id, fetchedAt: NOW, totalCost: 65 },
    });
    await createSubscription(provider.id, {
      name: "Claude Max account A",
      costUsd: 200,
      projectId: project.id,
    });
    await createSubscription(provider.id, {
      name: "Claude Max account B",
      costUsd: 200,
      projectId: project.id,
    });
    await prisma.externalUsageEvent.create({
      data: {
        idempotencyKey: "historical-claude-api-equivalent-estimate",
        sourceApp: "claude-code",
        provider: "anthropic",
        service: "claude-code",
        projectId: project.id,
        billingMode: "actual",
        metricType: "cost",
        costUsd: 9_000,
        occurredAt: NOW,
      },
    });

    await materializeDueSubscriptions(NOW);
    const status = await computeProjectBudgetStatus(NOW);
    const anthropic = status.providers.find((row) => row.id === provider.id)!;
    const coding = status.projects.find((row) => row.id === project.id)!;

    expect(anthropic).toMatchObject({
      snapshotCostUsd: 65,
      pushedMonthToDateUsd: 400,
      subscriptionMonthToDateUsd: 400,
      estimatedApiEquivalentUsd: 9_000,
      fixedAccruedUsd: 400,
      spentUsd: 465,
      status: "warning",
    });
    expect(anthropic.alerts.map((alert) => alert.code)).toContain("budget_warning");
    expect(anthropic.alerts.map((alert) => alert.code)).not.toContain("budget_exceeded");
    expect(coding).toMatchObject({
      directUsd: 400,
      allocatedUsd: 65,
      spentUsd: 465,
      status: "warning",
    });
    expect(status.summary).toMatchObject({
      totalSpentUsd: 465,
      estimatedApiEquivalentUsd: 9_000,
    });
  });

  it("max-reconciles prepaid receipt cash with observed usage and adds the subscription period", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "anthropic",
        displayName: "Anthropic individual",
        type: "push",
        refreshIntervalMin: 60,
      },
    });
    await prisma.usageSnapshot.create({
      data: { providerId: provider.id, fetchedAt: NOW, totalCost: 42 },
    });
    await prisma.externalUsageEvent.createMany({
      data: [
        {
          idempotencyKey: `billing-receipt:v1:${"a".repeat(64)}`,
          sourceApp: "billing-receipt-import",
          provider: "anthropic",
          service: "api-prepaid-funding",
          label: "receipt_cash_paid",
          keyRef: `provider:${provider.id}:billing-receipt:${"a".repeat(64)}`,
          billingMode: "actual",
          metricType: "cost",
          unit: "usd",
          confidence: "actual",
          costUsd: 47.25,
          occurredAt: NOW,
        },
        {
          idempotencyKey: `billing-receipt:v1:${"d".repeat(64)}`,
          sourceApp: "billing-receipt-import",
          provider: "anthropic",
          service: "api-prepaid-funding",
          label: "receipt_cash_paid",
          keyRef: `provider:${provider.id}:billing-receipt:${"d".repeat(64)}`,
          billingMode: "actual",
          metricType: "cost",
          unit: "usd",
          confidence: "actual",
          costUsd: 19,
          occurredAt: new Date("2026-06-30T23:59:59.999Z"),
        },
        {
          idempotencyKey: `billing-receipt:v1:${"e".repeat(64)}`,
          sourceApp: "billing-receipt-import",
          provider: "anthropic",
          service: "api-prepaid-funding",
          label: "receipt_cash_paid",
          keyRef: `provider:${provider.id}:billing-receipt:${"e".repeat(64)}`,
          billingMode: "actual",
          metricType: "cost",
          unit: "usd",
          confidence: "actual",
          costUsd: 91,
          occurredAt: new Date("2026-07-15T12:06:00.000Z"),
        },
        {
          idempotencyKey: "observed-api-usage-budget-test",
          sourceApp: "socratic-trade",
          provider: "anthropic",
          service: "messages",
          billingMode: "actual",
          metricType: "cost",
          costUsd: 45,
          occurredAt: NOW,
        },
        {
          idempotencyKey: "claude-estimate-budget-test",
          sourceApp: "claude-code",
          provider: "anthropic",
          service: "claude-code",
          billingMode: "estimated",
          metricType: "cost",
          costUsd: 9_000,
          occurredAt: NOW,
        },
      ],
    });
    await createSubscription(provider.id, { costUsd: 200 });
    await materializeDueSubscriptions(NOW);

    const status = await computeBudgetStatus(NOW);
    const anthropic = status.providers.find((row) => row.id === provider.id)!;
    expect(anthropic).toMatchObject({
      receiptCashPaidUsd: 47.25,
      receiptCashEventCount: 1,
      observedVariableUsageUsd: 45,
      subscriptionMonthToDateUsd: 200,
      fixedAccruedUsd: 200,
      estimatedApiEquivalentUsd: 9_000,
      // Prepaid receipt cash is funding, not consumption — spentUsd uses usage only.
      spentUsd: 245,
      // S2: receipts no longer floor the projection. With usage observed on a
      // single day (< 5 nonzero days → linear forecast): $45/15.5d*31d = $90
      // variable + $200 fixed. Pre-fix this was 247.25 (receipt-floored).
      projectedEomUsd: 290,
      spendCoverage: "complete",
    });
  });

  it("keeps priced pushed-only Anthropic cash spend explicitly incomplete", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "anthropic",
        displayName: "Anthropic individual",
        type: "builtin",
        refreshIntervalMin: 60,
      },
    });
    await prisma.externalUsageEvent.create({
      data: {
        idempotencyKey: "anthropic-individual-priced-request",
        sourceApp: "socratic-trade",
        provider: "anthropic",
        service: "claude-api",
        billingMode: "actual",
        metricType: "cost",
        costUsd: 4.13,
        occurredAt: NOW,
      },
    });

    const status = await computeBudgetStatus(NOW);
    const anthropic = status.providers.find((row) => row.id === provider.id)!;

    expect(anthropic).toMatchObject({
      snapshotCostUsd: null,
      pushedMonthToDateUsd: 4.13,
      pushedCostCoverage: "complete",
      spendCoverage: "partial",
      spentUsd: 4.13,
    });
  });

  it("keeps priced pushed-only Mistral cash spend explicitly incomplete", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "mistral",
        displayName: "Mistral pushed usage",
        type: "builtin",
        refreshIntervalMin: 60,
      },
    });
    await prisma.externalUsageEvent.create({
      data: {
        idempotencyKey: "mistral-priced-request-without-authoritative-total",
        sourceApp: "congress-trade",
        provider: "mistral",
        service: "mistral-api",
        billingMode: "actual",
        metricType: "cost",
        costUsd: 6.25,
        occurredAt: NOW,
      },
    });

    const status = await computeBudgetStatus(NOW);
    const mistral = status.providers.find((row) => row.id === provider.id)!;
    expect(mistral).toMatchObject({
      snapshotCostUsd: null,
      pushedMonthToDateUsd: 6.25,
      pushedCostCoverage: "complete",
      spendCoverage: "partial",
      spentUsd: 6.25,
    });
  });

  it("dedupes a provider-reported fixed fee against its local manual subscription", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "cloudflare",
        displayName: "Cloudflare",
        type: "builtin",
        refreshIntervalMin: 60,
        plan: { create: { billingMode: "actual", monthlyBudgetUsd: 200 } },
      },
    });
    await prisma.usageSnapshot.create({
      data: {
        providerId: provider.id,
        fetchedAt: NOW,
        totalCost: 35,
        fixedCostIncludedUsd: 30,
      },
    });
    await prisma.providerExternalBilling.create({
      data: {
        providerId: provider.id,
        source: "cloudflare-subscriptions",
        externalId: "pro-plan",
        kind: "subscription",
        planName: "Pro",
        status: "active",
        amountUsd: 30,
        currency: "USD",
        billingInterval: "monthly",
        currentPeriodStart: new Date("2026-07-01T00:00:00Z"),
        syncedAt: NOW,
      },
    });
    await createSubscription(provider.id, {
      externalBillingSource: "cloudflare-subscriptions",
      externalBillingId: "pro-plan",
    });
    await materializeDueSubscriptions(NOW);

    const status = await computeBudgetStatus(NOW);
    const prov = status.providers.find((p) => p.id === provider.id)!;
    expect(prov.snapshotFixedCostIncludedUsd).toBe(30);
    expect(prov.subscriptionMonthToDateUsd).toBe(30);
    expect(prov.linkedFixedDedupeUsd).toBe(30);
    expect(prov.fixedCostConflict).toBe(false);
    expect(prov.fixedAccruedUsd).toBe(30);
    expect(prov.spentUsd).toBe(35);
  });

  it("does not dedupe a legacy linked charge with a different provider period end", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "cloudflare",
        displayName: "Cloudflare",
        type: "builtin",
        refreshIntervalMin: 60,
        plan: { create: { billingMode: "actual", monthlyBudgetUsd: 200 } },
      },
    });
    await prisma.usageSnapshot.create({
      data: {
        providerId: provider.id,
        fetchedAt: NOW,
        totalCost: 35,
        fixedCostIncludedUsd: 30,
      },
    });
    await prisma.providerExternalBilling.create({
      data: {
        providerId: provider.id,
        source: "cloudflare-subscriptions",
        externalId: "shifted-pro-plan",
        kind: "subscription",
        planName: "Pro",
        status: "active",
        amountUsd: 30,
        currency: "USD",
        billingInterval: "monthly",
        currentPeriodStart: new Date("2026-07-01T00:00:00Z"),
        currentPeriodEnd: new Date("2026-07-20T00:00:00Z"),
        syncedAt: NOW,
      },
    });
    await createSubscription(provider.id, {
      externalBillingSource: "cloudflare-subscriptions",
      externalBillingId: "shifted-pro-plan",
    });
    await materializeDueSubscriptions(NOW);

    const status = await computeBudgetStatus(NOW);
    const result = status.providers.find((item) => item.id === provider.id)!;
    expect(result.subscriptionMonthToDateUsd).toBe(30);
    expect(result.linkedFixedDedupeUsd).toBe(0);
    expect(result.fixedCostConflict).toBe(true);
    expect(result.spentUsd).toBe(65);
  });

  it("never dedupes equal-priced fixed costs without an explicit billing identity link", async () => {
    const provider = await prisma.provider.create({
      data: { name: "same-price", displayName: "Same Price", type: "builtin" },
    });
    await prisma.usageSnapshot.create({
      data: {
        providerId: provider.id,
        fetchedAt: NOW,
        totalCost: 35,
        fixedCostIncludedUsd: 30,
      },
    });
    await prisma.providerExternalBilling.create({
      data: {
        providerId: provider.id,
        source: "provider-plans",
        externalId: "plan-a",
        kind: "subscription",
        status: "active",
        amountUsd: 30,
        currency: "USD",
        billingInterval: "monthly",
        currentPeriodStart: new Date("2026-07-01T00:00:00Z"),
        syncedAt: NOW,
      },
    });
    await createSubscription(provider.id);
    await materializeDueSubscriptions(NOW);

    const status = await computeBudgetStatus(NOW);
    const result = status.providers.find((item) => item.id === provider.id)!;
    expect(result.linkedFixedDedupeUsd).toBe(0);
    expect(result.fixedCostConflict).toBe(true);
    expect(result.spentUsd).toBe(65);
  });

  it("carries forward the latest compatible MTD cost through a partial snapshot", async () => {
    const provider = await prisma.provider.create({
      data: { name: "partial-cost", displayName: "Partial Cost", type: "builtin" },
    });
    await prisma.usageSnapshot.createMany({
      data: [
        {
          providerId: provider.id,
          fetchedAt: new Date("2026-07-10T00:00:00Z"),
          totalCost: 50,
          costWindowStart: new Date("2026-07-01T00:00:00Z"),
          costScope: "calendar_month_to_date",
        },
        {
          providerId: provider.id,
          fetchedAt: NOW,
          totalCost: null,
          balance: 12,
        },
      ],
    });

    const status = await computeBudgetStatus(NOW);
    const result = status.providers.find((item) => item.id === provider.id)!;
    expect(result.snapshotCostUsd).toBe(50);
    expect(result.snapshotCostFetchedAt).toBe("2026-07-10T00:00:00.000Z");
    expect(result.spentUsd).toBe(50);
  });

  it("quarantines only legacy Mistral spend-limit-derived cash without needing a successful poll", async () => {
    const provider = await prisma.provider.create({
      data: { name: "mistral", displayName: "Mistral", type: "builtin" },
    });
    const currentlyUnauthorizedProvider = await prisma.provider.create({
      data: { name: "mistral", displayName: "Mistral 401", type: "builtin" },
    });
    const unrelatedBuiltinProvider = await prisma.provider.create({
      data: { name: "mistral", displayName: "Other Mistral Cost", type: "builtin" },
    });
    const customProvider = await prisma.provider.create({
      data: { name: "mistral", displayName: "Custom Mistral", type: "custom" },
    });
    const windowStart = new Date("2026-07-01T00:00:00Z");
    const windowEnd = new Date("2026-07-10T00:00:00Z");
    const legacyRawData = {
      usage: {
        start_date: windowStart.toISOString(),
        end_date: windowEnd.toISOString(),
        currency: "USD",
      },
      spendLimit: {
        limits: { completion: { total_usage: 12, usage: 11 } },
      },
      capabilities: { actualCost: true },
    };
    const legacySnapshot = await prisma.usageSnapshot.create({
      data: {
        providerId: provider.id,
        fetchedAt: new Date("2026-07-10T00:01:00Z"),
        balance: 88,
        totalCost: 12,
        costWindowStart: windowStart,
        costWindowEnd: windowEnd,
        costScope: "calendar_month_to_date",
        credits: 88,
        rawData: legacyRawData,
      },
    });
    await prisma.usageSnapshot.create({
      data: {
        providerId: provider.id,
        fetchedAt: NOW,
        totalCost: null,
        rawData: {
          usage: {
            start_date: windowStart.toISOString(),
            end_date: NOW.toISOString(),
            currency: "USD",
          },
          capabilities: { actualCost: false },
        },
      },
    });
    const unauthorizedLegacySnapshot = await prisma.usageSnapshot.create({
      data: {
        providerId: currentlyUnauthorizedProvider.id,
        fetchedAt: new Date("2026-07-10T00:01:00Z"),
        balance: 88,
        totalCost: 12,
        costWindowStart: windowStart,
        costWindowEnd: windowEnd,
        costScope: "calendar_month_to_date",
        credits: 88,
        rawData: legacyRawData,
      },
    });
    const customSnapshot = await prisma.usageSnapshot.create({
      data: {
        providerId: customProvider.id,
        fetchedAt: new Date("2026-07-10T00:01:00Z"),
        balance: 88,
        totalCost: 12,
        costWindowStart: windowStart,
        costWindowEnd: windowEnd,
        costScope: "calendar_month_to_date",
        credits: 88,
        rawData: legacyRawData,
      },
    });
    const unrelatedBuiltinSnapshot = await prisma.usageSnapshot.create({
      data: {
        providerId: unrelatedBuiltinProvider.id,
        fetchedAt: new Date("2026-07-10T00:01:00Z"),
        totalCost: 12,
        costWindowStart: windowStart,
        costWindowEnd: windowEnd,
        costScope: "calendar_month_to_date",
        rawData: {
          ...legacyRawData,
          capabilities: { actualCost: false },
        },
      },
    });
    const legacyExternalBilling = await prisma.providerExternalBilling.create({
      data: {
        providerId: currentlyUnauthorizedProvider.id,
        source: "mistral-usage-billing",
        externalId: "2026-07",
        kind: "billing_period",
        planName: "Mistral organization usage",
        status: "active",
        amountUsd: 12,
        currency: "USD",
        currentPeriodStart: windowStart,
        currentPeriodEnd: windowEnd,
        syncedAt: new Date("2026-07-10T00:01:00Z"),
      },
    });
    const unrelatedExternalBilling = await prisma.providerExternalBilling.create({
      data: {
        providerId: currentlyUnauthorizedProvider.id,
        source: "mistral-usage-billing",
        externalId: "other",
        kind: "billing_period",
        planName: "Owner-entered Mistral billing evidence",
        status: "active",
        amountUsd: 12,
        currency: "USD",
        currentPeriodStart: windowStart,
        currentPeriodEnd: windowEnd,
        syncedAt: new Date("2026-07-10T00:01:00Z"),
      },
    });

    // Read-time defense is immediate: the newer safe null wins even before a
    // scheduler maintenance pass can correct historical storage.
    const beforeMaintenance = await computeBudgetStatus(NOW);
    expect(
      beforeMaintenance.providers.find((item) => item.id === provider.id)
        ?.snapshotCostUsd
    ).toBeNull();
    expect(
      beforeMaintenance.providers.find(
        (item) => item.id === currentlyUnauthorizedProvider.id
      )?.snapshotCostUsd
    ).toBeNull();

    const first = await quarantineLegacyMistralSpendLimitSnapshots();
    const second = await quarantineLegacyMistralSpendLimitSnapshots();
    expect(first).toMatchObject({
      quarantined: 2,
      externalBillingQuarantined: 1,
      truncated: false,
    });
    expect(second).toMatchObject({
      quarantined: 0,
      externalBillingQuarantined: 0,
      truncated: false,
    });
    expect(
      await prisma.usageSnapshot.findUniqueOrThrow({
        where: { id: legacySnapshot.id },
        select: {
          balance: true,
          totalCost: true,
          costWindowStart: true,
          costScope: true,
          credits: true,
        },
      })
    ).toEqual({
      balance: null,
      totalCost: null,
      costWindowStart: null,
      costScope: "unknown",
      credits: null,
    });
    expect(
      await prisma.usageSnapshot.findUniqueOrThrow({
        where: { id: unauthorizedLegacySnapshot.id },
        select: { balance: true, totalCost: true, credits: true },
      })
    ).toEqual({ balance: null, totalCost: null, credits: null });
    expect(
      await prisma.usageSnapshot.findUniqueOrThrow({
        where: { id: customSnapshot.id },
        select: { balance: true, totalCost: true, credits: true },
      })
    ).toEqual({ balance: 88, totalCost: 12, credits: 88 });
    expect(
      await prisma.usageSnapshot.findUniqueOrThrow({
        where: { id: unrelatedBuiltinSnapshot.id },
        select: { totalCost: true },
      })
    ).toEqual({ totalCost: 12 });
    expect(
      await prisma.providerExternalBilling.findUniqueOrThrow({
        where: { id: legacyExternalBilling.id },
        select: { amountUsd: true, status: true, rollupRole: true },
      })
    ).toEqual({
      amountUsd: null,
      status: "cost_unavailable",
      rollupRole: "canonical",
    });
    expect(
      await prisma.providerExternalBilling.findUniqueOrThrow({
        where: { id: unrelatedExternalBilling.id },
        select: { amountUsd: true, status: true, rollupRole: true },
      })
    ).toEqual({ amountUsd: 12, status: "active", rollupRole: null });

    const afterMaintenance = await computeBudgetStatus(NOW);
    expect(
      afterMaintenance.providers.find((item) => item.id === provider.id)
        ?.snapshotCostUsd
    ).toBeNull();
    expect(
      afterMaintenance.providers.find(
        (item) => item.id === currentlyUnauthorizedProvider.id
      )?.snapshotCostUsd
    ).toBeNull();
  });

  it("marks last-known Gemini cost partial after a newer billing failure", async () => {
    const billingConfig = {
      billingDataset: "billing-project.billing_export",
      googleProjectId: "gemini-production",
      serviceAccountJson: "test-service-account-json",
    };
    const provider = await prisma.provider.create({
      data: {
        name: "google-ai",
        displayName: "Google AI",
        type: "builtin",
        config: billingConfig,
      },
    });
    const configFingerprint = geminiBillingConfigFingerprint(billingConfig);
    await prisma.usageSnapshot.createMany({
      data: [
        {
          providerId: provider.id,
          fetchedAt: new Date("2026-07-10T00:00:00Z"),
          totalCost: 50,
          costWindowStart: new Date("2026-07-01T00:00:00Z"),
          costScope: "calendar_month_to_date",
          rawData: {
            billing: {
              configured: true,
              status: "ready",
              configFingerprint,
            },
          },
        },
        {
          providerId: provider.id,
          fetchedAt: NOW,
          totalCost: null,
          rawData: {
            billing: {
              configured: true,
              status: "error",
              errorCode: "HTTP_ERROR",
              httpStatus: 503,
              retryable: true,
              configFingerprint,
            },
          },
        },
      ],
    });

    const status = await computeBudgetStatus(NOW);
    const result = status.providers.find((item) => item.id === provider.id)!;

    expect(result.snapshotCostUsd).toBe(50);
    expect(result.snapshotCostFetchedAt).toBe("2026-07-10T00:00:00.000Z");
    expect(result.spentUsd).toBe(50);
    expect(result.spendCoverage).toBe("partial");
    expect(result.alerts).toContainEqual(
      expect.objectContaining({
        code: "billing_sync_incomplete",
        severity: "warning",
      })
    );
  });

  it("quarantines Gemini cost from a previous billing configuration", async () => {
    const previousConfig = {
      billingDataset: "billing-project.billing_export",
      googleProjectId: "old-project",
      serviceAccountJson: "old-test-service-account-json",
    };
    const currentConfig = {
      ...previousConfig,
      googleProjectId: "current-project",
      serviceAccountJson: "current-test-service-account-json",
    };
    const provider = await prisma.provider.create({
      data: {
        name: "google-ai",
        displayName: "Google AI",
        type: "builtin",
        config: currentConfig,
      },
    });
    await prisma.usageSnapshot.createMany({
      data: [
        {
          providerId: provider.id,
          fetchedAt: new Date("2026-07-10T00:00:00Z"),
          totalCost: 50,
          costWindowStart: new Date("2026-07-01T00:00:00Z"),
          costScope: "calendar_month_to_date",
          rawData: {
            billing: {
              configured: true,
              status: "ready",
              configFingerprint:
                geminiBillingConfigFingerprint(previousConfig),
            },
          },
        },
        {
          providerId: provider.id,
          fetchedAt: NOW,
          totalCost: null,
          rawData: {
            billing: {
              configured: true,
              status: "error",
              errorCode: "HTTP_ERROR",
              httpStatus: 503,
              retryable: true,
              configFingerprint:
                geminiBillingConfigFingerprint(currentConfig),
            },
          },
        },
      ],
    });

    const status = await computeBudgetStatus(NOW);
    const result = status.providers.find((item) => item.id === provider.id)!;

    expect(result.snapshotCostUsd).toBeNull();
    expect(result.snapshotCostFetchedAt).toBeNull();
    expect(result.spentUsd).toBe(0);
    expect(result.spendCoverage).toBe("unknown");
    expect(result.alerts).toContainEqual(
      expect.objectContaining({
        code: "billing_sync_incomplete",
        severity: "warning",
        message: expect.stringContaining("prior-configuration cost is excluded"),
      })
    );
  });

  it("quarantines prior Gemini cost after billing configuration is removed", async () => {
    const previousConfig = {
      billingDataset: "billing-project.billing_export",
      googleProjectId: "old-project",
      serviceAccountJson: "old-test-service-account-json",
    };
    const provider = await prisma.provider.create({
      data: {
        name: "google-ai",
        displayName: "Google AI",
        type: "builtin",
        config: { statusKeyRef: "gemini-primary" },
      },
    });
    await prisma.providerPlan.create({
      data: { providerId: provider.id, monthlyBudgetUsd: 10 },
    });
    await prisma.usageSnapshot.create({
      data: {
        providerId: provider.id,
        fetchedAt: new Date("2026-07-10T00:00:00Z"),
        totalCost: 50,
        costWindowStart: new Date("2026-07-01T00:00:00Z"),
        costScope: "calendar_month_to_date",
        rawData: {
          billing: {
            configured: true,
            status: "ready",
            configFingerprint:
              geminiBillingConfigFingerprint(previousConfig),
          },
        },
      },
    });

    const status = await computeBudgetStatus(NOW);
    const result = status.providers.find((item) => item.id === provider.id)!;

    expect(result.snapshotCostUsd).toBeNull();
    expect(result.snapshotCostFetchedAt).toBeNull();
    expect(result.spentUsd).toBe(0);
    expect(result.spendCoverage).toBe("unknown");
    expect(result.status).toBe("ok");
    expect(status.summary.totalSpentUsd).toBe(0);
    expect(result.alerts).not.toContainEqual(
      expect.objectContaining({ code: "budget_exceeded" })
    );
    expect(result.alerts).toContainEqual(
      expect.objectContaining({
        code: "billing_sync_incomplete",
        severity: "info",
        message: expect.stringContaining("not configured"),
      })
    );
  });

  it("excludes a prior-month provider cost window after UTC month rollover", async () => {
    const provider = await prisma.provider.create({
      data: { name: "rolled-cost", displayName: "Rolled Cost", type: "builtin" },
    });
    await prisma.usageSnapshot.create({
      data: {
        providerId: provider.id,
        fetchedAt: NOW,
        totalCost: 90,
        costWindowStart: new Date("2026-06-01T00:00:00Z"),
        costWindowEnd: new Date("2026-07-01T00:00:00Z"),
        costScope: "calendar_month_to_date",
      },
    });

    const status = await computeBudgetStatus(NOW);
    const result = status.providers.find((item) => item.id === provider.id)!;
    expect(result.snapshotCostUsd).toBeNull();
    expect(result.spentUsd).toBe(0);
  });

  it("keeps pushed spend visible when provider polling is inactive", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "inactive-push",
        displayName: "Inactive Push",
        type: "push",
        isActive: false,
      },
    });
    await prisma.externalUsageEvent.create({
      data: {
        idempotencyKey: "inactive-push-cost",
        sourceApp: "producer",
        provider: "inactive-push",
        billingMode: "actual",
        metricType: "cost",
        costUsd: 7,
        occurredAt: NOW,
      },
    });

    const status = await computeBudgetStatus(NOW);
    expect(status.providers.find((item) => item.id === provider.id)?.spentUsd).toBe(7);
  });

  it("adds known subscription renewals through month-end without linearizing fixed cost", async () => {
    const provider = await prisma.provider.create({
      data: { name: "weekly-plan", displayName: "Weekly Plan", type: "builtin" },
    });
    await createSubscription(provider.id, {
      costUsd: 10,
      interval: "weekly",
      currentPeriodStart: new Date("2026-07-11T00:00:00Z"),
      nextRenewalAt: new Date("2026-07-18T00:00:00Z"),
      lastChargedPeriodStart: new Date("2026-07-11T00:00:00Z"),
    });
    await prisma.externalUsageEvent.create({
      data: {
        idempotencyKey: "weekly-existing-charge",
        sourceApp: "subscription",
        provider: "weekly-plan",
        billingMode: "manual",
        metricType: "subscription",
        costUsd: 20,
        occurredAt: new Date("2026-07-11T00:00:00Z"),
        metadata: { subscriptionId: "unrelated-aggregate" },
      },
    });

    const status = await computeBudgetStatus(NOW);
    const result = status.providers.find((item) => item.id === provider.id)!;
    expect(result.forecastedSubscriptionRenewalsUsd).toBe(20);
    expect(result.spentUsd).toBe(20);
    expect(result.projectedEomUsd).toBe(40);
  });

  it("assigns name-keyed pushed and subscription spend to one duplicate provider row", async () => {
    const canonical = await prisma.provider.create({
      data: {
        name: "anthropic",
        displayName: "Anthropic budget owner",
        type: "push",
        plan: { create: { billingMode: "actual", monthlyBudgetUsd: 100 } },
      },
    });
    await prisma.provider.create({
      data: { name: "Anthropic", displayName: "Legacy duplicate", type: "push" },
    });
    await prisma.externalUsageEvent.createMany({
      data: [
        {
          idempotencyKey: "duplicate-name-usage",
          sourceApp: "claude-code",
          provider: "ANTHROPIC",
          billingMode: "actual",
          metricType: "cost",
          costUsd: 5,
          occurredAt: NOW,
        },
        {
          idempotencyKey: "duplicate-name-subscription",
          sourceApp: "subscription",
          provider: "anthropic",
          billingMode: "actual",
          metricType: "subscription",
          costUsd: 30,
          occurredAt: NOW,
        },
      ],
    });

    const status = await computeBudgetStatus(NOW);
    expect(status.providers.reduce((sum, provider) => sum + provider.pushedMonthToDateUsd, 0)).toBe(35);
    expect(status.providers.find((provider) => provider.id === canonical.id)?.spentUsd).toBe(35);
  });

  it("includes unbudgeted spend in summary totals without distorting budget utilization", async () => {
    await prisma.provider.create({
      data: { name: "anthropic", displayName: "Anthropic", type: "push" },
    });
    await prisma.externalUsageEvent.create({
      data: {
        idempotencyKey: "unbudgeted-provider-cost",
        sourceApp: "claude-code",
        provider: "anthropic",
        billingMode: "actual",
        metricType: "cost",
        costUsd: 17,
        occurredAt: NOW,
      },
    });

    const status = await computeBudgetStatus(NOW);
    expect(status.summary).toMatchObject({
      totalBudgetUsd: 0,
      budgetedSpentUsd: 0,
      unbudgetedSpentUsd: 17,
      totalSpentUsd: 17,
      remainingUsd: 0,
      percentUsed: null,
    });
  });

  it("does not re-charge already-charged periods when the schedule is edited", async () => {
    // Regression for the critical double-charge: editing the schedule (here via
    // a real PUT that changes the interval) must not re-emit past charges.
    const provider = await prisma.provider.create({
      data: { name: "anthropic", displayName: "Anthropic", type: "push", refreshIntervalMin: 60 },
    });
    const subscription = await createSubscription(provider.id);

    await materializeDueSubscriptions(NOW);
    expect(await prisma.externalUsageEvent.count()).toBe(1);

    // Edit the subscription: change interval to quarterly (a genuine schedule change).
    const req = new Request(`http://test/api/subscriptions/${subscription.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ interval: "quarterly" }),
    });
    const res = await putSubscription(req, { params: Promise.resolve({ id: subscription.id }) });
    expect(res.status).toBe(200);

    // Re-materialize: still exactly one charge — no duplicate for July.
    await materializeDueSubscriptions(NOW);
    expect(await prisma.externalUsageEvent.count()).toBe(1);
  });

  it("never charges a 'considering' subscription (candidate plan, not yet purchased)", async () => {
    // Regression for subscription->knob linkage phase 1: "considering" is a
    // first-class status (alongside active|paused|canceled) so a candidate
    // paid tier's knobEnv can be compared before committing to it — it must
    // behave exactly like "paused" for billing purposes: zero charges, ever.
    const provider = await prisma.provider.create({
      data: { name: "tiingo", displayName: "Tiingo", type: "builtin", refreshIntervalMin: 60 },
    });
    await createSubscription(provider.id, { status: "considering", costUsd: 30 });

    const result = await materializeDueSubscriptions(NOW);
    expect(result.examined).toBe(0);
    expect(result.charged).toBe(0);
    expect(result.eventsWritten).toBe(0);
    expect(await prisma.externalUsageEvent.count()).toBe(0);
  });

  it("does not emit an overlapping charge when the anchor day moves later in the billed month", async () => {
    // Regression for the fix-review finding: charged Jul-1 period, then move
    // anchorDay to 15 — the new Aug-anchored period must not overlap July.
    const provider = await prisma.provider.create({
      data: { name: "anthropic", displayName: "Anthropic", type: "push", refreshIntervalMin: 60 },
    });
    const subscription = await createSubscription(provider.id);

    await materializeDueSubscriptions(NOW);
    expect(await prisma.externalUsageEvent.count()).toBe(1);

    const req = new Request(`http://test/api/subscriptions/${subscription.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ anchorDay: 15 }),
    });
    const res = await putSubscription(req, { params: Promise.resolve({ id: subscription.id }) });
    expect(res.status).toBe(200);

    await materializeDueSubscriptions(NOW);
    expect(await prisma.externalUsageEvent.count()).toBe(1);
  });

  it("resets the billing cycle on activation — a 'considering' row does not backfill pre-activation periods", async () => {
    // Regression for a P2 review finding on the subscription->knob linkage
    // PR: a candidate ("considering") plan created months ago used to keep
    // its original currentPeriodStart when flipped to "active", so
    // materializeDueSubscriptions (which walks forward charging every
    // elapsed period since currentPeriodStart) backfilled a charge for
    // every period between creation and activation — including time before
    // the plan was actually purchased. The PUT handler must re-anchor the
    // cycle to the activation moment (here an explicit startDate the PUT
    // supplies, matching "if the code already accepts a startDate/purchase
    // -date input, honor that instead") so only the current, post-activation
    // period is ever charged.
    const provider = await prisma.provider.create({
      data: { name: "fmp", displayName: "FMP", type: "builtin", refreshIntervalMin: 60 },
    });
    // Row "created" back in January, sitting as "considering" — six monthly
    // periods have elapsed by the time NOW (2026-07-15) rolls around.
    const subscription = await createSubscription(provider.id, {
      status: "considering",
      startDate: new Date("2026-01-01T00:00:00Z"),
      currentPeriodStart: new Date("2026-01-01T00:00:00Z"),
      nextRenewalAt: new Date("2026-02-01T00:00:00Z"),
    });

    // Sanity: while considering, materializing never touches it (existing
    // behavior, unaffected by this fix).
    const before = await materializeDueSubscriptions(NOW);
    expect(before.examined).toBe(0);
    expect(await prisma.externalUsageEvent.count()).toBe(0);

    const req = new Request(`http://test/api/subscriptions/${subscription.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "active", startDate: "2026-07-10T00:00:00.000Z" }),
    });
    const res = await putSubscription(req, { params: Promise.resolve({ id: subscription.id }) });
    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.status).toBe("active");
    // Re-anchored to the activation date, not the original January startDate.
    expect(updated.currentPeriodStart).toBe("2026-07-10T00:00:00.000Z");
    expect(updated.lastChargedPeriodStart).toBeNull();

    const result = await materializeDueSubscriptions(NOW);
    expect(result.charged).toBe(1);
    expect(result.eventsWritten).toBe(1);

    // Exactly ONE charge — the current (post-activation) period — never the
    // six periods that elapsed between the original January startDate and
    // activation.
    const events = await prisma.externalUsageEvent.findMany();
    expect(events).toHaveLength(1);
    expect(events[0].occurredAt.toISOString()).toBe("2026-07-10T00:00:00.000Z");
  });

  it("resets the billing cycle on activation for a 'paused' row too (not just 'considering')", async () => {
    const provider = await prisma.provider.create({
      data: { name: "twelvedata", displayName: "Twelve Data", type: "builtin", refreshIntervalMin: 60 },
    });
    const subscription = await createSubscription(provider.id, {
      status: "paused",
      startDate: new Date("2026-03-01T00:00:00Z"),
      currentPeriodStart: new Date("2026-03-01T00:00:00Z"),
      nextRenewalAt: new Date("2026-04-01T00:00:00Z"),
      lastChargedPeriodStart: new Date("2026-03-01T00:00:00Z"),
    });

    const req = new Request(`http://test/api/subscriptions/${subscription.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "active", startDate: "2026-07-10T00:00:00.000Z" }),
    });
    const res = await putSubscription(req, { params: Promise.resolve({ id: subscription.id }) });
    expect(res.status).toBe(200);

    const result = await materializeDueSubscriptions(NOW);
    expect(result.charged).toBe(1);

    const events = await prisma.externalUsageEvent.findMany();
    expect(events).toHaveLength(1);
    expect(events[0].occurredAt.toISOString()).toBe("2026-07-10T00:00:00.000Z");
  });

  it("can resume a paid-through paused term without posting an immediate repurchase", async () => {
    const provider = await prisma.provider.create({
      data: { name: "resume-plan", displayName: "Resume Plan", type: "builtin" },
    });
    const subscription = await createSubscription(provider.id, {
      status: "paused",
      currentPeriodStart: new Date("2026-07-01T00:00:00Z"),
      nextRenewalAt: new Date("2026-08-01T00:00:00Z"),
      lastChargedPeriodStart: new Date("2026-07-01T00:00:00Z"),
    });

    const req = new Request(`http://test/api/subscriptions/${subscription.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "active", activationMode: "resume" }),
    });
    const res = await putSubscription(req, { params: Promise.resolve({ id: subscription.id }) });
    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.currentPeriodStart).toBe("2026-07-01T00:00:00.000Z");
    expect(updated.nextRenewalAt).toBe("2026-08-01T00:00:00.000Z");
    expect(updated.lastChargedPeriodStart).toBe("2026-07-01T00:00:00.000Z");

    const result = await materializeDueSubscriptions(NOW);
    expect(result.eventsWritten).toBe(0);
  });

  it("stamps provider-linked charges as actual cash", () => {
    const plan = planSubscriptionCharges(
      fakeSubscription({ externalBillingManaged: true }),
      new Date("2026-07-15T00:00:00Z")
    );
    expect(plan!.inputs[0].confidence).toBe("actual");
    expect(plan!.inputs[0].metadata).toEqual({
      subscriptionId: "sub-1",
      subscriptionName: "Test plan",
      interval: "monthly",
      intervalCount: 1,
      currency: "USD",
    });
  });

  it("stamps linked-but-unmanaged Cloudflare-legacy charges as actual cash", () => {
    const plan = planSubscriptionCharges(
      fakeSubscription({
        externalBillingManaged: false,
        externalBillingSource: "cloudflare-subscriptions",
        externalBillingId: "workers-paid",
      }),
      new Date("2026-07-15T00:00:00Z")
    );
    expect(plan!.inputs[0].confidence).toBe("actual");
    expect(plan!.inputs[0].metadata).not.toHaveProperty("modeled");
    expect(plan!.inputs[0].metadata).not.toHaveProperty("chargeBasis");
  });

  it("does not reset the cycle for a PUT that leaves an already-active row active", async () => {
    // "Do NOT change behavior for a row that was already active" — a PUT
    // that re-sends status: "active" on an already-active row must not
    // re-anchor currentPeriodStart or clear the watermark.
    const provider = await prisma.provider.create({
      data: { name: "alphavantage", displayName: "Alpha Vantage", type: "builtin", refreshIntervalMin: 60 },
    });
    const subscription = await createSubscription(provider.id, {
      status: "active",
      startDate: new Date("2026-05-01T00:00:00Z"),
      currentPeriodStart: new Date("2026-07-01T00:00:00Z"),
      nextRenewalAt: new Date("2026-08-01T00:00:00Z"),
      lastChargedPeriodStart: new Date("2026-07-01T00:00:00Z"),
    });

    const req = new Request(`http://test/api/subscriptions/${subscription.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "active", notes: "still active" }),
    });
    const res = await putSubscription(req, { params: Promise.resolve({ id: subscription.id }) });
    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.currentPeriodStart).toBe("2026-07-01T00:00:00.000Z");
    expect(updated.lastChargedPeriodStart).toBe("2026-07-01T00:00:00.000Z");
  });

  it("retracts modeled charges when a PUT leaves active", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "massive-retract",
        displayName: "Massive Retract",
        type: "builtin",
        refreshIntervalMin: 60,
      },
    });
    const subscription = await createSubscription(provider.id, { costUsd: 29 });
    await materializeDueSubscriptions(NOW);
    expect(
      await prisma.externalUsageEvent.count({
        where: { sourceApp: "subscription" },
      })
    ).toBe(1);

    const req = new Request(`http://test/api/subscriptions/${subscription.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "considering" }),
    });
    const res = await putSubscription(req, {
      params: Promise.resolve({ id: subscription.id }),
    });
    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.status).toBe("considering");
    expect(updated.lastChargedPeriodStart).toBeNull();
    expect(
      await prisma.externalUsageEvent.count({
        where: { sourceApp: "subscription" },
      })
    ).toBe(0);
  });

  it("keeps receipt-backed Cloudflare charges when retracting a paused or deleted row", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "cloudflare-handoff",
        displayName: "Cloudflare Handoff",
        type: "builtin",
        refreshIntervalMin: 60,
      },
    });
    const linked = await createSubscription(provider.id, {
      name: "Workers Paid",
      costUsd: 5,
      externalBillingManaged: false,
      externalBillingSource: "cloudflare-subscriptions",
      externalBillingId: "workers-paid",
    });
    const modeled = await createSubscription(provider.id, {
      name: "Catalog Ghost",
      costUsd: 29,
    });
    await materializeDueSubscriptions(NOW);
    const before = await prisma.externalUsageEvent.findMany({
      where: { sourceApp: "subscription" },
      select: { id: true, confidence: true, metadata: true, service: true },
    });
    expect(before).toHaveLength(2);
    const linkedEvent = before.find((event) => event.service === "Workers Paid");
    const modeledEvent = before.find((event) => event.service === "Catalog Ghost");
    expect(linkedEvent?.confidence).toBe("actual");
    expect(linkedEvent?.metadata).not.toMatchObject({ modeled: true });
    expect(modeledEvent?.confidence).toBe("estimated");

    const retracted = await retractSubscriptionCharges(linked.id);
    expect(retracted.deleted).toBe(0);
    expect(
      await prisma.externalUsageEvent.count({
        where: { id: linkedEvent!.id },
      })
    ).toBe(1);

    const req = new Request(`http://test/api/subscriptions/${linked.id}`, {
      method: "DELETE",
    });
    const res = await deleteSubscription(req, {
      params: Promise.resolve({ id: linked.id }),
    });
    expect(res.status).toBe(200);
    expect(await prisma.subscription.findUnique({ where: { id: linked.id } })).toBeNull();
    expect(
      await prisma.externalUsageEvent.count({
        where: { id: linkedEvent!.id },
      })
    ).toBe(1);

    const modeledReq = new Request(`http://test/api/subscriptions/${modeled.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "paused" }),
    });
    const modeledRes = await putSubscription(modeledReq, {
      params: Promise.resolve({ id: modeled.id }),
    });
    expect(modeledRes.status).toBe(200);
    expect(
      await prisma.externalUsageEvent.count({
        where: { id: modeledEvent!.id },
      })
    ).toBe(0);
  });

  it("pauses external-managed rows with ambiguous mid-period windows (Wave K / E13)", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "cloudflare-ambiguous",
        displayName: "Cloudflare Ambiguous",
        type: "builtin",
        refreshIntervalMin: 60,
      },
    });
    const subscription = await createSubscription(provider.id, {
      status: "active",
      autoRenew: false,
      externalBillingManaged: true,
      externalBillingSource: "cloudflare-subscriptions",
      externalBillingId: "workers-paid",
      startDate: new Date("2026-07-01T00:00:00Z"),
      currentPeriodStart: new Date("2026-07-01T00:00:00Z"),
      // 10-day window is not a monthly cadence → ambiguous.
      nextRenewalAt: new Date("2026-07-11T00:00:00Z"),
      lastChargedPeriodStart: null,
    });

    const result = await materializeDueSubscriptions(NOW);
    expect(result.ambiguousPaused).toBe(1);
    expect(result.charged).toBe(0);
    expect(result.eventsWritten).toBe(0);

    const row = await prisma.subscription.findUniqueOrThrow({
      where: { id: subscription.id },
    });
    expect(row.status).toBe("paused");
    expect(row.autoRenew).toBe(false);
    expect(
      await prisma.externalUsageEvent.count({
        where: {
          sourceApp: "subscription",
          service: subscription.name,
        },
      })
    ).toBe(0);
  });

  describe("transactional re-check concurrency & race prevention", () => {
    it("does not charge a subscription that the owner paused mid-run", async () => {
      const provider = await prisma.provider.create({
        data: {
          name: "race-provider-1",
          displayName: "Race Provider 1",
          type: "builtin",
          refreshIntervalMin: 60,
        },
      });
      const subscription = await createSubscription(provider.id, {
        status: "active",
        costUsd: 100,
        startDate: new Date("2026-07-01T00:00:00Z"),
        currentPeriodStart: new Date("2026-07-01T00:00:00Z"),
        nextRenewalAt: new Date("2026-08-01T00:00:00Z"),
        lastChargedPeriodStart: null,
      });

      const result = await materializeDueSubscriptions(NOW, {
        beforeTransactionalRecheck: async () => {
          await prisma.subscription.update({
            where: { id: subscription.id },
            data: { status: "paused" },
          });
        },
      });

      expect(result.charged).toBe(0);
      expect(result.eventsWritten).toBe(0);

      const eventsCount = await prisma.externalUsageEvent.count({
        where: { provider: provider.name },
      });
      expect(eventsCount).toBe(0);

      const dbSub = await prisma.subscription.findUniqueOrThrow({
        where: { id: subscription.id },
      });
      expect(dbSub.status).toBe("paused");
      expect(dbSub.lastChargedPeriodStart).toBeNull();
    });

    it("charges at the owner's new price, not the price observed before the lock", async () => {
      const provider = await prisma.provider.create({
        data: {
          name: "race-provider-2",
          displayName: "Race Provider 2",
          type: "builtin",
          refreshIntervalMin: 60,
        },
      });
      const subscription = await createSubscription(provider.id, {
        status: "active",
        costUsd: 200,
        startDate: new Date("2026-07-01T00:00:00Z"),
        currentPeriodStart: new Date("2026-07-01T00:00:00Z"),
        nextRenewalAt: new Date("2026-08-01T00:00:00Z"),
        lastChargedPeriodStart: null,
      });

      const result = await materializeDueSubscriptions(NOW, {
        beforeTransactionalRecheck: async () => {
          await prisma.subscription.update({
            where: { id: subscription.id },
            data: { costUsd: 20 },
          });
        },
      });

      expect(result.charged).toBe(1);
      expect(result.eventsWritten).toBe(1);

      const event = await prisma.externalUsageEvent.findFirstOrThrow({
        where: { provider: provider.name },
      });
      expect(event.costUsd).toBe(20);
    });

    it("re-plans under the owner's new cadence", async () => {
      const provider = await prisma.provider.create({
        data: {
          name: "race-provider-3",
          displayName: "Race Provider 3",
          type: "builtin",
          refreshIntervalMin: 60,
        },
      });
      const subscription = await createSubscription(provider.id, {
        status: "active",
        costUsd: 50,
        interval: "monthly",
        startDate: new Date("2026-07-01T00:00:00Z"),
        currentPeriodStart: new Date("2026-07-01T00:00:00Z"),
        nextRenewalAt: new Date("2026-08-01T00:00:00Z"),
        lastChargedPeriodStart: null,
      });

      const result = await materializeDueSubscriptions(NOW, {
        beforeTransactionalRecheck: async () => {
          await prisma.subscription.update({
            where: { id: subscription.id },
            data: {
              interval: "yearly",
              currentPeriodStart: new Date("2027-01-01T00:00:00Z"),
              nextRenewalAt: new Date("2028-01-01T00:00:00Z"),
            },
          });
        },
      });

      expect(result.charged).toBe(0);
      expect(result.eventsWritten).toBe(0);
    });

    it("suppresses a row the owner switched to a non-USD currency mid-run", async () => {
      const provider = await prisma.provider.create({
        data: {
          name: "race-provider-4",
          displayName: "Race Provider 4",
          type: "builtin",
          refreshIntervalMin: 60,
        },
      });
      const subscription = await createSubscription(provider.id, {
        status: "active",
        costUsd: 50,
        currency: "USD",
        startDate: new Date("2026-07-01T00:00:00Z"),
        currentPeriodStart: new Date("2026-07-01T00:00:00Z"),
        nextRenewalAt: new Date("2026-08-01T00:00:00Z"),
        lastChargedPeriodStart: null,
      });

      const result = await materializeDueSubscriptions(NOW, {
        beforeTransactionalRecheck: async () => {
          await prisma.subscription.update({
            where: { id: subscription.id },
            data: { currency: "EUR" },
          });
        },
      });

      expect(result.nonUsdSkipped).toBe(1);
      expect(result.charged).toBe(0);
      expect(result.eventsWritten).toBe(0);
    });
  });
});
