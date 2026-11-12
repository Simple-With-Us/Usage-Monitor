import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { setupPrismaSqliteTestDb } from "./setup-test-db";

// Spending-intelligence regression suite (2026-07-28 full-app review):
//   S2  receipt-cash projection floor must not fabricate budget breaches
//   S4  poll-primary providers get trend-aware (merged-series) EOM forecasts
//   S8  non-USD subscriptions surface a loud warning, never charge as USD
//   S9  budget runout date on the budget-status DTO
//   S11 budget alert hysteresis applies to the dashboard/API path too
//   S13 month-straddle cost snapshots emit a visible info alert
// Everything that transitively imports @/lib/prisma is loaded DYNAMICALLY after
// DATABASE_URL points at the test DB (same pattern as budget-status-cache.test).
let dbPath: string;
let prisma: typeof import("@/lib/prisma").prisma;
let computeBudgetStatus: typeof import("../budget-status").computeBudgetStatus;
let persistExternalUsageEvents: typeof import("../external-usage-events").persistExternalUsageEvents;

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "budget-status-intel-test-"));
  dbPath = path.join(dir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  setupPrismaSqliteTestDb(dbPath);

  ({ prisma } = await import("@/lib/prisma"));
  ({ computeBudgetStatus } = await import("../budget-status"));
  ({ persistExternalUsageEvents } = await import("../external-usage-events"));
}, 60_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (dbPath && fs.existsSync(dbPath)) fs.rmSync(dbPath, { force: true });
});

beforeEach(async () => {
  const { clearMtdScanMemo } = await import("../mtd-scan-memo");
  clearMtdScanMemo();
  const {
    __resetBudgetStatusCacheForTests,
    __resetProjectBudgetStatusCacheForTests,
  } = await import("../budget-status");
  __resetBudgetStatusCacheForTests();
  __resetProjectBudgetStatusCacheForTests();
  await prisma.providerAlertNotification.deleteMany();
  await prisma.externalUsageEvent.deleteMany();
  await prisma.subscription.deleteMany();
  await prisma.usageSnapshot.deleteMany();
  await prisma.providerPlan.deleteMany();
  await prisma.project.deleteMany();
  await prisma.provider.deleteMany();
});

async function createProviderWithPlan(
  name: string,
  monthlyBudgetUsd: number | null,
  extra: Record<string, unknown> = {}
) {
  return prisma.provider.create({
    data: {
      name,
      displayName: name,
      type: "builtin",
      refreshIntervalMin: 60,
      ...(monthlyBudgetUsd != null
        ? { plan: { create: { billingMode: "actual", monthlyBudgetUsd } } }
        : {}),
      ...extra,
    },
  });
}

describe("S2: receipt cash never fabricates a projected breach", () => {
  it("a $500 top-up over $12 of usage does not project a $500 EOM", async () => {
    const NOW = new Date("2026-08-16T00:00:00.000Z");
    const provider = await createProviderWithPlan("receipt-floor", 400);
    const digest = "a".repeat(64);
    await persistExternalUsageEvents([
      {
        idempotencyKey: "s2-usage-1",
        sourceApp: "producer",
        provider: provider.name,
        billingMode: "actual",
        metricType: "cost",
        costUsd: 12,
        occurredAt: new Date("2026-08-05T00:00:00.000Z"),
      },
      {
        idempotencyKey: `billing-receipt:v1:${digest}`,
        sourceApp: "billing-receipt-import",
        provider: provider.name,
        service: "api-prepaid-funding",
        label: "receipt_cash_paid",
        keyRef: `provider:${provider.id}:billing-receipt:${digest}`,
        billingMode: "actual",
        metricType: "cost",
        unit: "usd",
        confidence: "actual",
        costUsd: 500,
        occurredAt: new Date("2026-08-05T00:00:00.000Z"),
      },
    ]);

    const status = await computeBudgetStatus(NOW);
    const row = status.providers.find((p) => p.id === provider.id)!;

    // Receipt cash remains visible as funding evidence…
    expect(row.receiptCashPaidUsd).toBe(500);
    expect(row.observedVariableUsageUsd).toBe(12);
    expect(row.spentUsd).toBe(12);
    // …but the projection is floored at max(observed, forecast) — never at
    // the deposit. Pre-fix this was exactly 500 and flipped projectedStatus
    // to "exceeded" against the $400 budget.
    expect(row.projectedEomUsd).toBeGreaterThanOrEqual(12);
    expect(row.projectedEomUsd).toBeLessThan(100);
    expect(row.projectedStatus).toBe("ok");
  });
});

describe("S4: poll-primary providers get trend-aware EOM forecasts", () => {
  it("an accelerating snapshot series projects above the naive linear rate", async () => {
    const NOW = new Date("2026-08-10T23:00:00.000Z");
    const provider = await createProviderWithPlan("trend-poll", 100_000);
    // Cumulative MTD cost grows quadratically: day peaks 1,4,9,…,100 → daily
    // increments 1,3,5,…,19 (slope +2/day). A naive linear projection cannot
    // see the acceleration.
    for (let day = 1; day <= 10; day++) {
      await prisma.usageSnapshot.create({
        data: {
          providerId: provider.id,
          fetchedAt: new Date(
            Date.UTC(2026, 7, day, 12, 0, 0)
          ),
          totalCost: day * day,
          costScope: "calendar_month_to_date",
        },
      });
    }

    const status = await computeBudgetStatus(NOW);
    const row = status.providers.find((p) => p.id === provider.id)!;

    expect(row.observedVariableUsageUsd).toBe(100);
    // Naive linear: 100 / 10.958 days * 31 ≈ 283. The recency-weighted trend
    // fit sees the +2/day slope and projects much higher (clamped at 3x the
    // linear remaining); the true quadratic continuation is 730.
    const naiveLinear = (100 / (10 + 23 / 24)) * 31;
    expect(row.projectedEomUsd).toBeGreaterThan(naiveLinear * 1.2);
    expect(row.projectedEomUsd).toBeLessThanOrEqual(730 + 1e-9);
  });

  it("a flat snapshot series keeps the projection near the linear rate", async () => {
    const NOW = new Date("2026-08-10T23:00:00.000Z");
    const provider = await createProviderWithPlan("flat-poll", 100_000);
    for (let day = 1; day <= 10; day++) {
      await prisma.usageSnapshot.create({
        data: {
          providerId: provider.id,
          fetchedAt: new Date(Date.UTC(2026, 7, day, 12, 0, 0)),
          totalCost: day * 10, // constant $10/day
          costScope: "calendar_month_to_date",
        },
      });
    }

    const status = await computeBudgetStatus(NOW);
    const row = status.providers.find((p) => p.id === provider.id)!;

    const naiveLinear = (100 / (10 + 23 / 24)) * 31;
    // Flat series → no spurious curvature: within 20% of naive linear.
    expect(row.projectedEomUsd).toBeGreaterThan(naiveLinear * 0.8);
    expect(row.projectedEomUsd).toBeLessThan(naiveLinear * 1.2);
  });
});

describe("S9: budget runout date", () => {
  it("reports the day the cumulative forecast crosses the budget", async () => {
    // Day 4.5 of a 31-day month. $50 spent against a $100 budget → linear
    // projection $344.44; crossing day = 4.5 * (100/50 - 1) = 4.5 days out.
    const NOW = new Date("2026-08-04T12:00:00.000Z");
    const provider = await createProviderWithPlan("runout", 100, {
      snapshots: {
        create: {
          fetchedAt: new Date("2026-08-04T00:00:00.000Z"),
          totalCost: 50,
          costScope: "calendar_month_to_date",
        },
      },
    });

    const status = await computeBudgetStatus(NOW);
    const row = status.providers.find((p) => p.id === provider.id)!;

    expect(row.daysUntilBudgetExhausted).toBe(4.5);
    expect(row.projectedRunoutDate).toBe("2026-08-09T00:00:00.000Z");
  });

  it("reports 0 days when the budget is already exhausted", async () => {
    const NOW = new Date("2026-08-04T12:00:00.000Z");
    const provider = await createProviderWithPlan("runout-exceeded", 40, {
      snapshots: {
        create: {
          fetchedAt: new Date("2026-08-04T00:00:00.000Z"),
          totalCost: 50,
          costScope: "calendar_month_to_date",
        },
      },
    });

    const status = await computeBudgetStatus(NOW);
    const row = status.providers.find((p) => p.id === provider.id)!;

    expect(row.daysUntilBudgetExhausted).toBe(0);
    expect(row.projectedRunoutDate).toBe(NOW.toISOString());
  });

  it("reports nulls when no budget is configured", async () => {
    const NOW = new Date("2026-08-04T12:00:00.000Z");
    const provider = await createProviderWithPlan("runout-unconfigured", null, {
      snapshots: {
        create: {
          fetchedAt: new Date("2026-08-04T00:00:00.000Z"),
          totalCost: 50,
          costScope: "calendar_month_to_date",
        },
      },
    });

    const status = await computeBudgetStatus(NOW);
    const row = status.providers.find((p) => p.id === provider.id)!;

    expect(row.projectedRunoutDate).toBeNull();
    expect(row.daysUntilBudgetExhausted).toBeNull();
  });
});

describe("S11: budget alert hysteresis on the dashboard/API path", () => {
  async function createHysteresisFixture() {
    const provider = await createProviderWithPlan("hysteresis", 100, {
      snapshots: {
        create: {
          fetchedAt: new Date("2026-08-04T00:00:00.000Z"),
          totalCost: 96, // 96% of budget: above the 95% clear, below 100% enter
          costScope: "calendar_month_to_date",
        },
      },
    });
    return provider;
  }
  const NOW = new Date("2026-08-04T12:00:00.000Z");

  it("keeps budget_exceeded while spend is above the 95% clear threshold", async () => {
    const provider = await createHysteresisFixture();
    await prisma.providerAlertNotification.create({
      data: {
        providerId: provider.id,
        stateKey: `${provider.id}:budget_exceeded`,
        alertCode: "budget_exceeded",
        severity: "critical",
        providerName: provider.name,
        providerDisplayName: provider.displayName,
        message: "$110 tracked against $100 monthly budget.",
        firstDetectedAt: new Date("2026-08-03T00:00:00.000Z"),
        lastDetectedAt: new Date("2026-08-03T12:00:00.000Z"),
      },
    });

    const status = await computeBudgetStatus(NOW);
    const row = status.providers.find((p) => p.id === provider.id)!;

    // Without hysteresis, 96% would downgrade to budget_warning.
    const codes = row.alerts.map((a) => a.code);
    expect(codes).toContain("budget_exceeded");
    expect(codes).not.toContain("budget_warning");
  });

  it("falls back to enter thresholds when the open incident is resolved", async () => {
    const provider = await createHysteresisFixture();
    await prisma.providerAlertNotification.create({
      data: {
        providerId: provider.id,
        stateKey: `${provider.id}:budget_exceeded`,
        alertCode: "budget_exceeded",
        severity: "critical",
        providerName: provider.name,
        providerDisplayName: provider.displayName,
        message: "$110 tracked against $100 monthly budget.",
        firstDetectedAt: new Date("2026-08-03T00:00:00.000Z"),
        lastDetectedAt: new Date("2026-08-03T12:00:00.000Z"),
        resolvedAt: new Date("2026-08-03T13:00:00.000Z"),
      },
    });

    const status = await computeBudgetStatus(NOW);
    const row = status.providers.find((p) => p.id === provider.id)!;

    const codes = row.alerts.map((a) => a.code);
    expect(codes).toContain("budget_warning");
    expect(codes).not.toContain("budget_exceeded");
  });

  it("uses enter thresholds when no notification exists at all", async () => {
    const provider = await createHysteresisFixture();

    const status = await computeBudgetStatus(NOW);
    const row = status.providers.find((p) => p.id === provider.id)!;

    const codes = row.alerts.map((a) => a.code);
    expect(codes).toContain("budget_warning");
    expect(codes).not.toContain("budget_exceeded");
  });
});

describe("S13: month-straddle cost snapshots are visible, not silent", () => {
  const NOW = new Date("2026-07-12T00:00:00.000Z");

  it("emits an info billing_sync_incomplete alert when the newest cost snapshot straddles the month", async () => {
    const provider = await createProviderWithPlan("straddle", null, {
      snapshots: {
        create: {
          fetchedAt: new Date("2026-07-10T00:00:00.000Z"),
          totalCost: 40,
          costScope: "billing_cycle_to_date",
          // Mid-month billing cycle: window started BEFORE July 1 → excluded
          // from month-to-date budget math by the latestCostTimes filter.
          costWindowStart: new Date("2026-06-15T00:00:00.000Z"),
          costWindowEnd: new Date("2026-07-15T00:00:00.000Z"),
        },
      },
    });

    const status = await computeBudgetStatus(NOW);
    const row = status.providers.find((p) => p.id === provider.id)!;

    // The straddling snapshot stays excluded from MTD math…
    expect(row.snapshotCostUsd).toBeNull();
    // …but the exclusion is now visible.
    const alert = row.alerts.find(
      (a) =>
        a.code === "billing_sync_incomplete" &&
        a.message.includes("excluded from month-to-date budget math")
    );
    expect(alert).toBeDefined();
    expect(alert!.severity).toBe("info");
    expect(alert!.message).toContain("2026-06-15");
  });

  it("stays silent when the newest cost snapshot is month-eligible", async () => {
    const provider = await createProviderWithPlan("no-straddle", null, {
      snapshots: {
        create: {
          fetchedAt: new Date("2026-07-10T00:00:00.000Z"),
          totalCost: 40,
          costScope: "billing_cycle_to_date",
          costWindowStart: new Date("2026-07-01T00:00:00.000Z"),
          costWindowEnd: new Date("2026-08-01T00:00:00.000Z"),
        },
      },
    });

    const status = await computeBudgetStatus(NOW);
    const row = status.providers.find((p) => p.id === provider.id)!;

    expect(row.snapshotCostUsd).toBe(40);
    expect(
      row.alerts.some(
        (a) =>
          a.code === "billing_sync_incomplete" &&
          a.message.includes("excluded from month-to-date budget math")
      )
    ).toBe(false);
  });
});

describe("S8: non-USD subscriptions are loud, never charged as USD", () => {
  it("surfaces a warning alert for an active non-USD subscription", async () => {
    const NOW = new Date("2026-07-15T12:00:00.000Z");
    const provider = await createProviderWithPlan("eur-provider", null);
    await prisma.subscription.create({
      data: {
        providerId: provider.id,
        name: "EUR plan",
        costUsd: 100,
        currency: "EUR",
        interval: "monthly",
        intervalCount: 1,
        startDate: new Date("2026-07-01T00:00:00.000Z"),
        currentPeriodStart: new Date("2026-07-01T00:00:00.000Z"),
        nextRenewalAt: new Date("2026-08-01T00:00:00.000Z"),
        status: "active",
      },
    });

    const status = await computeBudgetStatus(NOW);
    const row = status.providers.find((p) => p.id === provider.id)!;

    const alert = row.alerts.find(
      (a) =>
        a.code === "billing_sync_incomplete" &&
        a.message.includes("never materialized as USD")
    );
    expect(alert).toBeDefined();
    expect(alert!.severity).toBe("warning");
    expect(alert!.message).toContain("EUR");
    // The EUR amount must not appear as USD fixed cost.
    expect(row.fixedAccruedUsd).toBe(0);
    expect(row.spentUsd).toBe(0);
  });
});
