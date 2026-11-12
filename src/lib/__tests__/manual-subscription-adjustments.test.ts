import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { Prisma } from "@prisma/client";
// Type-only import: erased at compile time, so it does not trigger
// usage-telemetry.ts's module load (and transitively @/lib/prisma) before
// DATABASE_URL is pointed at the test DB below.
import type { ParsedUsageTelemetryEvent } from "../usage-telemetry";
import type { ExternalUsageEventInput } from "../external-usage-events";
import { setupPrismaSqliteTestDb } from "./setup-test-db";

// ---------------------------------------------------------------------------
// Money-math proof (spec item 4): four owner-directed manual subscription
// adjustment events — two positive Apple-billed prior-tier charges, two
// negative pro-rated upgrade-refund estimates — must flow through the REAL
// ingest validation path (usage-telemetry parsing + persistExternalUsageEvents)
// and net out to +23.13 in computeBudgetStatus's anthropic figures, additively
// on top of whatever else the fixture contains, WITHOUT any max()/clamp
// swallowing the negative amounts.
//
//   21.45 + 124.99 - 19.15 - 104.16 = 23.13
//
// Everything that transitively imports @/lib/prisma is loaded dynamically
// after DATABASE_URL points at the test DB (matches the repo's existing
// lib-test pattern in subscription-materializer.test.ts /
// external-billing-subscription-adoption.test.ts), and the clock is frozen
// with the repo's Date-only fake-clock pattern from PR #293's fixture
// stabilization (vi.useFakeTimers({ toFake: ["Date"] })).
// ---------------------------------------------------------------------------

let dbPath: string;
let prisma: typeof import("@/lib/prisma").prisma;
let parseUsageTelemetryBatch: typeof import("../usage-telemetry").parseUsageTelemetryBatch;
let persistExternalUsageEvents: typeof import("../external-usage-events").persistExternalUsageEvents;
let NegativeSubscriptionWindowLimitExceededError: typeof import("../external-usage-events").NegativeSubscriptionWindowLimitExceededError;
let ExternalUsageIdempotencyCollisionError: typeof import("../external-usage-events").ExternalUsageIdempotencyCollisionError;
let MAX_NEGATIVE_SUBSCRIPTION_WINDOW_COST_USD: typeof import("../external-usage-events").MAX_NEGATIVE_SUBSCRIPTION_WINDOW_COST_USD;
let materializeDueSubscriptions: typeof import("../subscription-materializer").materializeDueSubscriptions;
let computeBudgetStatus: typeof import("../budget-status").computeBudgetStatus;
let initialCycle: typeof import("../subscriptions").initialCycle;

// Frozen "now" the spec calls for: end of the June billing month the four
// events occurred in.
const NOW = new Date("2026-06-30T23:59:00.000Z");
const JUNE_1 = new Date("2026-06-01T00:00:00.000Z");

beforeAll(async () => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "manual-subscription-adjustments-test-")
  );
  dbPath = path.join(dir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  setupPrismaSqliteTestDb(dbPath);

  ({ prisma } = await import("@/lib/prisma"));
  ({ parseUsageTelemetryBatch } = await import("../usage-telemetry"));
  ({
    persistExternalUsageEvents,
    NegativeSubscriptionWindowLimitExceededError,
    ExternalUsageIdempotencyCollisionError,
    MAX_NEGATIVE_SUBSCRIPTION_WINDOW_COST_USD,
  } = await import("../external-usage-events"));
  ({ materializeDueSubscriptions } = await import("../subscription-materializer"));
  ({ computeBudgetStatus } = await import("../budget-status"));
  ({ initialCycle } = await import("../subscriptions"));
}, 60_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (dbPath && fs.existsSync(dbPath)) fs.rmSync(dbPath, { force: true });
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  await prisma.externalUsageEvent.deleteMany();
  await prisma.subscription.deleteMany();
  await prisma.providerPlan.deleteMany();
  await prisma.provider.deleteMany();
});

afterEach(() => {
  vi.useRealTimers();
});

// Mirrors POST /api/ingest/usage's event -> ExternalUsageEventInput mapping
// (src/app/api/ingest/usage/route.ts) exactly, so this test exercises the
// same shape the real route persists, not a hand-rolled shortcut.
function toPersistenceInputs(events: ParsedUsageTelemetryEvent[]) {
  return events.map((event) => ({
    idempotencyKey: event.idempotencyKey,
    sourceApp: event.sourceApp,
    environment: event.environment,
    provider: event.provider,
    service: event.service,
    projectId: null,
    label: event.label,
    keyRef: event.keyRef,
    billingMode: event.billingMode,
    metricType: event.metricType,
    quantity: event.quantity,
    unit: event.unit,
    costUsd: event.costUsd,
    requests: event.requests,
    credits: event.credits,
    limit: event.limit,
    limitWindow: event.limitWindow,
    tier: event.tier,
    confidence: event.confidence,
    windowStart: event.windowStart,
    windowEnd: event.windowEnd,
    occurredAt: event.occurredAt,
    metadata: event.metadata as Prisma.InputJsonObject | undefined,
  }));
}

describe("manual subscription adjustment events — money-math proof", () => {
  it("nets the four owner-directed events to +23.13 in computeBudgetStatus without swallowing the negatives", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "anthropic",
        displayName: "Anthropic",
        type: "builtin",
        refreshIntervalMin: 60,
      },
    });
    await prisma.providerPlan.create({
      data: {
        providerId: provider.id,
        billingMode: "actual",
        monthlyBudgetUsd: 500,
      },
    });

    // Baseline: the CURRENT-term Claude Max 5x Monthly subscription, tracked
    // the ordinary materializer way (sourceApp="subscription"), charged for
    // its June period. Proves the historical manual events land ON TOP OF
    // this and that the current-term row is untouched by them.
    const { currentPeriodStart, nextRenewalAt } = initialCycle({
      startDate: JUNE_1,
      interval: "monthly",
      intervalCount: 1,
      anchorDay: null,
    });
    await prisma.subscription.create({
      data: {
        providerId: provider.id,
        name: "Claude Max 5x Monthly",
        costUsd: 124.99,
        currency: "USD",
        interval: "monthly",
        intervalCount: 1,
        startDate: JUNE_1,
        currentPeriodStart,
        nextRenewalAt,
      },
    });
    const materialized = await materializeDueSubscriptions(NOW);
    expect(materialized).toMatchObject({ charged: 1, eventsWritten: 1 });

    // The four owner-directed manual events, parsed through the REAL ingest
    // validation path (parseUsageTelemetryBatch) exactly as
    // scripts/import-manual-subscription-events.mjs and the ingest route
    // build them, then persisted exactly as the route persists them.
    const parsed = parseUsageTelemetryBatch({
      events: [
        {
          idempotencyKey: "manual-adj:claude-pro-monthly-prior-tier:2026-06-13",
          sourceApp: "manual-billing-adjustment",
          provider: "anthropic",
          billingMode: "manual",
          metricType: "subscription",
          unit: "usd",
          costUsd: 21.45,
          confidence: "actual",
          label: "Claude Pro Monthly (prior tier, Apple)",
          occurredAt: "2026-06-13T00:00:00.000Z",
          metadata: {
            manualAdjustment: true,
            provenance: "apple-receipt",
            tier: "Claude Pro Monthly",
          },
        },
        {
          idempotencyKey: "manual-adj:claude-max-5x-monthly-prior-tier:2026-06-16",
          sourceApp: "manual-billing-adjustment",
          provider: "anthropic",
          billingMode: "manual",
          metricType: "subscription",
          unit: "usd",
          costUsd: 124.99,
          confidence: "actual",
          label: "Claude Max 5x Monthly (prior tier, Apple)",
          occurredAt: "2026-06-16T00:00:00.000Z",
          metadata: {
            manualAdjustment: true,
            provenance: "apple-receipt",
            tier: "Claude Max 5x Monthly",
          },
        },
        {
          idempotencyKey: "manual-adj:upgrade-refund-pro:2026-06-16",
          sourceApp: "manual-billing-adjustment",
          provider: "anthropic",
          billingMode: "manual",
          metricType: "subscription",
          unit: "usd",
          costUsd: -19.15,
          confidence: "estimated",
          label: "Pro-rated upgrade refund (day-count proration estimate)",
          occurredAt: "2026-06-16T00:00:00.000Z",
          metadata: {
            manualAdjustment: true,
            provenance: "day-count-proration-estimate",
            formula: "21.45 * 25 / 28",
          },
        },
        {
          idempotencyKey: "manual-adj:upgrade-refund-max:2026-06-21",
          sourceApp: "manual-billing-adjustment",
          provider: "anthropic",
          billingMode: "manual",
          metricType: "subscription",
          unit: "usd",
          costUsd: -104.16,
          confidence: "estimated",
          label: "Pro-rated upgrade refund (day-count proration estimate)",
          occurredAt: "2026-06-21T00:00:00.000Z",
          metadata: {
            manualAdjustment: true,
            provenance: "day-count-proration-estimate",
            formula: "124.99 * 25 / 30",
          },
        },
      ],
    });
    expect(parsed).toHaveLength(4);
    // The relaxed validation genuinely let the negative amounts through the
    // parser (this is the item-1 acceptance check at the unit level; here it
    // matters because a bug that clamped/rejected them here would make the
    // rest of this test pass for the wrong reason).
    expect(parsed.map((e) => e.costUsd)).toEqual([21.45, 124.99, -19.15, -104.16]);

    const persistResult = await persistExternalUsageEvents(
      toPersistenceInputs(parsed)
    );
    expect(persistResult.persisted).toBe(4);

    // The two refund rows genuinely made it to the database as negative
    // numbers — not stored as zero, not dropped, not sign-flipped.
    const storedNegatives = await prisma.externalUsageEvent.findMany({
      where: { sourceApp: "manual-billing-adjustment", costUsd: { lt: 0 } },
      select: { costUsd: true },
      orderBy: { occurredAt: "asc" },
    });
    expect(storedNegatives.map((e) => e.costUsd)).toEqual([-19.15, -104.16]);

    const budget = await computeBudgetStatus(NOW);
    const anthropic = budget.providers.find((row) => row.id === provider.id);
    expect(anthropic).toBeDefined();

    const netManualAdjustmentUsd = 21.45 + 124.99 - 19.15 - 104.16;
    expect(netManualAdjustmentUsd).toBeCloseTo(23.13, 2);

    // subscriptionMonthToDateUsd (pushed.subscriptionPushed) is the additive
    // sum of EVERY metricType="subscription" event regardless of sourceApp:
    // the $124.99 current-term materializer charge plus the four manual
    // events' net of +23.13.
    expect(anthropic!.subscriptionMonthToDateUsd).toBeCloseTo(
      124.99 + netManualAdjustmentUsd,
      2
    );

    // fixedAccruedUsd is a pure sum (fixedMonthlyCostUsd + subscriptionPushed
    // + snapshotFixedCostIncludedUsd - linkedFixedDedupeUsd); anthropic has no
    // fixed plan cost and no provider cost snapshot here, so it equals
    // subscriptionMonthToDateUsd exactly. This is the composition the spec
    // asked to verify is additive, not max()-based.
    expect(anthropic!.fixedAccruedUsd).toBeCloseTo(
      124.99 + netManualAdjustmentUsd,
      2
    );

    // usageCost is observed variable usage only (receipt funding is separate);
    // both usage and receipts are 0 here, so spentUsd = fixedAccruedUsd exactly —
    // the negatives are not swallowed anywhere on the way to spentUsd.
    const expectedSpentUsd = 124.99 + netManualAdjustmentUsd;
    expect(anthropic!.spentUsd).toBeCloseTo(expectedSpentUsd, 2);
    expect(expectedSpentUsd).toBeCloseTo(148.12, 2);

    // Negative-swallowing sentinel: if fixedAccruedUsd (or any composition
    // upstream of it) ran the manual events through Math.max(0, ...) per
    // event or summed only positives, spentUsd would land at 124.99 + 21.45 +
    // 124.99 = 271.43 instead. Assert the two are NOT equal so a future
    // clamp regression fails loudly here, not just via the toBeCloseTo above.
    const wouldBeIfNegativesSwallowed = 124.99 + 21.45 + 124.99;
    expect(anthropic!.spentUsd).not.toBeCloseTo(wouldBeIfNegativesSwallowed, 2);

    // The current-term materializer-owned row is untouched: still exactly one
    // "subscription" sourceApp event, still $124.99.
    const currentTermEvents = await prisma.externalUsageEvent.findMany({
      where: { sourceApp: "subscription", metricType: "subscription" },
    });
    expect(currentTermEvents).toHaveLength(1);
    expect(currentTermEvents[0].costUsd).toBe(124.99);

    // percentUsed / spentUsd reflect the net reduction from the refunds
    // relative to a world where only the two positive charges landed.
    expect(anthropic!.percentUsed).toBeCloseTo(expectedSpentUsd / 500, 4);
  });
});

// ---------------------------------------------------------------------------
// Trailing-30-day cumulative negative-adjustment bound (audit finding
// "negative-adjustment-abuse"; PR #884 claimed this and never shipped it).
// The window is keyed on server-stamped createdAt — NOT producer-controlled
// occurredAt — and the check runs inside the same transaction as the insert,
// counting only NEW rows (idempotent replays must never double-count).
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

function subscriptionAdjustmentInput(
  idempotencyKey: string,
  costUsd: number,
  overrides: Partial<ExternalUsageEventInput> = {}
): ExternalUsageEventInput {
  return {
    idempotencyKey,
    sourceApp: "manual-billing-adjustment",
    provider: "anthropic",
    billingMode: "manual",
    metricType: "subscription",
    unit: "usd",
    costUsd,
    confidence: "estimated",
    occurredAt: new Date(NOW.getTime() - 1 * DAY_MS),
    ...overrides,
  };
}

// Seed an ALREADY-persisted negative adjustment directly, with an explicit
// server-receipt createdAt (and a deliberately unrelated, much older
// occurredAt so any regression back to an occurredAt-keyed window would show
// up as these rows escaping the window).
async function seedPersistedNegative(
  idempotencyKey: string,
  costUsd: number,
  createdAt: Date
) {
  await prisma.externalUsageEvent.create({
    data: {
      idempotencyKey,
      sourceApp: "manual-billing-adjustment",
      provider: "anthropic",
      billingMode: "manual",
      metricType: "subscription",
      unit: "usd",
      costUsd,
      confidence: "estimated",
      occurredAt: new Date(NOW.getTime() - 60 * DAY_MS),
      createdAt,
    },
  });
}

describe("trailing-30-day cumulative negative subscription adjustment bound", () => {
  // In-window persisted negatives summing $4,600 magnitude, with backdated
  // occurredAt (60d ago) proving the window keys on createdAt, plus one
  // OUT-of-window -$800 that must not count.
  async function seedWindowFixture() {
    await seedPersistedNegative("seed-neg-1", -1000, new Date(NOW.getTime() - 20 * DAY_MS));
    await seedPersistedNegative("seed-neg-2", -1000, new Date(NOW.getTime() - 20 * DAY_MS));
    await seedPersistedNegative("seed-neg-3", -1000, new Date(NOW.getTime() - 15 * DAY_MS));
    await seedPersistedNegative("seed-neg-4", -1000, new Date(NOW.getTime() - 10 * DAY_MS));
    await seedPersistedNegative("seed-neg-5", -600, new Date(NOW.getTime() - 5 * DAY_MS));
    await seedPersistedNegative("seed-neg-out-of-window", -800, new Date(NOW.getTime() - 40 * DAY_MS));
  }

  it("rejects an incoming batch that would push the in-window cumulative magnitude past the bound, persisting nothing", async () => {
    await seedWindowFixture();
    const before = await prisma.externalUsageEvent.count();

    await expect(
      persistExternalUsageEvents([
        subscriptionAdjustmentInput("incoming-neg-500", -500),
        // A positive rider in the same batch must roll back with it.
        subscriptionAdjustmentInput("incoming-pos-50", 50),
      ])
    ).rejects.toBeInstanceOf(NegativeSubscriptionWindowLimitExceededError);

    // 4600 (in-window) + 500 (incoming) = 5100 > 5000. The whole batch rolled
    // back: neither the negative nor the positive rider was inserted.
    expect(await prisma.externalUsageEvent.count()).toBe(before);
  });

  it("accepts an incoming batch that stays within the bound — out-of-window negatives do not count", async () => {
    await seedWindowFixture();

    // 4600 + 300 = 4900 <= 5000 accepted. If the -800 row outside the window
    // (or its backdated occurredAt cousins) were counted, this would be 5700
    // and reject — this is the window-scoping proof.
    const result = await persistExternalUsageEvents([
      subscriptionAdjustmentInput("incoming-neg-300", -300),
    ]);
    expect(result.persisted).toBe(1);
    const stored = await prisma.externalUsageEvent.findUniqueOrThrow({
      where: { idempotencyKey: "incoming-neg-300" },
    });
    expect(stored.costUsd).toBe(-300);
  });

  it("accepts a batch landing exactly on the window bound (inclusive boundary)", async () => {
    await seedWindowFixture();
    // 4600 + 400 = 5000 exactly.
    expect(MAX_NEGATIVE_SUBSCRIPTION_WINDOW_COST_USD).toBe(5000);
    const result = await persistExternalUsageEvents([
      subscriptionAdjustmentInput("incoming-neg-400", -400),
    ]);
    expect(result.persisted).toBe(1);
  });

  it("does not double-count an idempotent replay against the window", async () => {
    await seedWindowFixture();
    const batch = [subscriptionAdjustmentInput("incoming-neg-replay", -300)];

    const first = await persistExternalUsageEvents(batch);
    expect(first.persisted).toBe(1);

    // In-window persisted magnitude is now 4900. A replay of the same batch
    // must dedupe cleanly: its event is not a NEW row, so it contributes $0
    // to the incoming sum. An implementation that summed the submitted batch
    // instead of the newly-inserted rows would compute 4900 + 300 = 5200 and
    // reject this legitimate retry.
    const replay = await persistExternalUsageEvents(
      batch.map((event) => ({ ...event }))
    );
    expect(replay.persisted).toBe(0);
    expect(replay.attempted).toBe(1);
    const rows = await prisma.externalUsageEvent.count({
      where: { idempotencyKey: "incoming-neg-replay" },
    });
    expect(rows).toBe(1);
  });

  it("skips the window check entirely for positive and non-subscription batches near identical dollar figures", async () => {
    await seedWindowFixture();
    // $10,000 of positive subscription charges and ordinary usage cost —
    // far past the window bound's dollar figure — must persist untouched.
    const result = await persistExternalUsageEvents([
      subscriptionAdjustmentInput("incoming-pos-10000", 10_000),
      subscriptionAdjustmentInput("incoming-usage-cost", 10_000, {
        metricType: "cost",
        billingMode: "estimated",
        sourceApp: "socratic-trade",
        provider: "openai",
      }),
    ]);
    expect(result.persisted).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// #887 replay-409 regression: rows ingested BEFORE the top-level `project`
// field became authoritative stored the producer's raw metadata.project
// verbatim. A byte-identical replay now arrives with the validated top-level
// project stamped into metadata.project (route.ts) and carried as
// authoritativeProject. That replay must dedupe and update the stored name —
// never throw a whole-batch, non-retryable idempotency 409. Genuine
// conflicts on any other field must still 409.
// ---------------------------------------------------------------------------

describe("pre-authoritative-project replay dedupe (#887 regression)", () => {
  const REPLAY_KEY = "pre887-producer-project-row";
  const OCCURRED_AT = new Date("2026-06-20T00:00:00.000Z");

  // The file-level beforeEach clears events but not Projects; the
  // live-Project tests below create rows whose names would otherwise leak
  // into the name-resolution checks of later tests. Events are already gone
  // when this runs (file-level hook runs first), so the FK is clear.
  beforeEach(async () => {
    await prisma.project.deleteMany();
  });

  // A row shaped exactly as pre-#887 ingest persisted it: the producer's own
  // metadata.project ("Beta") stored verbatim even though the wire batch
  // carried top-level project "Alpha".
  async function seedPreFixRow() {
    await prisma.externalUsageEvent.create({
      data: {
        idempotencyKey: REPLAY_KEY,
        sourceApp: "socratic-trade",
        provider: "openai",
        billingMode: "estimated",
        metricType: "usage",
        unit: "token",
        quantity: 1200,
        costUsd: 1.23,
        confidence: "estimated",
        occurredAt: OCCURRED_AT,
        metadata: { project: "Beta", lane: "rag" },
      },
    });
  }

  function replayInput(
    overrides: Partial<ExternalUsageEventInput> = {}
  ): ExternalUsageEventInput {
    return {
      idempotencyKey: REPLAY_KEY,
      sourceApp: "socratic-trade",
      provider: "openai",
      billingMode: "estimated",
      metricType: "usage",
      unit: "token",
      quantity: 1200,
      costUsd: 1.23,
      confidence: "estimated",
      occurredAt: OCCURRED_AT,
      // Post-#887 the route stamps the validated top-level project into
      // metadata.project and carries it as authoritativeProject.
      metadata: { project: "Alpha", lane: "rag" },
      authoritativeProject: "Alpha",
      projectId: null,
      ...overrides,
    };
  }

  it("dedupes (not 409) a byte-identical replay whose only divergence is the stored producer-era metadata.project, and stamps the authoritative name", async () => {
    await seedPreFixRow();

    const result = await persistExternalUsageEvents([replayInput()]);
    expect(result.attempted).toBe(1);
    expect(result.persisted).toBe(0);

    const stored = await prisma.externalUsageEvent.findUniqueOrThrow({
      where: { idempotencyKey: REPLAY_KEY },
    });
    // Authoritative value written onto the stored row; unrelated producer
    // metadata retained.
    expect(stored.metadata).toEqual({ project: "Alpha", lane: "rag" });
  });

  it("still 409s a replay that differs on a genuine field (costUsd) even with an authoritative project", async () => {
    await seedPreFixRow();

    await expect(
      persistExternalUsageEvents([replayInput({ costUsd: 9.99 })])
    ).rejects.toBeInstanceOf(ExternalUsageIdempotencyCollisionError);

    // The stored row is untouched — no partial metadata update leaked out of
    // the rolled-back transaction.
    const stored = await prisma.externalUsageEvent.findUniqueOrThrow({
      where: { idempotencyKey: REPLAY_KEY },
    });
    expect(stored.costUsd).toBe(1.23);
    expect(stored.metadata).toEqual({ project: "Beta", lane: "rag" });
  });

  it("still 409s a producer-metadata project conflict when no authoritative top-level project accompanies it", async () => {
    await seedPreFixRow();

    await expect(
      persistExternalUsageEvents([
        replayInput({ authoritativeProject: undefined }),
      ])
    ).rejects.toBeInstanceOf(ExternalUsageIdempotencyCollisionError);
  });

  it("still 409s when the stored row already carries a resolved projectId — attributed rows are never reattributed", async () => {
    const alpha = await prisma.project.create({
      data: { name: "AttrAlpha", nameKey: "attralpha" },
    });
    await seedPreFixRow();
    await prisma.externalUsageEvent.update({
      where: { idempotencyKey: REPLAY_KEY },
      data: { projectId: alpha.id },
    });

    await expect(
      persistExternalUsageEvents([replayInput()])
    ).rejects.toBeInstanceOf(ExternalUsageIdempotencyCollisionError);

    // Neither the FK nor the stored name moved: no contradictory
    // projectId/metadata.project pair can be produced by a replay.
    const stored = await prisma.externalUsageEvent.findUniqueOrThrow({
      where: { idempotencyKey: REPLAY_KEY },
    });
    expect(stored.projectId).toBe(alpha.id);
    expect(stored.metadata).toEqual({ project: "Beta", lane: "rag" });
  });

  it("still 409s when the stored producer-era name matches a live Project — money is never silently moved between real projects", async () => {
    await prisma.project.create({
      data: { name: "Beta", nameKey: "beta" },
    });
    await seedPreFixRow();

    await expect(
      persistExternalUsageEvents([replayInput()])
    ).rejects.toBeInstanceOf(ExternalUsageIdempotencyCollisionError);

    const stored = await prisma.externalUsageEvent.findUniqueOrThrow({
      where: { idempotencyKey: REPLAY_KEY },
    });
    expect(stored.metadata).toEqual({ project: "Beta", lane: "rag" });
  });

  it("documents the accepted residual: successive authoritative sends over an unresolved name update last-writer-wins", async () => {
    // Neither "Beta" (stored) nor "Alpha"/"Gamma" (incoming) resolve to a
    // Project row, and the stored row has no projectId — so no live
    // attribution is affected either way. The override deliberately accepts
    // the newest authoritative name rather than freezing the first one.
    await seedPreFixRow();

    await persistExternalUsageEvents([replayInput()]);
    let stored = await prisma.externalUsageEvent.findUniqueOrThrow({
      where: { idempotencyKey: REPLAY_KEY },
    });
    expect(stored.metadata).toEqual({ project: "Alpha", lane: "rag" });

    await persistExternalUsageEvents([
      replayInput({
        metadata: { project: "Gamma", lane: "rag" },
        authoritativeProject: "Gamma",
      }),
    ]);
    stored = await prisma.externalUsageEvent.findUniqueOrThrow({
      where: { idempotencyKey: REPLAY_KEY },
    });
    expect(stored.metadata).toEqual({ project: "Gamma", lane: "rag" });
  });
});
