import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { NextRequest } from "next/server";
import { setupPrismaSqliteTestDb } from "./setup-test-db";

let dbPath: string;
let prisma: typeof import("@/lib/prisma").prisma;
let contenderPrisma: import("@prisma/client").PrismaClient;
let adoptExternalBillingSubscriptions: typeof import("../external-billing-subscription-adoption").adoptExternalBillingSubscriptions;
let externalAdoptionGuardKey: typeof import("../external-billing-subscription-adoption").externalAdoptionGuardKey;
let materializeDueSubscriptions: typeof import("../subscription-materializer").materializeDueSubscriptions;
let computeBudgetStatus: typeof import("../budget-status").computeBudgetStatus;
let fetchCloudflareUsage: typeof import("../adapters/cloudflare").fetchUsage;
let reconcileProviderExternalBilling: typeof import("../provider-external-billing").reconcileProviderExternalBilling;
let updateSubscription: typeof import("@/app/api/subscriptions/[id]/route").PUT;
let createSubscription: typeof import("@/app/api/subscriptions/route").POST;
let createSessionToken: typeof import("@/lib/auth").createSessionToken;
let SESSION_COOKIE_NAME: typeof import("@/lib/auth").SESSION_COOKIE_NAME;

const NOW = new Date("2026-07-15T12:00:00.000Z");
const PERIOD_START = new Date("2026-07-01T00:00:00.000Z");
const PERIOD_END = new Date("2026-08-01T00:00:00.000Z");

beforeAll(async () => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "external-billing-adoption-test-")
  );
  dbPath = path.join(dir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.DASHBOARD_PASSWORD = "external-adoption-test-password";
  process.env.SESSION_SECRET = "test-session-secret";
  setupPrismaSqliteTestDb(dbPath);

  ({ prisma } = await import("@/lib/prisma"));
  const { createPrismaClient } = await import("@/lib/create-prisma-client");
  contenderPrisma = createPrismaClient();
  ({ adoptExternalBillingSubscriptions, externalAdoptionGuardKey } =
    await import("../external-billing-subscription-adoption"));
  ({ materializeDueSubscriptions } = await import(
    "../subscription-materializer"
  ));
  ({ computeBudgetStatus } = await import("../budget-status"));
  ({ fetchUsage: fetchCloudflareUsage } = await import("../adapters/cloudflare"));
  ({ reconcileProviderExternalBilling } = await import(
    "../provider-external-billing"
  ));
  ({ PUT: updateSubscription } = await import(
    "@/app/api/subscriptions/[id]/route"
  ));
  ({ POST: createSubscription } = await import(
    "@/app/api/subscriptions/route"
  ));
  ({ createSessionToken, SESSION_COOKIE_NAME } = await import("@/lib/auth"));
}, 60_000);

afterAll(async () => {
  await contenderPrisma?.$disconnect();
  await prisma?.$disconnect();
  if (dbPath && fs.existsSync(dbPath)) fs.rmSync(dbPath, { force: true });
});

describe("adoptExternalBillingSubscriptions", () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    delete process.env.CLOUDFLARE_LEGACY_HANDOFF_SUBSCRIPTION_ID;
    await prisma.externalUsageEvent.deleteMany();
    await prisma.subscription.deleteMany();
    await prisma.providerExternalBilling.deleteMany();
    await prisma.usageSnapshot.deleteMany();
    await prisma.providerPlan.deleteMany();
    await prisma.provider.deleteMany();
    await prisma.project.deleteMany();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  async function createProvider(name = "cloudflare") {
    return prisma.provider.create({
      data: {
        name,
        displayName: name,
        type: "builtin",
        refreshIntervalMin: 60,
      },
    });
  }

  async function createExternalBilling(
    providerId: string,
    externalId: string,
    extra: Record<string, unknown> = {}
  ) {
    return prisma.providerExternalBilling.create({
      data: {
        providerId,
        source: "cloudflare-subscriptions",
        externalId,
        paidRecurringAuthoritative: true,
        kind: "subscription",
        serviceName: "Workers Paid",
        planName: "Paid",
        status: "paid",
        amountUsd: 5,
        currency: "USD",
        billingInterval: "monthly",
        currentPeriodStart: PERIOD_START,
        currentPeriodEnd: PERIOD_END,
        nextRenewalAt: PERIOD_END,
        rollupRole: "canonical",
        dateKind: "renewal",
        syncedAt: NOW,
        ...extra,
      },
    });
  }

  async function createLegacyCloudflareSubscription(
    providerId: string,
    externalId = "workers-paid",
    extra: Record<string, unknown> = {}
  ) {
    const subscription = await prisma.subscription.create({
      data: {
        providerId,
        externalBillingSource: "cloudflare-subscriptions",
        externalBillingId: externalId,
        externalBillingManaged: false,
        externalAdoptionGuardKey: null,
        name: "Cloudflare Workers Paid (Congress.Trade)",
        description: "Owner-entered legacy subscription",
        costUsd: 5,
        currency: "USD",
        interval: "monthly",
        intervalCount: 1,
        startDate: new Date("2026-06-15T00:00:00.000Z"),
        currentPeriodStart: PERIOD_START,
        nextRenewalAt: PERIOD_END,
        autoRenew: true,
        status: "active",
        notes: "Preserve this owner note",
        knobEnv: { CLOUDFLARE_WORKERS_PAID: "true" },
        ...extra,
      },
    });
    expect(await materializeDueSubscriptions(NOW)).toMatchObject({
      charged: 1,
      eventsWritten: 1,
    });
    return prisma.subscription.findUniqueOrThrow({
      where: { id: subscription.id },
    });
  }

  async function releaseManagedExternalIdentity(providerId: string) {
    const managed = await prisma.subscription.findFirstOrThrow({
      where: { providerId, externalBillingManaged: true },
      select: { id: true },
    });
    await prisma.subscription.update({
      where: { id: managed.id },
      data: {
        externalBillingSource: null,
        externalBillingId: null,
        externalBillingManaged: false,
      },
    });
    return managed;
  }

  function ownerCreateRequest(body: unknown): NextRequest {
    return new NextRequest("https://usage.jays.services/api/subscriptions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}`,
      },
      body: JSON.stringify(body),
    });
  }

  it("adopts Cloudflare billing and charges its current period exactly once", async () => {
    const provider = await createProvider();
    await prisma.providerPlan.create({
      data: {
        providerId: provider.id,
        billingMode: "actual",
        monthlyBudgetUsd: 100,
      },
    });
    await createExternalBilling(provider.id, "workers-paid");
    await prisma.usageSnapshot.create({
      data: {
        providerId: provider.id,
        fetchedAt: NOW,
        totalCost: 5,
        fixedCostIncludedUsd: 5,
      },
    });

    const adopted = await adoptExternalBillingSubscriptions(NOW);
    expect(adopted).toEqual({
      examined: 1,
      eligible: 1,
      adopted: 1,
      existing: 0,
      ambiguous: 0,
      reconciled: 0,
      deactivated: 0,
      raced: 0,
      cloudflareLegacyHandoff: "disabled",
    });
    expect(await prisma.subscription.findFirst()).toMatchObject({
      providerId: provider.id,
      externalBillingSource: "cloudflare-subscriptions",
      externalBillingId: "workers-paid",
      name: "Workers Paid",
      costUsd: 5,
      currency: "USD",
      interval: "monthly",
      intervalCount: 1,
      currentPeriodStart: PERIOD_START,
      nextRenewalAt: PERIOD_END,
      externalBillingManaged: true,
      autoRenew: false,
      status: "active",
    });

    const firstMaterialization = await materializeDueSubscriptions(NOW);
    const secondAdoption = await adoptExternalBillingSubscriptions(NOW);
    const secondMaterialization = await materializeDueSubscriptions(NOW);
    expect(firstMaterialization).toMatchObject({ charged: 1, eventsWritten: 1 });
    expect(secondAdoption).toMatchObject({ adopted: 0, existing: 1 });
    expect(secondMaterialization).toMatchObject({ charged: 0, eventsWritten: 0 });
    expect(
      await prisma.externalUsageEvent.count({
        where: { provider: "cloudflare", metricType: "subscription" },
      })
    ).toBe(1);

    const budget = await computeBudgetStatus(NOW);
    const cloudflare = budget.providers.find((row) => row.id === provider.id);
    expect(cloudflare).toMatchObject({
      subscriptionMonthToDateUsd: 5,
      snapshotFixedCostIncludedUsd: 5,
      linkedFixedDedupeUsd: 5,
      fixedCostConflict: false,
      spentUsd: 5,
    });
  });

  it("pauses a charged same-period repricing and dedupes the corrected snapshot", async () => {
    const provider = await createProvider("charged-reprice-provider");
    await createExternalBilling(provider.id, "charged-reprice-plan");
    await adoptExternalBillingSubscriptions(NOW);
    await materializeDueSubscriptions(NOW);

    await prisma.providerExternalBilling.update({
      where: {
        providerId_source_externalId: {
          providerId: provider.id,
          source: "cloudflare-subscriptions",
          externalId: "charged-reprice-plan",
        },
      },
      data: { amountUsd: 6, syncedAt: NOW },
    });
    await prisma.usageSnapshot.create({
      data: {
        providerId: provider.id,
        fetchedAt: NOW,
        totalCost: 6,
        fixedCostIncludedUsd: 6,
      },
    });

    const reconciled = await adoptExternalBillingSubscriptions(NOW);
    const rematerialized = await materializeDueSubscriptions(NOW);
    const stored = await prisma.subscription.findFirst({
      where: { providerId: provider.id },
    });

    expect(reconciled).toMatchObject({
      adopted: 0,
      existing: 1,
      ambiguous: 1,
      deactivated: 1,
    });
    expect(stored).toMatchObject({
      costUsd: 5,
      name: "Workers Paid",
      interval: "monthly",
      currentPeriodStart: PERIOD_START,
      nextRenewalAt: PERIOD_END,
      externalAdoptionGuardKey: externalAdoptionGuardKey(
        provider.id,
        500,
        "monthly"
      ),
      status: "paused",
      autoRenew: false,
    });
    expect(rematerialized).toMatchObject({ charged: 0, eventsWritten: 0 });
    expect(await prisma.externalUsageEvent.count()).toBe(1);

    const budget = await computeBudgetStatus(NOW);
    expect(budget.providers.find((row) => row.id === provider.id)).toMatchObject({
      subscriptionMonthToDateUsd: 5,
      snapshotFixedCostIncludedUsd: 6,
      linkedFixedDedupeUsd: 5,
      fixedCostConflict: false,
      spentUsd: 6,
    });
  });

  it("settles an exact owner-linked repricing without charging twice", async () => {
    const provider = await createProvider("charged-reprice-collision-provider");
    await createExternalBilling(provider.id, "charged-reprice-collision-plan");
    await adoptExternalBillingSubscriptions(NOW);
    await materializeDueSubscriptions(NOW);
    const originalGuard = externalAdoptionGuardKey(
      provider.id,
      500,
      "monthly"
    );
    const correctedGuard = externalAdoptionGuardKey(
      provider.id,
      600,
      "monthly"
    );

    await prisma.providerExternalBilling.update({
      where: {
        providerId_source_externalId: {
          providerId: provider.id,
          source: "cloudflare-subscriptions",
          externalId: "charged-reprice-collision-plan",
        },
      },
      data: { amountUsd: 6, syncedAt: NOW },
    });
    const reconciled = await adoptExternalBillingSubscriptions(NOW);
    await releaseManagedExternalIdentity(provider.id);
    const createResponse = await createSubscription(
      ownerCreateRequest({
        providerId: provider.id,
        externalBillingSource: "cloudflare-subscriptions",
        externalBillingId: "charged-reprice-collision-plan",
        name: "Owner-entered corrected price",
        costUsd: 6,
        currency: "USD",
        interval: "monthly",
        intervalCount: 1,
        autoRenew: false,
        status: "active",
      })
    );
    expect(createResponse.status).toBe(201);
    const manual = (await createResponse.json()) as { id: string };

    const rematerialized = await materializeDueSubscriptions(NOW);
    const subscriptions = await prisma.subscription.findMany({
      where: { providerId: provider.id },
      orderBy: { costUsd: "asc" },
    });

    expect(reconciled).toMatchObject({
      adopted: 0,
      existing: 1,
      ambiguous: 1,
      deactivated: 1,
    });
    expect(subscriptions).toHaveLength(2);
    expect(subscriptions[0]).toMatchObject({
      costUsd: 5,
      externalAdoptionGuardKey: originalGuard,
      status: "paused",
    });
    expect(subscriptions[1]).toMatchObject({
      id: manual.id,
      name: "Owner-entered corrected price",
      costUsd: 6,
      externalAdoptionGuardKey: correctedGuard,
      externalBillingSource: "cloudflare-subscriptions",
      externalBillingId: "charged-reprice-collision-plan",
      externalBillingManaged: false,
      status: "active",
      autoRenew: false,
      lastChargedPeriodStart: PERIOD_START,
    });
    expect(rematerialized).toMatchObject({ charged: 0, eventsWritten: 0 });
    expect(await prisma.externalUsageEvent.count()).toBe(1);
  });

  it("revokes correction settlement when the owner unlinks before materialization", async () => {
    const provider = await createProvider("unlink-revokes-settlement-provider");
    const externalId = "unlink-revokes-settlement-plan";
    await createExternalBilling(provider.id, externalId);
    await adoptExternalBillingSubscriptions(NOW);
    await materializeDueSubscriptions(NOW);
    await prisma.providerExternalBilling.update({
      where: {
        providerId_source_externalId: {
          providerId: provider.id,
          source: "cloudflare-subscriptions",
          externalId,
        },
      },
      data: { amountUsd: 6, syncedAt: NOW },
    });
    await adoptExternalBillingSubscriptions(NOW);
    await releaseManagedExternalIdentity(provider.id);
    const createResponse = await createSubscription(
      ownerCreateRequest({
        providerId: provider.id,
        externalBillingSource: "cloudflare-subscriptions",
        externalBillingId: externalId,
        name: "Owner term to unlink",
        costUsd: 6,
        interval: "monthly",
        intervalCount: 1,
        autoRenew: false,
      })
    );
    expect(createResponse.status).toBe(201);
    const owner = (await createResponse.json()) as { id: string };

    const unlinkResponse = await updateSubscription(
      new Request(`https://usage.jays.services/api/subscriptions/${owner.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          externalBillingSource: null,
          externalBillingId: null,
        }),
      }),
      { params: Promise.resolve({ id: owner.id }) }
    );
    expect(unlinkResponse.status).toBe(200);
    expect(
      await prisma.subscription.findUnique({ where: { id: owner.id } })
    ).toMatchObject({
      externalBillingSource: null,
      externalBillingId: null,
      externalAdoptionGuardKey: null,
      externalBillingManaged: false,
    });

    expect(await materializeDueSubscriptions(NOW)).toMatchObject({
      charged: 1,
      eventsWritten: 1,
    });
    expect(
      await prisma.externalUsageEvent.findMany({ select: { metadata: true } })
    ).toContainEqual({
      metadata: expect.objectContaining({ subscriptionId: owner.id }),
    });
  });

  it("keeps an unrelated same-price cadence and window service additive", async () => {
    const provider = await createProvider("same-shape-unrelated-provider");
    const correctedExternalId = "workers-corrected-plan";
    await createExternalBilling(provider.id, correctedExternalId);
    await adoptExternalBillingSubscriptions(NOW);
    await materializeDueSubscriptions(NOW);

    await prisma.providerExternalBilling.update({
      where: {
        providerId_source_externalId: {
          providerId: provider.id,
          source: "cloudflare-subscriptions",
          externalId: correctedExternalId,
        },
      },
      data: { amountUsd: 6, syncedAt: NOW },
    });
    await adoptExternalBillingSubscriptions(NOW);
    await prisma.usageSnapshot.create({
      data: {
        providerId: provider.id,
        fetchedAt: NOW,
        totalCost: 6,
        fixedCostIncludedUsd: 6,
      },
    });
    await createExternalBilling(provider.id, "queues-independent-plan", {
      serviceName: "Queues Paid",
      planName: "Queues Paid",
      amountUsd: 6,
    });
    const createResponse = await createSubscription(
      ownerCreateRequest({
        providerId: provider.id,
        externalBillingSource: "cloudflare-subscriptions",
        externalBillingId: "queues-independent-plan",
        name: "Owner-linked Queues Paid",
        costUsd: 6,
        currency: "USD",
        interval: "monthly",
        intervalCount: 1,
        autoRenew: false,
        status: "active",
      })
    );
    expect(createResponse.status).toBe(201);
    const unrelated = (await createResponse.json()) as { id: string };
    expect(
      await prisma.subscription.findUnique({ where: { id: unrelated.id } })
    ).toMatchObject({
      externalBillingSource: "cloudflare-subscriptions",
      externalBillingId: "queues-independent-plan",
      externalAdoptionGuardKey: externalAdoptionGuardKey(
        provider.id,
        600,
        "monthly"
      ),
      externalBillingManaged: false,
    });

    const materialized = await materializeDueSubscriptions(NOW);
    expect(materialized).toMatchObject({ charged: 1, eventsWritten: 1 });
    expect(
      await prisma.externalUsageEvent.findMany({
        orderBy: { costUsd: "asc" },
        select: { costUsd: true, metadata: true },
      })
    ).toEqual([
      {
        costUsd: 5,
        metadata: expect.not.objectContaining({ subscriptionId: unrelated.id }),
      },
      {
        costUsd: 6,
        metadata: expect.objectContaining({ subscriptionId: unrelated.id }),
      },
    ]);
    expect(
      await prisma.subscription.findUnique({ where: { id: unrelated.id } })
    ).toMatchObject({ lastChargedPeriodStart: PERIOD_START });
    expect(
      (await computeBudgetStatus(NOW)).providers.find(
        (row) => row.id === provider.id
      )
    ).toMatchObject({
      subscriptionMonthToDateUsd: 11,
      snapshotFixedCostIncludedUsd: 6,
      // The provider snapshot does not identify which of two exact $6 services
      // it includes. Preserve both events and surface ambiguity instead of
      // spending one service's proof against the other.
      linkedFixedDedupeUsd: 0,
      fixedCostConflict: true,
      spentUsd: 17,
    });
  });

  it("fails open for a legacy same-shape guard with no declared identity", async () => {
    const provider = await createProvider("legacy-unlinked-guard-provider");
    const externalId = "legacy-unlinked-guard-plan";
    await createExternalBilling(provider.id, externalId);
    await adoptExternalBillingSubscriptions(NOW);
    await materializeDueSubscriptions(NOW);
    await prisma.providerExternalBilling.update({
      where: {
        providerId_source_externalId: {
          providerId: provider.id,
          source: "cloudflare-subscriptions",
          externalId,
        },
      },
      data: { amountUsd: 6, syncedAt: NOW },
    });
    await adoptExternalBillingSubscriptions(NOW);
    const legacy = await prisma.subscription.create({
      data: {
        providerId: provider.id,
        externalAdoptionGuardKey: externalAdoptionGuardKey(
          provider.id,
          600,
          "monthly"
        ),
        name: "Legacy unlinked same-shape charge",
        costUsd: 6,
        currency: "USD",
        interval: "monthly",
        intervalCount: 1,
        startDate: PERIOD_START,
        currentPeriodStart: PERIOD_START,
        nextRenewalAt: PERIOD_END,
        autoRenew: false,
        status: "active",
      },
    });

    expect(await materializeDueSubscriptions(NOW)).toMatchObject({
      charged: 1,
      eventsWritten: 1,
    });
    expect(
      await prisma.externalUsageEvent.findMany({ select: { metadata: true } })
    ).toContainEqual({
      metadata: expect.objectContaining({ subscriptionId: legacy.id }),
    });
  });

  it("does not spend owner-settlement proof on an auto-managed replacement", async () => {
    const provider = await createProvider("managed-replacement-provider");
    const externalId = "managed-replacement-plan";
    await createExternalBilling(provider.id, externalId);
    await adoptExternalBillingSubscriptions(NOW);
    await materializeDueSubscriptions(NOW);
    await prisma.providerExternalBilling.update({
      where: {
        providerId_source_externalId: {
          providerId: provider.id,
          source: "cloudflare-subscriptions",
          externalId,
        },
      },
      data: { amountUsd: 6, syncedAt: NOW },
    });
    await adoptExternalBillingSubscriptions(NOW);
    const oldManaged = await prisma.subscription.findFirstOrThrow({
      where: { providerId: provider.id, externalBillingManaged: true },
      select: { id: true },
    });
    await prisma.subscription.delete({ where: { id: oldManaged.id } });
    const replacement = await prisma.subscription.create({
      data: {
        providerId: provider.id,
        externalBillingSource: "cloudflare-subscriptions",
        externalBillingId: externalId,
        externalBillingManaged: true,
        externalAdoptionGuardKey: externalAdoptionGuardKey(
          provider.id,
          600,
          "monthly"
        ),
        name: "Replacement managed term",
        costUsd: 6,
        currency: "USD",
        interval: "monthly",
        intervalCount: 1,
        startDate: PERIOD_START,
        currentPeriodStart: PERIOD_START,
        nextRenewalAt: PERIOD_END,
        autoRenew: false,
        status: "active",
      },
    });

    expect(await materializeDueSubscriptions(NOW)).toMatchObject({
      charged: 1,
      eventsWritten: 1,
    });
    expect(
      await prisma.externalUsageEvent.findMany({ select: { metadata: true } })
    ).toContainEqual({
      metadata: expect.objectContaining({ subscriptionId: replacement.id }),
    });
  });

  it("materializes earlier due inputs before settling only the overlapping period", async () => {
    const provider = await createProvider("multi-period-settlement-provider");
    await createExternalBilling(provider.id, "multi-period-settlement-plan");
    await adoptExternalBillingSubscriptions(NOW);
    await materializeDueSubscriptions(NOW);

    await prisma.providerExternalBilling.update({
      where: {
        providerId_source_externalId: {
          providerId: provider.id,
          source: "cloudflare-subscriptions",
          externalId: "multi-period-settlement-plan",
        },
      },
      data: { amountUsd: 6, syncedAt: NOW },
    });
    await adoptExternalBillingSubscriptions(NOW);
    await releaseManagedExternalIdentity(provider.id);
    const juneStart = new Date("2026-06-01T00:00:00.000Z");
    const manual = await prisma.subscription.create({
      data: {
        providerId: provider.id,
        externalBillingSource: "cloudflare-subscriptions",
        externalBillingId: "multi-period-settlement-plan",
        externalAdoptionGuardKey: externalAdoptionGuardKey(
          provider.id,
          600,
          "monthly"
        ),
        name: "Owner multi-period corrected price",
        costUsd: 6,
        currency: "USD",
        interval: "monthly",
        intervalCount: 1,
        startDate: juneStart,
        currentPeriodStart: juneStart,
        nextRenewalAt: PERIOD_START,
        autoRenew: true,
        status: "active",
      },
    });

    const first = await materializeDueSubscriptions(NOW);
    const second = await materializeDueSubscriptions(NOW);
    const events = await prisma.externalUsageEvent.findMany({
      where: { provider: provider.name, metricType: "subscription" },
      orderBy: { occurredAt: "asc" },
      select: { costUsd: true, occurredAt: true, metadata: true },
    });

    expect(first).toMatchObject({ charged: 1, eventsWritten: 1 });
    expect(second).toMatchObject({ charged: 0, eventsWritten: 0 });
    expect(events).toEqual([
      {
        costUsd: 6,
        occurredAt: juneStart,
        metadata: expect.objectContaining({ subscriptionId: manual.id }),
      },
      {
        costUsd: 5,
        occurredAt: PERIOD_START,
        metadata: expect.not.objectContaining({ subscriptionId: manual.id }),
      },
    ]);
    expect(
      events.filter(
        (event) =>
          event.occurredAt.getTime() === PERIOD_START.getTime() &&
          (event.metadata as { subscriptionId?: string } | null)
            ?.subscriptionId === manual.id
      )
    ).toHaveLength(0);
    expect(
      await prisma.subscription.findUnique({ where: { id: manual.id } })
    ).toMatchObject({
      currentPeriodStart: PERIOD_START,
      nextRenewalAt: PERIOD_END,
      lastChargedPeriodStart: PERIOD_START,
      status: "active",
    });
  });

  it("keeps a delayed July collision suppressed after provider rollover but permits a true August reanchor", async () => {
    const provider = await createProvider("charged-rollover-collision-provider");
    await createExternalBilling(provider.id, "charged-rollover-collision-plan");
    await adoptExternalBillingSubscriptions(NOW);
    await materializeDueSubscriptions(NOW);
    const correctedGuard = externalAdoptionGuardKey(
      provider.id,
      600,
      "monthly"
    );

    await prisma.providerExternalBilling.update({
      where: {
        providerId_source_externalId: {
          providerId: provider.id,
          source: "cloudflare-subscriptions",
          externalId: "charged-rollover-collision-plan",
        },
      },
      data: { amountUsd: 6, syncedAt: NOW },
    });
    await adoptExternalBillingSubscriptions(NOW);
    await releaseManagedExternalIdentity(provider.id);
    const manual = await prisma.subscription.create({
      data: {
        providerId: provider.id,
        externalBillingSource: "cloudflare-subscriptions",
        externalBillingId: "charged-rollover-collision-plan",
        externalAdoptionGuardKey: correctedGuard,
        name: "Owner-entered corrected price",
        costUsd: 6,
        currency: "USD",
        interval: "monthly",
        intervalCount: 1,
        startDate: PERIOD_START,
        currentPeriodStart: PERIOD_START,
        nextRenewalAt: PERIOD_END,
        autoRenew: false,
        status: "active",
      },
    });
    const settledJuly = await materializeDueSubscriptions(NOW);
    expect(settledJuly).toMatchObject({ charged: 0, eventsWritten: 0 });
    expect(
      await prisma.subscription.findUnique({ where: { id: manual.id } })
    ).toMatchObject({
      currentPeriodStart: PERIOD_START,
      lastChargedPeriodStart: PERIOD_START,
      status: "active",
      externalAdoptionGuardKey: correctedGuard,
    });

    const augustNow = new Date("2026-08-15T12:00:00.000Z");
    const augustEnd = new Date("2026-09-01T00:00:00.000Z");
    await prisma.providerExternalBilling.update({
      where: {
        providerId_source_externalId: {
          providerId: provider.id,
          source: "cloudflare-subscriptions",
          externalId: "charged-rollover-collision-plan",
        },
      },
      data: {
        amountUsd: 7,
        currentPeriodStart: PERIOD_END,
        currentPeriodEnd: augustEnd,
        nextRenewalAt: augustEnd,
        syncedAt: augustNow,
      },
    });

    const rollover = await adoptExternalBillingSubscriptions(augustNow);
    const delayedJuly = await materializeDueSubscriptions(augustNow);

    expect(rollover).toMatchObject({ existing: 1, adopted: 0 });
    expect(delayedJuly).toMatchObject({ charged: 0, eventsWritten: 0 });
    expect(
      await prisma.externalUsageEvent.findMany({
        orderBy: { occurredAt: "asc" },
        select: { costUsd: true, occurredAt: true },
      })
    ).toEqual([
      { costUsd: 5, occurredAt: PERIOD_START },
    ]);
    expect(
      await prisma.subscription.findUnique({ where: { id: manual.id } })
    ).toMatchObject({
      currentPeriodStart: PERIOD_START,
      lastChargedPeriodStart: PERIOD_START,
      status: "active",
      externalAdoptionGuardKey: correctedGuard,
    });

    const reanchor = await updateSubscription(
      new Request(
        `https://usage.jays.services/api/subscriptions/${manual.id}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            externalBillingSource: null,
            externalBillingId: null,
            startDate: "2026-08-01",
          }),
        }
      ),
      { params: Promise.resolve({ id: manual.id }) }
    );
    expect(reanchor.status).toBe(200);
    const trueAugust = await materializeDueSubscriptions(augustNow);

    expect(trueAugust).toMatchObject({ charged: 1, eventsWritten: 1 });
    expect(await prisma.externalUsageEvent.count()).toBe(2);
    expect(
      await prisma.subscription.findUnique({ where: { id: manual.id } })
    ).toMatchObject({
      currentPeriodStart: PERIOD_END,
      lastChargedPeriodStart: PERIOD_END,
      status: "active",
      externalAdoptionGuardKey: null,
    });
  });

  it("survives a crash before July settlement and suppresses that collision after August rollover", async () => {
    const provider = await createProvider("crash-before-settlement-provider");
    const externalId = "crash-before-settlement-plan";
    await createExternalBilling(provider.id, externalId);
    await adoptExternalBillingSubscriptions(NOW);
    await materializeDueSubscriptions(NOW);

    await prisma.providerExternalBilling.update({
      where: {
        providerId_source_externalId: {
          providerId: provider.id,
          source: "cloudflare-subscriptions",
          externalId,
        },
      },
      data: { amountUsd: 6, syncedAt: NOW },
    });
    await adoptExternalBillingSubscriptions(NOW);
    await releaseManagedExternalIdentity(provider.id);
    const manual = await prisma.subscription.create({
      data: {
        providerId: provider.id,
        externalBillingSource: "cloudflare-subscriptions",
        externalBillingId: externalId,
        externalAdoptionGuardKey: externalAdoptionGuardKey(
          provider.id,
          600,
          "monthly"
        ),
        name: "Owner-entered corrected price",
        costUsd: 6,
        currency: "USD",
        interval: "monthly",
        intervalCount: 1,
        startDate: PERIOD_START,
        currentPeriodStart: PERIOD_START,
        nextRenewalAt: PERIOD_END,
        autoRenew: false,
        status: "active",
      },
    });

    // The exact correction proof and owner identity transfer are committed,
    // but simulate a process stop before materialization settles the manual
    // watermark.
    expect(
      await prisma.externalBillingChargeCorrection.count({
        where: { providerId: provider.id },
      })
    ).toBe(1);
    expect(
      await prisma.subscription.findUnique({ where: { id: manual.id } })
    ).toMatchObject({ lastChargedPeriodStart: null });

    const augustNow = new Date("2026-08-15T12:00:00.000Z");
    const augustEnd = new Date("2026-09-01T00:00:00.000Z");
    await prisma.providerExternalBilling.update({
      where: {
        providerId_source_externalId: {
          providerId: provider.id,
          source: "cloudflare-subscriptions",
          externalId,
        },
      },
      data: {
        amountUsd: 7,
        currentPeriodStart: PERIOD_END,
        currentPeriodEnd: augustEnd,
        nextRenewalAt: augustEnd,
        syncedAt: augustNow,
      },
    });
    await adoptExternalBillingSubscriptions(augustNow);

    const materialized = await materializeDueSubscriptions(augustNow);
    expect(materialized).toMatchObject({ charged: 0, eventsWritten: 0 });
    expect(
      await prisma.externalUsageEvent.findMany({
        orderBy: { occurredAt: "asc" },
        select: { costUsd: true, occurredAt: true },
      })
    ).toEqual([
      { costUsd: 5, occurredAt: PERIOD_START },
    ]);
    expect(
      await prisma.subscription.findUnique({ where: { id: manual.id } })
    ).toMatchObject({ lastChargedPeriodStart: PERIOD_START });
  });

  it.each([
    {
      label: "stale",
      runAt: NOW,
      update: {
        amountUsd: 6,
        syncedAt: new Date("2026-07-15T08:00:00.000Z"),
      },
    },
    {
      label: "terminal",
      runAt: NOW,
      update: { amountUsd: 6, status: "canceled", syncedAt: NOW },
    },
    {
      label: "already-rolled same-price",
      runAt: new Date("2026-08-15T12:00:00.000Z"),
      update: {
        amountUsd: 6,
        currentPeriodStart: PERIOD_END,
        currentPeriodEnd: new Date("2026-09-01T00:00:00.000Z"),
        nextRenewalAt: new Date("2026-09-01T00:00:00.000Z"),
        syncedAt: new Date("2026-08-15T12:00:00.000Z"),
      },
    },
  ])(
    "does not settle a manual period from $label external evidence",
    async ({ label, runAt, update }) => {
      const provider = await createProvider(`invalid-settlement-${label}`);
      const externalId = `invalid-settlement-${label}-plan`;
      await createExternalBilling(provider.id, externalId);
      await adoptExternalBillingSubscriptions(NOW);
      await materializeDueSubscriptions(NOW);

      await prisma.providerExternalBilling.update({
        where: {
          providerId_source_externalId: {
            providerId: provider.id,
            source: "cloudflare-subscriptions",
            externalId,
          },
        },
        data: update,
      });
      const manual = await prisma.subscription.create({
        data: {
          providerId: provider.id,
          externalAdoptionGuardKey: externalAdoptionGuardKey(
            provider.id,
            600,
            "monthly"
          ),
          name: `Owner ${label} evidence plan`,
          costUsd: 6,
          currency: "USD",
          interval: "monthly",
          intervalCount: 1,
          startDate: PERIOD_START,
          currentPeriodStart: PERIOD_START,
          nextRenewalAt: PERIOD_END,
          autoRenew: false,
          status: "active",
        },
      });

      const materialized = await materializeDueSubscriptions(runAt);
      const events = await prisma.externalUsageEvent.findMany({
        where: { provider: provider.name, metricType: "subscription" },
        select: { costUsd: true, metadata: true },
      });

      expect(materialized).toMatchObject({ charged: 1, eventsWritten: 1 });
      expect(events).toHaveLength(2);
      expect(events).toContainEqual({
        costUsd: 6,
        metadata: expect.objectContaining({ subscriptionId: manual.id }),
      });
      expect(
        await prisma.subscription.findUnique({ where: { id: manual.id } })
      ).toMatchObject({ lastChargedPeriodStart: PERIOD_START });
      expect(
        await prisma.externalBillingChargeCorrection.count({
          where: { providerId: provider.id },
        })
      ).toBe(0);
    }
  );

  it("uses a downward corrected snapshot as the one authoritative fixed cash amount", async () => {
    const provider = await createProvider("charged-downward-correction-provider");
    await createExternalBilling(provider.id, "charged-downward-correction-plan");
    await adoptExternalBillingSubscriptions(NOW);
    await materializeDueSubscriptions(NOW);

    await prisma.providerExternalBilling.update({
      where: {
        providerId_source_externalId: {
          providerId: provider.id,
          source: "cloudflare-subscriptions",
          externalId: "charged-downward-correction-plan",
        },
      },
      data: { amountUsd: 4, syncedAt: NOW },
    });
    await prisma.usageSnapshot.create({
      data: {
        providerId: provider.id,
        fetchedAt: NOW,
        totalCost: 4,
        fixedCostIncludedUsd: 4,
      },
    });

    const reconciled = await adoptExternalBillingSubscriptions(NOW);
    const budget = await computeBudgetStatus(NOW);

    expect(reconciled).toMatchObject({ ambiguous: 1, deactivated: 1 });
    expect(await prisma.subscription.findFirst()).toMatchObject({
      costUsd: 5,
      externalAdoptionGuardKey: externalAdoptionGuardKey(
        provider.id,
        500,
        "monthly"
      ),
      status: "paused",
    });
    expect(await prisma.externalUsageEvent.count()).toBe(1);
    expect(budget.providers.find((row) => row.id === provider.id)).toMatchObject({
      subscriptionMonthToDateUsd: 5,
      snapshotFixedCostIncludedUsd: 4,
      linkedFixedDedupeUsd: 5,
      fixedCostConflict: false,
      spentUsd: 4,
    });
  });

  // -------------------------------------------------------------------
  // Manual subscription adjustment dedupe isolation (review remediation):
  // linkedFixedDedupeUsd previously deduped against the TOTAL
  // pushed.subscriptionPushed pool, which mixes the materializer's own
  // linked charge with any manual (non-"subscription"-sourceApp) adjustment
  // on the same provider in the same month. A manual refund shrank that pool,
  // so the min() dedupe shrank with it and cancelled the refund out of
  // fixedAccruedUsd instead of ever subtracting it. If the refund was large
  // enough to drive the pool net-negative, the dedupe went negative too and
  // ADDED spend back. The fix isolates the materializer-linked slice via
  // ProviderPushedCost.subscriptionPushedManualUsd (external-usage-events.ts)
  // before deduping, so manual adjustments always stay additive.
  // -------------------------------------------------------------------
  it("keeps a manual refund additive instead of letting the fixed-cost dedupe cancel it out", async () => {
    const provider = await createProvider("manual-dedupe-isolation-provider");
    await createExternalBilling(provider.id, "manual-dedupe-isolation-plan", {
      amountUsd: 124.99,
    });
    await prisma.usageSnapshot.create({
      data: {
        providerId: provider.id,
        fetchedAt: NOW,
        totalCost: 124.99,
        fixedCostIncludedUsd: 124.99,
      },
    });

    await adoptExternalBillingSubscriptions(NOW);
    expect(await materializeDueSubscriptions(NOW)).toMatchObject({
      charged: 1,
      eventsWritten: 1,
    });

    // The owner-directed manual refund: same provider, same month, but a
    // distinct sourceApp from the materializer's reserved "subscription".
    await prisma.externalUsageEvent.create({
      data: {
        sourceApp: "manual-billing-adjustment",
        provider: "manual-dedupe-isolation-provider",
        metricType: "subscription",
        billingMode: "manual",
        unit: "usd",
        confidence: "estimated",
        costUsd: -50,
        occurredAt: NOW,
      },
    });

    const budget = await computeBudgetStatus(NOW);
    const row = budget.providers.find((r) => r.id === provider.id);
    expect(row).toBeDefined();
    expect(row!.snapshotFixedCostIncludedUsd).toBeCloseTo(124.99, 2);
    // pushed.subscriptionPushed = 124.99 (materializer) - 50 (manual) = 74.99.
    expect(row!.subscriptionMonthToDateUsd).toBeCloseTo(74.99, 2);
    expect(row!.fixedCostConflict).toBe(false);
    // Bug: dedupe = min(subscriptionPushed=74.99, linkedMaterializedFixedUsd=
    // 124.99) = 74.99, so fixedAccruedUsd = 0 + 74.99 + 124.99 - 74.99 =
    // 124.99 -- the $50 refund vanishes entirely.
    // Fix: dedupe isolates the materializer-linked-only portion (124.99), so
    // fixedAccruedUsd = 0 + 74.99 + 124.99 - 124.99 = 74.99.
    expect(row!.linkedFixedDedupeUsd).toBeCloseTo(124.99, 2);
    expect(row!.fixedAccruedUsd).toBeCloseTo(74.99, 2);
    expect(row!.spentUsd).toBeCloseTo(74.99, 2);
    // Sentinel: fail loudly if a future regression reintroduces deduping
    // against the raw (manual-inclusive) pushed total.
    expect(row!.fixedAccruedUsd).not.toBeCloseTo(124.99, 2);
  });

  it("never lets the fixed-cost dedupe add spend back when a manual refund drives the subscription pool net-negative", async () => {
    const provider = await createProvider(
      "manual-dedupe-net-negative-provider"
    );
    await createExternalBilling(
      provider.id,
      "manual-dedupe-net-negative-plan",
      { amountUsd: 124.99 }
    );
    await prisma.usageSnapshot.create({
      data: {
        providerId: provider.id,
        fetchedAt: NOW,
        totalCost: 124.99,
        fixedCostIncludedUsd: 124.99,
      },
    });

    await adoptExternalBillingSubscriptions(NOW);
    expect(await materializeDueSubscriptions(NOW)).toMatchObject({
      charged: 1,
      eventsWritten: 1,
    });

    // A manual refund larger than the materializer charge itself, driving the
    // combined subscriptionPushed pool negative.
    await prisma.externalUsageEvent.create({
      data: {
        sourceApp: "manual-billing-adjustment",
        provider: "manual-dedupe-net-negative-provider",
        metricType: "subscription",
        billingMode: "manual",
        unit: "usd",
        confidence: "estimated",
        costUsd: -200,
        occurredAt: NOW,
      },
    });

    const budget = await computeBudgetStatus(NOW);
    const row = budget.providers.find((r) => r.id === provider.id);
    expect(row).toBeDefined();
    // subscriptionPushed pool = 124.99 - 200 = -75.01 (net negative).
    expect(row!.subscriptionMonthToDateUsd).toBeCloseTo(-75.01, 2);
    expect(row!.snapshotFixedCostIncludedUsd).toBeCloseTo(124.99, 2);
    // Bug: dedupe = min(pool=-75.01, linkedMaterializedFixedUsd=124.99) =
    // -75.01 (the pool is smaller), so fixedAccruedUsd = 0 + (-75.01) +
    // 124.99 - (-75.01) = 124.99 -- the dedupe went negative and ADDED the
    // full $200 of refund back as spend instead of ever subtracting it.
    // Fix: dedupe isolates the materializer-linked-only portion (max(0,
    // -75.01 - (-200)) = 124.99), so fixedAccruedUsd = 0 + (-75.01) +
    // 124.99 - 124.99 = -75.01 (correctly a net credit), and the dedupe
    // itself never goes negative.
    expect(row!.linkedFixedDedupeUsd).toBeCloseTo(124.99, 2);
    expect(row!.linkedFixedDedupeUsd).toBeGreaterThanOrEqual(0);
    expect(row!.fixedAccruedUsd).toBeCloseTo(-75.01, 2);
    expect(row!.spentUsd).toBeCloseTo(-75.01, 2);
    // Sentinel: fail loudly if a future regression reintroduces deduping
    // against the raw (manual-inclusive, possibly negative) pushed total.
    expect(row!.fixedAccruedUsd).not.toBeCloseTo(124.99, 2);
  });

  it.each([
    { label: "downward", correctedUsd: 4, expectedSpentUsd: 7 },
    { label: "upward", correctedUsd: 6, expectedSpentUsd: 9 },
  ])(
    "keeps a $label exact-period correction deduped after source staleness without subtracting an unrelated subscription",
    async ({ label, correctedUsd, expectedSpentUsd }) => {
      const provider = await createProvider(`stale-${label}-correction-provider`);
      const externalId = `stale-${label}-correction-plan`;
      await createExternalBilling(provider.id, externalId);
      await adoptExternalBillingSubscriptions(NOW);
      await materializeDueSubscriptions(NOW);

      await prisma.subscription.create({
        data: {
          providerId: provider.id,
          name: "Unrelated owner subscription",
          costUsd: 3,
          currency: "USD",
          interval: "monthly",
          intervalCount: 1,
          startDate: PERIOD_START,
          currentPeriodStart: PERIOD_START,
          nextRenewalAt: PERIOD_END,
          autoRenew: false,
          status: "active",
        },
      });
      await materializeDueSubscriptions(NOW);

      await prisma.providerExternalBilling.update({
        where: {
          providerId_source_externalId: {
            providerId: provider.id,
            source: "cloudflare-subscriptions",
            externalId,
          },
        },
        data: { amountUsd: correctedUsd, syncedAt: NOW },
      });
      await prisma.usageSnapshot.create({
        data: {
          providerId: provider.id,
          fetchedAt: NOW,
          totalCost: correctedUsd,
          fixedCostIncludedUsd: correctedUsd,
        },
      });
      await adoptExternalBillingSubscriptions(NOW);

      const fresh = await computeBudgetStatus(NOW);
      const managed = await prisma.subscription.findFirstOrThrow({
        where: { providerId: provider.id, externalBillingManaged: true },
        select: { id: true },
      });
      await prisma.subscription.delete({ where: { id: managed.id } });
      expect(
        await prisma.externalBillingChargeCorrection.count({
          where: { providerId: provider.id },
        })
      ).toBe(1);
      const stale = await computeBudgetStatus(
        new Date("2026-07-15T16:00:01.000Z")
      );
      for (const budget of [fresh, stale]) {
        expect(
          budget.providers.find((row) => row.id === provider.id)
        ).toMatchObject({
          subscriptionMonthToDateUsd: 8,
          linkedFixedDedupeUsd: 5,
          fixedCostConflict: false,
          spentUsd: expectedSpentUsd,
        });
      }
    }
  );

  it.each([
    {
      label: "name",
      update: { serviceName: "Workers Paid corrected" },
    },
    {
      label: "cadence",
      update: {
        billingInterval: "annual",
        currentPeriodEnd: new Date("2027-07-01T00:00:00.000Z"),
        nextRenewalAt: new Date("2027-07-01T00:00:00.000Z"),
      },
    },
    {
      label: "period end",
      update: {
        currentPeriodEnd: new Date("2026-07-31T00:00:00.000Z"),
        nextRenewalAt: new Date("2026-07-31T00:00:00.000Z"),
      },
    },
  ])(
    "pauses a charged same-period $label correction without rewriting history",
    async ({ label, update }) => {
      const provider = await createProvider(`charged-${label}-provider`);
      await createExternalBilling(provider.id, `charged-${label}-plan`);
      await adoptExternalBillingSubscriptions(NOW);
      await materializeDueSubscriptions(NOW);
      const guard = externalAdoptionGuardKey(provider.id, 500, "monthly");

      await prisma.providerExternalBilling.update({
        where: {
          providerId_source_externalId: {
            providerId: provider.id,
            source: "cloudflare-subscriptions",
            externalId: `charged-${label}-plan`,
          },
        },
        data: { ...update, syncedAt: NOW },
      });

      const reconciled = await adoptExternalBillingSubscriptions(NOW);
      const rematerialized = await materializeDueSubscriptions(NOW);

      expect(reconciled).toMatchObject({ ambiguous: 1, deactivated: 1 });
      expect(await prisma.subscription.findFirst()).toMatchObject({
        name: "Workers Paid",
        costUsd: 5,
        interval: "monthly",
        currentPeriodStart: PERIOD_START,
        nextRenewalAt: PERIOD_END,
        externalAdoptionGuardKey: guard,
        status: "paused",
      });
      expect(rematerialized).toMatchObject({ charged: 0, eventsWritten: 0 });
      expect(await prisma.externalUsageEvent.count()).toBe(1);
    }
  );

  it("preserves manual and externally linked subscriptions without duplicates", async () => {
    const manualProvider = await createProvider("manual-provider");
    await createExternalBilling(manualProvider.id, "manual-match");
    const manual = await prisma.subscription.create({
      data: {
        providerId: manualProvider.id,
        name: "Owner-entered plan",
        costUsd: 5,
        currency: "USD",
        interval: "monthly",
        intervalCount: 1,
        startDate: new Date("2025-01-01T00:00:00.000Z"),
        currentPeriodStart: PERIOD_START,
        nextRenewalAt: PERIOD_END,
        status: "paused",
      },
    });

    const linkedProvider = await createProvider("linked-provider");
    await createExternalBilling(linkedProvider.id, "already-linked");
    const linked = await prisma.subscription.create({
      data: {
        providerId: linkedProvider.id,
        externalBillingSource: "cloudflare-subscriptions",
        externalBillingId: "already-linked",
        name: "Existing linked plan",
        costUsd: 9,
        currency: "USD",
        interval: "annual",
        intervalCount: 1,
        startDate: PERIOD_START,
        currentPeriodStart: PERIOD_START,
        nextRenewalAt: PERIOD_END,
        status: "canceled",
      },
    });

    const result = await adoptExternalBillingSubscriptions(NOW);
    expect(result).toMatchObject({
      eligible: 2,
      adopted: 0,
      existing: 1,
      ambiguous: 1,
    });
    expect(await prisma.subscription.count()).toBe(2);
    expect(await prisma.subscription.findUnique({ where: { id: manual.id } })).toMatchObject({
      name: "Owner-entered plan",
      status: "paused",
      externalBillingSource: null,
      externalBillingId: null,
    });
    expect(await prisma.subscription.findUnique({ where: { id: linked.id } })).toMatchObject({
      name: "Existing linked plan",
      costUsd: 9,
      status: "canceled",
    });
  });

  it("rejects stale, noncanonical, catalog, aggregate, non-USD, zero, and inexact records", async () => {
    const provider = await createProvider("eligibility-provider");
    await createExternalBilling(provider.id, "valid");
    await createExternalBilling(provider.id, "stale", {
      syncedAt: new Date("2026-07-15T08:00:00.000Z"),
    });
    await createExternalBilling(provider.id, "component", { rollupRole: "component" });
    await createExternalBilling(provider.id, "aggregate", { rollupRole: "aggregate" });
    await createExternalBilling(provider.id, "implicit-role", { rollupRole: null });
    await createExternalBilling(provider.id, "partial-source", {
      paidRecurringAuthoritative: false,
    });
    await createExternalBilling(provider.id, "catalog", { kind: "catalog" });
    await createExternalBilling(provider.id, "non-usd", { currency: "EUR" });
    await createExternalBilling(provider.id, "zero", { amountUsd: 0 });
    await createExternalBilling(provider.id, "unsupported", {
      billingInterval: "biennial",
    });
    await createExternalBilling(provider.id, "missing-end", {
      currentPeriodEnd: null,
    });
    await createExternalBilling(provider.id, "long-period", {
      currentPeriodEnd: new Date("2026-09-01T00:00:00.000Z"),
    });
    await createExternalBilling(provider.id, "future-period", {
      currentPeriodStart: new Date("2026-08-01T00:00:00.000Z"),
      currentPeriodEnd: new Date("2026-09-01T00:00:00.000Z"),
    });
    await createExternalBilling(provider.id, "unknown-status", { status: "trial" });
    await createExternalBilling(provider.id, "wrong-date-kind", {
      dateKind: "quota_reset",
    });

    const result = await adoptExternalBillingSubscriptions(NOW);
    expect(result).toEqual({
      examined: 15,
      eligible: 1,
      adopted: 1,
      existing: 0,
      ambiguous: 0,
      reconciled: 0,
      deactivated: 0,
      raced: 0,
      cloudflareLegacyHandoff: "disabled",
    });
    expect(await prisma.subscription.findMany({ select: { externalBillingId: true } })).toEqual([
      { externalBillingId: "valid" },
    ]);
  });

  it("declines duplicate authoritative charge shapes as ambiguous", async () => {
    const provider = await createProvider("ambiguous-provider");
    await createExternalBilling(provider.id, "source-a", {
      source: "billing-source-a",
      serviceName: "Service A",
    });
    await createExternalBilling(provider.id, "source-b", {
      source: "billing-source-b",
      serviceName: "Service B",
    });

    const result = await adoptExternalBillingSubscriptions(NOW);
    expect(result).toMatchObject({ eligible: 2, adopted: 0, ambiguous: 2 });
    expect(await prisma.subscription.count()).toBe(0);
  });

  it("pre-suppresses same-guard records with different current periods", async () => {
    const provider = await createProvider("same-guard-period-provider");
    await createExternalBilling(provider.id, "first-period", {
      source: "billing-source-a",
    });
    await createExternalBilling(provider.id, "shifted-period", {
      source: "billing-source-b",
      currentPeriodStart: new Date("2026-07-10T00:00:00.000Z"),
      currentPeriodEnd: new Date("2026-08-10T00:00:00.000Z"),
    });

    const result = await adoptExternalBillingSubscriptions(NOW);

    expect(result).toMatchObject({ eligible: 2, adopted: 0, ambiguous: 2 });
    expect(await prisma.subscription.count()).toBe(0);
  });

  it("suppresses equivalent ProviderPlan fixed costs across cadences", async () => {
    const monthly = await createProvider("provider-plan-monthly");
    await prisma.providerPlan.create({
      data: { providerId: monthly.id, fixedMonthlyCostUsd: 5 },
    });
    await createExternalBilling(monthly.id, "monthly-plan");

    const annual = await createProvider("provider-plan-annual");
    await prisma.providerPlan.create({
      data: { providerId: annual.id, fixedMonthlyCostUsd: 10 },
    });
    await createExternalBilling(annual.id, "annual-plan", {
      amountUsd: 120,
      billingInterval: "annual",
      currentPeriodStart: new Date("2026-01-01T00:00:00.000Z"),
      currentPeriodEnd: new Date("2027-01-01T00:00:00.000Z"),
    });
    const nonEqual = await createProvider("provider-plan-non-equal");
    await prisma.providerPlan.create({
      data: { providerId: nonEqual.id, fixedMonthlyCostUsd: 1 },
    });
    await createExternalBilling(nonEqual.id, "non-equal-plan", {
      amountUsd: 37,
    });

    const result = await adoptExternalBillingSubscriptions(NOW);

    expect(result).toMatchObject({ eligible: 3, adopted: 0, ambiguous: 3 });
    expect(await prisma.subscription.count()).toBe(0);
  });

  it("pauses a managed term when any ProviderPlan fixed fee is added", async () => {
    const provider = await createProvider("late-provider-plan");
    await createExternalBilling(provider.id, "late-provider-plan-external", {
      amountUsd: 37,
    });
    await adoptExternalBillingSubscriptions(NOW);
    await prisma.providerPlan.create({
      data: { providerId: provider.id, fixedMonthlyCostUsd: 1 },
    });

    const reconciled = await adoptExternalBillingSubscriptions(NOW);
    const materialized = await materializeDueSubscriptions(NOW);

    expect(reconciled.deactivated).toBe(1);
    expect(await prisma.subscription.findFirst()).toMatchObject({
      status: "paused",
      autoRenew: false,
    });
    expect(materialized).toMatchObject({ charged: 0, eventsWritten: 0 });
  });

  it("reconciles managed cancellation, staleness, and authoritative deletion", async () => {
    const canceledProvider = await createProvider("cancel-provider");
    await createExternalBilling(canceledProvider.id, "cancel-plan");
    const staleProvider = await createProvider("stale-provider");
    await createExternalBilling(staleProvider.id, "stale-plan");
    const deletedProvider = await createProvider("deleted-provider");
    await createExternalBilling(deletedProvider.id, "deleted-plan");
    await adoptExternalBillingSubscriptions(NOW);

    await prisma.providerExternalBilling.update({
      where: {
        providerId_source_externalId: {
          providerId: canceledProvider.id,
          source: "cloudflare-subscriptions",
          externalId: "cancel-plan",
        },
      },
      data: { status: "canceled", syncedAt: NOW },
    });
    await prisma.providerExternalBilling.update({
      where: {
        providerId_source_externalId: {
          providerId: staleProvider.id,
          source: "cloudflare-subscriptions",
          externalId: "stale-plan",
        },
      },
      data: { syncedAt: new Date("2026-07-15T08:00:00.000Z") },
    });
    await prisma.providerExternalBilling.delete({
      where: {
        providerId_source_externalId: {
          providerId: deletedProvider.id,
          source: "cloudflare-subscriptions",
          externalId: "deleted-plan",
        },
      },
    });

    const result = await adoptExternalBillingSubscriptions(NOW);
    expect(result.deactivated).toBe(3);
    expect(
      await prisma.subscription.findFirst({
        where: { providerId: canceledProvider.id },
      })
    ).toMatchObject({ status: "canceled", autoRenew: false });
    expect(
      await prisma.subscription.findFirst({
        where: { providerId: staleProvider.id },
      })
    ).toMatchObject({ status: "paused", autoRenew: false });
    expect(
      await prisma.subscription.findFirst({
        where: { providerId: deletedProvider.id },
      })
    ).toMatchObject({ status: "canceled", autoRenew: false });
  });

  it("preserves a managed Cloudflare identity across an equivalent Paid and Expired response without double-counting", async () => {
    const provider = await createProvider();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ result: { totals: { requests: 10 } } })
      )
      .mockResolvedValueOnce(jsonResponse({}, 403))
      .mockResolvedValueOnce(
        jsonResponse({
          result: [
            {
              id: "replacement-paid-id",
              currency: "USD",
              current_period_start: PERIOD_START.toISOString(),
              current_period_end: PERIOD_END.toISOString(),
              frequency: "monthly",
              price: 5,
              rate_plan: {
                id: "workers",
                public_name: "Workers Paid",
              },
              state: "Paid",
            },
            {
              id: "preserved-expired-id",
              currency: "USD",
              current_period_start: PERIOD_START.toISOString(),
              current_period_end: PERIOD_END.toISOString(),
              frequency: "monthly",
              price: 5,
              rate_plan: {
                id: "workers",
                public_name: "Workers Paid",
              },
              state: "Expired",
            },
          ],
          result_info: {
            count: 2,
            page: 1,
            per_page: 50,
            total_count: 2,
          },
        })
      )
      .mockResolvedValueOnce(jsonResponse({}, 403));
    vi.stubGlobal("fetch", fetchMock);

    const adapterResult = await fetchCloudflareUsage("token", {
      accountId: "account-id",
      authMode: "api_token",
    });
    const subscriptionSync = adapterResult.externalBillingSyncs?.find(
      (sync) => sync.source === "cloudflare-subscriptions"
    );
    expect(adapterResult).toMatchObject({
      totalCost: 5,
      fixedCostIncludedUsd: 5,
    });
    expect(subscriptionSync?.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          externalId: "replacement-paid-id",
          status: "paid",
          paidRecurringAuthoritative: true,
          rollupRole: "canonical",
        }),
        expect.objectContaining({
          externalId: "preserved-expired-id",
          status: "paid",
          paidRecurringAuthoritative: true,
          rollupRole: "canonical",
        }),
      ])
    );
    await reconcileProviderExternalBilling(provider.id, subscriptionSync!);
    await prisma.usageSnapshot.create({
      data: {
        providerId: provider.id,
        fetchedAt: NOW,
        totalCost: adapterResult.totalCost,
        fixedCostIncludedUsd: adapterResult.fixedCostIncludedUsd,
      },
    });
    const managed = await prisma.subscription.create({
      data: {
        providerId: provider.id,
        externalBillingSource: "cloudflare-subscriptions",
        externalBillingId: "preserved-expired-id",
        externalBillingManaged: true,
        externalAdoptionGuardKey: externalAdoptionGuardKey(
          provider.id,
          500,
          "monthly"
        ),
        name: "Cloudflare Workers Paid (Congress.Trade)",
        costUsd: 5,
        currency: "USD",
        interval: "monthly",
        intervalCount: 1,
        startDate: PERIOD_START,
        currentPeriodStart: PERIOD_START,
        nextRenewalAt: PERIOD_END,
        autoRenew: false,
        status: "active",
      },
    });

    const adoption = await adoptExternalBillingSubscriptions(NOW);
    expect(adoption).toMatchObject({
      eligible: 2,
      adopted: 0,
      existing: 1,
      ambiguous: 1,
      reconciled: 0,
      deactivated: 0,
    });
    expect(
      await prisma.subscription.findUniqueOrThrow({ where: { id: managed.id } })
    ).toMatchObject({
      externalBillingId: "preserved-expired-id",
      externalBillingManaged: true,
      status: "active",
      autoRenew: false,
    });
    expect(await prisma.subscription.count()).toBe(1);
    expect(await materializeDueSubscriptions(NOW)).toMatchObject({
      charged: 1,
      eventsWritten: 1,
    });

    const budget = await computeBudgetStatus(NOW);
    expect(
      budget.providers.find((row) => row.id === provider.id)
    ).toMatchObject({
      subscriptionMonthToDateUsd: 5,
      snapshotFixedCostIncludedUsd: 5,
      linkedFixedDedupeUsd: 5,
      fixedCostConflict: false,
      fixedAccruedUsd: 5,
      spentUsd: 5,
    });

    // Exact term shape is not enough to adopt either identity when no durable
    // exact link exists. Preserve both provider records and fail closed on the
    // ambiguous first-time adoption instead of choosing an alias by shape.
    await prisma.externalUsageEvent.deleteMany();
    await prisma.subscription.delete({ where: { id: managed.id } });
    expect(await adoptExternalBillingSubscriptions(NOW)).toMatchObject({
      eligible: 2,
      adopted: 0,
      existing: 0,
      ambiguous: 2,
    });
    expect(await prisma.subscription.count()).toBe(0);
  });

  it.each([
    {
      label: "stale exact identity",
      linkedRecord: {
        syncedAt: new Date("2026-07-15T08:00:00.000Z"),
      },
      expectedStatus: "paused",
    },
    {
      label: "canceled exact identity",
      linkedRecord: { status: "canceled" },
      expectedStatus: "canceled",
    },
    {
      label: "ambiguous non-live exact identity",
      linkedRecord: { status: "trial" },
      expectedStatus: "paused",
    },
    {
      label: "unrelated replacement identity",
      linkedRecord: null,
      expectedStatus: "canceled",
    },
  ] as const)(
    "fails open instead of transferring proof for a $label",
    async ({ linkedRecord, expectedStatus }) => {
      const provider = await createProvider();
      const managed = await prisma.subscription.create({
        data: {
          providerId: provider.id,
          externalBillingSource: "cloudflare-subscriptions",
          externalBillingId: "historical-expired-id",
          externalBillingManaged: true,
          externalAdoptionGuardKey: externalAdoptionGuardKey(
            provider.id,
            500,
            "monthly"
          ),
          name: "Cloudflare Workers Paid (Congress.Trade)",
          costUsd: 5,
          currency: "USD",
          interval: "monthly",
          intervalCount: 1,
          startDate: PERIOD_START,
          currentPeriodStart: PERIOD_START,
          nextRenewalAt: PERIOD_END,
          autoRenew: false,
          status: "active",
        },
      });
      expect(await materializeDueSubscriptions(NOW)).toMatchObject({
        charged: 1,
        eventsWritten: 1,
      });
      await createExternalBilling(provider.id, "replacement-paid-id");
      if (linkedRecord != null) {
        await createExternalBilling(
          provider.id,
          "historical-expired-id",
          linkedRecord
        );
      }
      await prisma.usageSnapshot.create({
        data: {
          providerId: provider.id,
          fetchedAt: NOW,
          totalCost: 5,
          fixedCostIncludedUsd: 5,
        },
      });

      await adoptExternalBillingSubscriptions(NOW);
      expect(
        await prisma.subscription.findUniqueOrThrow({
          where: { id: managed.id },
        })
      ).toMatchObject({
        externalBillingId: "historical-expired-id",
        status: expectedStatus,
        autoRenew: false,
      });
      expect(await prisma.subscription.count()).toBe(1);

      const budget = await computeBudgetStatus(NOW);
      expect(
        budget.providers.find((row) => row.id === provider.id)
      ).toMatchObject({
        subscriptionMonthToDateUsd: 5,
        snapshotFixedCostIncludedUsd: 5,
        linkedFixedDedupeUsd: 0,
        fixedCostConflict: true,
        fixedAccruedUsd: 10,
        spentUsd: 10,
      });
    }
  );

  it("charges each fresh explicit period_end term once without autonomous renewal", async () => {
    const provider = await createProvider("period-end-provider");
    await createExternalBilling(provider.id, "period-end-plan", {
      source: "apify-account-plan",
      serviceName: "Apify platform",
      dateKind: "period_end",
    });

    await adoptExternalBillingSubscriptions(NOW);
    await materializeDueSubscriptions(NOW);
    await materializeDueSubscriptions(new Date("2026-08-15T12:00:00.000Z"));
    expect(await prisma.externalUsageEvent.count()).toBe(1);
    expect(await prisma.subscription.findFirst()).toMatchObject({
      autoRenew: false,
      currentPeriodStart: PERIOD_START,
      nextRenewalAt: PERIOD_END,
    });

    const augustNow = new Date("2026-08-15T12:00:00.000Z");
    await prisma.providerExternalBilling.update({
      where: {
        providerId_source_externalId: {
          providerId: provider.id,
          source: "apify-account-plan",
          externalId: "period-end-plan",
        },
      },
      data: {
        currentPeriodStart: PERIOD_END,
        currentPeriodEnd: new Date("2026-09-01T00:00:00.000Z"),
        syncedAt: augustNow,
      },
    });

    const nextTerm = await adoptExternalBillingSubscriptions(augustNow);
    expect(nextTerm.reconciled).toBe(1);
    const firstAugust = await materializeDueSubscriptions(augustNow);
    const secondAugust = await materializeDueSubscriptions(augustNow);
    expect(firstAugust).toMatchObject({ charged: 1, eventsWritten: 1 });
    expect(secondAugust).toMatchObject({ charged: 0, eventsWritten: 0 });
    expect(await prisma.externalUsageEvent.count()).toBe(2);
  });

  it("refuses an overlapping second same-cadence period for one managed identity", async () => {
    const provider = await createProvider("overlap-provider");
    await createExternalBilling(provider.id, "overlap-plan");
    await adoptExternalBillingSubscriptions(NOW);
    await materializeDueSubscriptions(NOW);
    const overlapNow = new Date("2026-07-20T12:00:00.000Z");
    await prisma.providerExternalBilling.update({
      where: {
        providerId_source_externalId: {
          providerId: provider.id,
          source: "cloudflare-subscriptions",
          externalId: "overlap-plan",
        },
      },
      data: {
        currentPeriodStart: new Date("2026-07-15T00:00:00.000Z"),
        currentPeriodEnd: new Date("2026-08-15T00:00:00.000Z"),
        syncedAt: overlapNow,
      },
    });

    const result = await adoptExternalBillingSubscriptions(overlapNow);
    const materialized = await materializeDueSubscriptions(overlapNow);

    expect(result).toMatchObject({ reconciled: 0, ambiguous: 1 });
    expect(materialized).toMatchObject({ charged: 0, eventsWritten: 0 });
    expect(await prisma.externalUsageEvent.count()).toBe(1);
    expect(await prisma.subscription.findFirst()).toMatchObject({
      currentPeriodStart: PERIOD_START,
      nextRenewalAt: PERIOD_END,
    });
  });

  it("treats cross-rounding provider and manual amounts consistently", async () => {
    const duplicates = await createProvider("rounding-duplicates");
    await createExternalBilling(duplicates.id, "rounded-a", {
      amountUsd: 5.004,
    });
    await createExternalBilling(duplicates.id, "rounded-b", {
      source: "second-source",
      amountUsd: 5.006,
    });

    const manual = await createProvider("rounding-manual");
    await createExternalBilling(manual.id, "rounded-manual", { amountUsd: 5 });
    await prisma.subscription.create({
      data: {
        providerId: manual.id,
        name: "Manual near-cent charge",
        costUsd: 4.999,
        currency: "USD",
        interval: "monthly",
        intervalCount: 1,
        startDate: PERIOD_START,
        currentPeriodStart: PERIOD_START,
        nextRenewalAt: PERIOD_END,
      },
    });

    const result = await adoptExternalBillingSubscriptions(NOW);
    expect(result).toMatchObject({ eligible: 1, adopted: 0, ambiguous: 1 });
    expect(
      await prisma.subscription.count({
        where: { providerId: duplicates.id },
      })
    ).toBe(0);
    expect(await prisma.subscription.count()).toBe(1);
  });

  it("transactionally rechecks a manual create from a second SQLite client", async () => {
    const provider = await createProvider("manual-race-provider");
    await createExternalBilling(provider.id, "manual-race-plan");
    let release!: () => void;
    let reached!: () => void;
    const reachedPreflight = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const releaseRecheck = new Promise<void>((resolve) => {
      release = resolve;
    });

    const adoption = adoptExternalBillingSubscriptions(NOW, {
      beforeTransactionalRecheck: async () => {
        reached();
        await releaseRecheck;
      },
    });
    await reachedPreflight;
    await contenderPrisma.subscription.create({
      data: {
        providerId: provider.id,
        name: "Concurrent manual plan",
        costUsd: 5,
        currency: "USD",
        interval: "monthly",
        intervalCount: 1,
        startDate: PERIOD_START,
        currentPeriodStart: PERIOD_START,
        nextRenewalAt: PERIOD_END,
      },
    });
    release();

    const result = await adoption;
    expect(result).toMatchObject({ adopted: 0, ambiguous: 1 });
    expect(await prisma.subscription.count()).toBe(1);
  });

  it("prevents a guarded NULL-link manual create that starts after the adoption lock", async () => {
    const provider = await createProvider("post-lock-manual-race-provider");
    await createExternalBilling(provider.id, "post-lock-manual-race-plan");
    let release!: () => void;
    let reached!: () => void;
    const writerLockHeld = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const releaseAdoption = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adoption = adoptExternalBillingSubscriptions(NOW, {
      afterTransactionalRecheck: async () => {
        reached();
        await releaseAdoption;
      },
    });
    await writerLockHeld;

    const manualData = {
      providerId: provider.id,
      externalAdoptionGuardKey: externalAdoptionGuardKey(
        provider.id,
        500,
        "monthly"
      ),
      name: "Concurrent guarded manual plan",
      costUsd: 5,
      currency: "USD",
      interval: "monthly",
      intervalCount: 1,
      startDate: PERIOD_START,
      currentPeriodStart: PERIOD_START,
      nextRenewalAt: PERIOD_END,
    };
    const manualAttempt = contenderPrisma.subscription
      .create({ data: manualData })
      .then(() => null)
      .catch((error: unknown) => error);
    release();

    const [adoptionResult, manualError] = await Promise.all([
      adoption,
      manualAttempt,
    ]);
    expect(adoptionResult.adopted).toBe(1);
    expect(["P2002", "P1008"]).toContain((manualError as any)?.code);
    expect(await prisma.subscription.count()).toBe(1);
    await expect(
      contenderPrisma.subscription.create({ data: manualData })
    ).rejects.toThrow();
  });

  it.each(["cancel", "delete"] as const)(
    "transactionally rechecks an external %s from a second SQLite client",
    async (action) => {
      const provider = await createProvider(`external-${action}-race-provider`);
      await createExternalBilling(provider.id, `external-${action}-race-plan`);
      let release!: () => void;
      let reached!: () => void;
      const reachedPreflight = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const releaseRecheck = new Promise<void>((resolve) => {
        release = resolve;
      });
      const adoption = adoptExternalBillingSubscriptions(NOW, {
        beforeTransactionalRecheck: async () => {
          reached();
          await releaseRecheck;
        },
      });
      await reachedPreflight;
      const identity = {
        providerId_source_externalId: {
          providerId: provider.id,
          source: "cloudflare-subscriptions",
          externalId: `external-${action}-race-plan`,
        },
      };
      if (action === "cancel") {
        await contenderPrisma.providerExternalBilling.update({
          where: identity,
          data: { status: "canceled", syncedAt: NOW },
        });
      } else {
        await contenderPrisma.providerExternalBilling.delete({
          where: identity,
        });
      }
      release();

      const result = await adoption;
      expect(result.adopted).toBe(0);
      expect(await prisma.subscription.count()).toBe(0);
    }
  );

  it("keeps the exact legacy Cloudflare handoff default-off and rejects an invalid target", async () => {
    const provider = await createProvider();
    await createExternalBilling(provider.id, "workers-paid");
    const legacy = await createLegacyCloudflareSubscription(provider.id);

    expect(await adoptExternalBillingSubscriptions(NOW)).toMatchObject({
      cloudflareLegacyHandoff: "disabled",
    });
    process.env.CLOUDFLARE_LEGACY_HANDOFF_SUBSCRIPTION_ID = "not-a-uuid";
    expect(await adoptExternalBillingSubscriptions(NOW)).toMatchObject({
      cloudflareLegacyHandoff: "invalid_target",
    });
    expect(
      await prisma.subscription.findUniqueOrThrow({ where: { id: legacy.id } })
    ).toMatchObject({
      externalBillingManaged: false,
      externalAdoptionGuardKey: null,
      autoRenew: true,
    });
    expect(await prisma.externalUsageEvent.count()).toBe(1);
  });

  it("hands off the exact live-shaped Cloudflare row in place and never retakes an owner relinquishment", async () => {
    const provider = await createProvider();
    await prisma.providerPlan.create({
      data: { providerId: provider.id, billingMode: "actual" },
    });
    const project = await prisma.project.create({
      data: { name: "Congress.Trade", nameKey: "congress.trade" },
    });
    await createExternalBilling(provider.id, "workers-paid");
    const legacy = await createLegacyCloudflareSubscription(
      provider.id,
      "workers-paid",
      { projectId: project.id }
    );
    const eventBefore = await prisma.externalUsageEvent.findFirstOrThrow();
    process.env.CLOUDFLARE_LEGACY_HANDOFF_SUBSCRIPTION_ID = legacy.id;

    const first = await adoptExternalBillingSubscriptions(NOW);
    const handedOff = await prisma.subscription.findUniqueOrThrow({
      where: { id: legacy.id },
    });
    expect(first).toMatchObject({
      adopted: 0,
      existing: 1,
      reconciled: 0,
      cloudflareLegacyHandoff: "handed_off",
    });
    expect(handedOff).toMatchObject({
      id: legacy.id,
      providerId: provider.id,
      projectId: project.id,
      externalBillingSource: "cloudflare-subscriptions",
      externalBillingId: "workers-paid",
      externalBillingManaged: true,
      externalAdoptionGuardKey: externalAdoptionGuardKey(
        provider.id,
        500,
        "monthly"
      ),
      name: "Cloudflare Workers Paid (Congress.Trade)",
      description: "Owner-entered legacy subscription",
      costUsd: 5,
      currency: "USD",
      interval: "monthly",
      intervalCount: 1,
      startDate: new Date("2026-06-15T00:00:00.000Z"),
      currentPeriodStart: PERIOD_START,
      nextRenewalAt: PERIOD_END,
      lastChargedPeriodStart: PERIOD_START,
      autoRenew: false,
      status: "active",
      notes: "Preserve this owner note",
      knobEnv: { CLOUDFLARE_WORKERS_PAID: "true" },
    });
    expect(await prisma.externalUsageEvent.findFirstOrThrow()).toEqual(
      eventBefore
    );
    expect(await prisma.externalBillingChargeCorrection.count()).toBe(0);
    expect(await materializeDueSubscriptions(NOW)).toMatchObject({
      charged: 0,
      eventsWritten: 0,
    });

    const rerun = await adoptExternalBillingSubscriptions(NOW);
    expect(rerun.cloudflareLegacyHandoff).toBe("already_managed");
    expect(
      await prisma.subscription.findUniqueOrThrow({ where: { id: legacy.id } })
    ).toEqual(handedOff);

    await prisma.subscription.update({
      where: { id: legacy.id },
      data: { externalBillingManaged: false, autoRenew: true },
    });
    const relinquished = await adoptExternalBillingSubscriptions(NOW);
    expect(relinquished.cloudflareLegacyHandoff).toBe(
      "owner_guard_present"
    );
    expect(
      await prisma.subscription.findUniqueOrThrow({ where: { id: legacy.id } })
    ).toMatchObject({
      externalBillingManaged: false,
      autoRenew: true,
      externalAdoptionGuardKey: externalAdoptionGuardKey(
        provider.id,
        500,
        "monthly"
      ),
    });
  });

  it("hands off Cloudflare's explicit midnight renewal window without broadening general adoption", async () => {
    const provider = await createProvider();
    const cloudflareStart = new Date("2026-06-16T19:02:36.000Z");
    const cloudflareEnd = new Date("2026-07-16T00:00:00.000Z");
    await createExternalBilling(provider.id, "workers-paid", {
      planName: "Workers Paid",
      currentPeriodStart: cloudflareStart,
      currentPeriodEnd: cloudflareEnd,
      nextRenewalAt: cloudflareEnd,
    });
    const legacy = await createLegacyCloudflareSubscription(
      provider.id,
      "workers-paid",
      {
        currentPeriodStart: cloudflareStart,
        nextRenewalAt: cloudflareEnd,
      }
    );

    const defaultOff = await adoptExternalBillingSubscriptions(NOW);
    expect(defaultOff).toMatchObject({
      eligible: 0,
      adopted: 0,
      cloudflareLegacyHandoff: "disabled",
    });
    expect(
      await prisma.subscription.findUniqueOrThrow({ where: { id: legacy.id } })
    ).toMatchObject({
      externalBillingManaged: false,
      externalAdoptionGuardKey: null,
      autoRenew: true,
    });

    process.env.CLOUDFLARE_LEGACY_HANDOFF_SUBSCRIPTION_ID = legacy.id;
    const handedOff = await adoptExternalBillingSubscriptions(NOW);
    expect(handedOff).toMatchObject({
      eligible: 0,
      adopted: 0,
      existing: 0,
      deactivated: 0,
      cloudflareLegacyHandoff: "handed_off",
    });
    expect(
      await prisma.subscription.findUniqueOrThrow({ where: { id: legacy.id } })
    ).toMatchObject({
      id: legacy.id,
      currentPeriodStart: cloudflareStart,
      nextRenewalAt: cloudflareEnd,
      externalBillingManaged: true,
      externalAdoptionGuardKey: externalAdoptionGuardKey(
        provider.id,
        500,
        "monthly"
      ),
      autoRenew: false,
      status: "active",
    });
    expect(await prisma.externalUsageEvent.count()).toBe(1);

    delete process.env.CLOUDFLARE_LEGACY_HANDOFF_SUBSCRIPTION_ID;
    expect(await adoptExternalBillingSubscriptions(NOW)).toMatchObject({
      eligible: 0,
      adopted: 0,
      deactivated: 0,
      cloudflareLegacyHandoff: "disabled",
    });
    expect(
      await prisma.subscription.findUniqueOrThrow({ where: { id: legacy.id } })
    ).toMatchObject({ status: "active", autoRenew: false });

    const nextPeriodStart = cloudflareEnd;
    const nextPeriodEnd = new Date("2026-08-16T00:00:00.000Z");
    const nextPeriodNow = new Date("2026-08-15T12:00:00.000Z");
    await prisma.providerExternalBilling.updateMany({
      data: {
        currentPeriodStart: nextPeriodStart,
        currentPeriodEnd: nextPeriodEnd,
        nextRenewalAt: nextPeriodEnd,
        syncedAt: nextPeriodNow,
      },
    });
    expect(
      await adoptExternalBillingSubscriptions(nextPeriodNow)
    ).toMatchObject({
      eligible: 1,
      adopted: 0,
      reconciled: 1,
      deactivated: 0,
      cloudflareLegacyHandoff: "disabled",
    });
    expect(
      await materializeDueSubscriptions(nextPeriodNow)
    ).toMatchObject({ charged: 1, eventsWritten: 1 });
    expect(
      await materializeDueSubscriptions(nextPeriodNow)
    ).toMatchObject({ charged: 0, eventsWritten: 0 });
    expect(await prisma.subscription.count()).toBe(1);
    expect(
      await prisma.externalUsageEvent.findMany({
        orderBy: { occurredAt: "asc" },
        select: { occurredAt: true, metadata: true },
      })
    ).toEqual([
      {
        occurredAt: cloudflareStart,
        metadata: expect.objectContaining({ subscriptionId: legacy.id }),
      },
      {
        occurredAt: nextPeriodStart,
        metadata: expect.objectContaining({ subscriptionId: legacy.id }),
      },
    ]);
  });

  it.each([
    [
      "a non-midnight end",
      { currentPeriodEnd: new Date("2026-07-16T06:00:00.000Z") },
    ],
    [
      "the wrong renewal date",
      { currentPeriodEnd: new Date("2026-07-17T00:00:00.000Z") },
    ],
    ["a different service", { serviceName: "Pages Paid" }],
    ["a non-paid state", { status: "active" }],
  ] as const)(
    "keeps the Cloudflare explicit-window exception closed for %s",
    async (_scenario, externalOverride) => {
      const provider = await createProvider();
      const cloudflareStart = new Date("2026-06-16T19:02:36.000Z");
      const defaultEnd = new Date("2026-07-16T00:00:00.000Z");
      const cloudflareEnd =
        "currentPeriodEnd" in externalOverride
          ? externalOverride.currentPeriodEnd
          : defaultEnd;
      await createExternalBilling(provider.id, "workers-paid", {
        planName: "Workers Paid",
        currentPeriodStart: cloudflareStart,
        currentPeriodEnd: cloudflareEnd,
        nextRenewalAt: cloudflareEnd,
        ...externalOverride,
      });
      const legacy = await createLegacyCloudflareSubscription(
        provider.id,
        "workers-paid",
        {
          currentPeriodStart: cloudflareStart,
          nextRenewalAt: cloudflareEnd,
        }
      );
      process.env.CLOUDFLARE_LEGACY_HANDOFF_SUBSCRIPTION_ID = legacy.id;

      expect(
        (await adoptExternalBillingSubscriptions(NOW))
          .cloudflareLegacyHandoff
      ).toBe("external_billing_ineligible");
      expect(
        await prisma.subscription.findUniqueOrThrow({ where: { id: legacy.id } })
      ).toMatchObject({
        externalBillingManaged: false,
        externalAdoptionGuardKey: null,
        autoRenew: true,
      });
    }
  );

  it.each([
    ["a different service", { serviceName: "Pages Paid" }],
    ["a generic live state", { status: "active" }],
    ["a plan record", { kind: "plan" }],
    ["generic period-end semantics", { dateKind: "period_end" }],
    [
      "a mismatched authoritative renewal",
      { nextRenewalAt: new Date("2026-08-02T00:00:00.000Z") },
    ],
  ] as const)(
    "does not bypass strict Cloudflare handoff guards with exact duration for %s",
    async (_scenario, externalOverride) => {
      const provider = await createProvider();
      await createExternalBilling(provider.id, "workers-paid", externalOverride);
      const legacy = await createLegacyCloudflareSubscription(provider.id);
      process.env.CLOUDFLARE_LEGACY_HANDOFF_SUBSCRIPTION_ID = legacy.id;

      expect(
        (await adoptExternalBillingSubscriptions(NOW))
          .cloudflareLegacyHandoff
      ).toBe("external_billing_ineligible");
      expect(
        await prisma.subscription.findUniqueOrThrow({ where: { id: legacy.id } })
      ).toMatchObject({
        externalBillingManaged: false,
        externalAdoptionGuardKey: null,
        autoRenew: true,
        status: "active",
      });
    }
  );

  it.each([
    [
      "another provider",
      "not-cloudflare",
      "Cloudflare Workers Paid (Congress.Trade)",
    ],
    ["a non-legacy Cloudflare row", "cloudflare", "Workers Paid"],
  ] as const)(
    "does not extend the midnight-window reconciliation exception to %s",
    async (_scenario, providerName, subscriptionName) => {
      const provider = await createProvider(providerName);
      if (providerName !== "cloudflare") {
        await prisma.provider.update({
          where: { id: provider.id },
          data: { type: "custom" },
        });
      }
      const cloudflareStart = new Date("2026-06-16T19:02:36.000Z");
      const cloudflareEnd = new Date("2026-07-16T00:00:00.000Z");
      await createExternalBilling(provider.id, "workers-paid", {
        currentPeriodStart: cloudflareStart,
        currentPeriodEnd: cloudflareEnd,
        nextRenewalAt: cloudflareEnd,
      });
      const managed = await prisma.subscription.create({
        data: {
          providerId: provider.id,
          externalBillingSource: "cloudflare-subscriptions",
          externalBillingId: "workers-paid",
          externalBillingManaged: true,
          externalAdoptionGuardKey: externalAdoptionGuardKey(
            provider.id,
            500,
            "monthly"
          ),
          name: subscriptionName,
          costUsd: 5,
          currency: "USD",
          interval: "monthly",
          intervalCount: 1,
          startDate: cloudflareStart,
          currentPeriodStart: cloudflareStart,
          nextRenewalAt: cloudflareEnd,
          autoRenew: false,
          status: "active",
        },
      });

      expect(await adoptExternalBillingSubscriptions(NOW)).toMatchObject({
        eligible: 0,
        adopted: 0,
        ambiguous: 1,
        reconciled: 0,
        deactivated: 1,
        cloudflareLegacyHandoff: "disabled",
      });
      expect(
        await prisma.subscription.findUniqueOrThrow({ where: { id: managed.id } })
      ).toMatchObject({ status: "paused", autoRenew: false });
      expect(await prisma.externalUsageEvent.count()).toBe(0);
    }
  );

  it("rejects a second same-shaped explicit-window Cloudflare authority", async () => {
    const provider = await createProvider();
    const cloudflareStart = new Date("2026-06-16T19:02:36.000Z");
    const cloudflareEnd = new Date("2026-07-16T00:00:00.000Z");
    for (const externalId of ["workers-paid", "workers-paid-duplicate"]) {
      await createExternalBilling(provider.id, externalId, {
        currentPeriodStart: cloudflareStart,
        currentPeriodEnd: cloudflareEnd,
        nextRenewalAt: cloudflareEnd,
      });
    }
    const legacy = await createLegacyCloudflareSubscription(
      provider.id,
      "workers-paid",
      {
        currentPeriodStart: cloudflareStart,
        nextRenewalAt: cloudflareEnd,
      }
    );
    process.env.CLOUDFLARE_LEGACY_HANDOFF_SUBSCRIPTION_ID = legacy.id;

    expect(
      (await adoptExternalBillingSubscriptions(NOW)).cloudflareLegacyHandoff
    ).toBe("guard_collision");
    expect(
      await prisma.subscription.findUniqueOrThrow({ where: { id: legacy.id } })
    ).toMatchObject({
      externalBillingManaged: false,
      externalAdoptionGuardKey: null,
      autoRenew: true,
      status: "active",
    });
    expect(await prisma.externalUsageEvent.count()).toBe(1);
  });

  it.each([
    ["wrong provider", "wrong_provider"],
    ["wrong provider key", "wrong_provider"],
    ["inactive provider", "wrong_provider"],
    ["wrong identity", "wrong_identity"],
    ["stale authority", "external_billing_ineligible"],
    ["term mismatch", "term_mismatch"],
    ["display-name mismatch", "term_mismatch"],
    ["positive provider fixed cost", "provider_plan_conflict"],
    ["missing event", "charge_proof_missing"],
    ["inexact event", "charge_proof_missing"],
    ["wrong watermark", "charge_proof_missing"],
    ["guard collision", "guard_collision"],
  ] as const)("fails closed for a %s", async (scenario, expectedStatus) => {
    const provider = await createProvider();
    await createExternalBilling(provider.id, "workers-paid");
    const legacy = await createLegacyCloudflareSubscription(provider.id);
    process.env.CLOUDFLARE_LEGACY_HANDOFF_SUBSCRIPTION_ID = legacy.id;

    if (scenario === "wrong provider") {
      await prisma.provider.update({
        where: { id: provider.id },
        data: { type: "custom" },
      });
    } else if (scenario === "wrong provider key") {
      await prisma.provider.update({
        where: { id: provider.id },
        data: { name: "Cloudflare" },
      });
    } else if (scenario === "inactive provider") {
      await prisma.provider.update({
        where: { id: provider.id },
        data: { isActive: false },
      });
    } else if (scenario === "wrong identity") {
      await prisma.subscription.update({
        where: { id: legacy.id },
        data: { externalBillingSource: "manual" },
      });
    } else if (scenario === "stale authority") {
      await prisma.providerExternalBilling.updateMany({
        data: { syncedAt: new Date("2026-07-01T00:00:00.000Z") },
      });
    } else if (scenario === "term mismatch") {
      await prisma.subscription.update({
        where: { id: legacy.id },
        data: { costUsd: 6 },
      });
    } else if (scenario === "display-name mismatch") {
      await prisma.subscription.update({
        where: { id: legacy.id },
        data: { name: "Another owner label" },
      });
    } else if (scenario === "positive provider fixed cost") {
      await prisma.providerPlan.create({
        data: { providerId: provider.id, fixedMonthlyCostUsd: 5 },
      });
    } else if (scenario === "missing event") {
      await prisma.externalUsageEvent.deleteMany();
    } else if (scenario === "inexact event") {
      await prisma.externalUsageEvent.updateMany({
        data: { label: "Wrong historical label" },
      });
    } else if (scenario === "wrong watermark") {
      await prisma.subscription.update({
        where: { id: legacy.id },
        data: { lastChargedPeriodStart: null },
      });
    } else {
      await prisma.subscription.create({
        data: {
          providerId: provider.id,
          externalAdoptionGuardKey: externalAdoptionGuardKey(
            provider.id,
            500,
            "monthly"
          ),
          name: "Conflicting owner charge",
          costUsd: 5,
          currency: "USD",
          interval: "monthly",
          intervalCount: 1,
          startDate: PERIOD_START,
          currentPeriodStart: PERIOD_START,
          nextRenewalAt: PERIOD_END,
          status: "paused",
        },
      });
    }

    const result = await adoptExternalBillingSubscriptions(NOW);
    expect(result.cloudflareLegacyHandoff).toBe(expectedStatus);
    expect(
      await prisma.subscription.findUniqueOrThrow({ where: { id: legacy.id } })
    ).toMatchObject({
      externalBillingManaged: false,
      autoRenew: true,
      status: "active",
    });
  });

  it("rechecks an owner guard edit under the adoption writer lock", async () => {
    const provider = await createProvider();
    await createExternalBilling(provider.id, "workers-paid");
    const legacy = await createLegacyCloudflareSubscription(provider.id);
    process.env.CLOUDFLARE_LEGACY_HANDOFF_SUBSCRIPTION_ID = legacy.id;
    let release!: () => void;
    let reached!: () => void;
    const reachedPreflight = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const releaseRecheck = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adoption = adoptExternalBillingSubscriptions(NOW, {
      beforeTransactionalRecheck: async () => {
        reached();
        await releaseRecheck;
      },
    });
    await reachedPreflight;
    await contenderPrisma.subscription.update({
      where: { id: legacy.id },
      data: {
        externalAdoptionGuardKey: externalAdoptionGuardKey(
          provider.id,
          500,
          "monthly"
        ),
      },
    });
    release();

    expect((await adoption).cloudflareLegacyHandoff).toBe(
      "owner_guard_present"
    );
    expect(
      await prisma.subscription.findUniqueOrThrow({ where: { id: legacy.id } })
    ).toMatchObject({ externalBillingManaged: false });
  });

  it("charges exactly one next provider period on the handed-off UUID", async () => {
    const provider = await createProvider();
    await createExternalBilling(provider.id, "workers-paid");
    const legacy = await createLegacyCloudflareSubscription(provider.id);
    process.env.CLOUDFLARE_LEGACY_HANDOFF_SUBSCRIPTION_ID = legacy.id;
    expect(
      (await adoptExternalBillingSubscriptions(NOW)).cloudflareLegacyHandoff
    ).toBe("handed_off");

    const augustNow = new Date("2026-08-15T12:00:00.000Z");
    const augustEnd = new Date("2026-09-01T00:00:00.000Z");
    await prisma.providerExternalBilling.updateMany({
      data: {
        currentPeriodStart: PERIOD_END,
        currentPeriodEnd: augustEnd,
        nextRenewalAt: augustEnd,
        syncedAt: augustNow,
      },
    });
    expect(
      (await adoptExternalBillingSubscriptions(augustNow))
        .cloudflareLegacyHandoff
    ).toBe("already_managed");
    expect(await materializeDueSubscriptions(augustNow)).toMatchObject({
      charged: 1,
      eventsWritten: 1,
    });
    expect(await materializeDueSubscriptions(augustNow)).toMatchObject({
      charged: 0,
      eventsWritten: 0,
    });
    expect(await prisma.subscription.count()).toBe(1);
    expect(
      await prisma.externalUsageEvent.findMany({
        orderBy: { occurredAt: "asc" },
        select: { occurredAt: true, metadata: true },
      })
    ).toEqual([
      {
        occurredAt: PERIOD_START,
        metadata: expect.objectContaining({ subscriptionId: legacy.id }),
      },
      {
        occurredAt: PERIOD_END,
        metadata: expect.objectContaining({ subscriptionId: legacy.id }),
      },
    ]);
  });

  it("is idempotent across concurrent races and later retries", async () => {
    const provider = await createProvider("race-provider");
    await createExternalBilling(provider.id, "race-plan");

    const concurrent = await Promise.all([
      adoptExternalBillingSubscriptions(NOW),
      adoptExternalBillingSubscriptions(NOW),
    ]);
    expect(concurrent.reduce((sum, result) => sum + result.adopted, 0)).toBe(1);
    expect(await prisma.subscription.count()).toBe(1);

    const retry = await adoptExternalBillingSubscriptions(NOW);
    expect(retry).toMatchObject({ adopted: 0, existing: 1 });
    expect(await prisma.subscription.count()).toBe(1);
  });

  it("rolls back every new adoption when one candidate write fails", async () => {
    const provider = await createProvider("atomic-failure-provider");
    await createExternalBilling(provider.id, "a-valid", { amountUsd: 5 });
    await createExternalBilling(provider.id, "z-fail", { amountUsd: 6 });
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER fail_external_adoption
      BEFORE INSERT ON "Subscription"
      WHEN NEW."externalBillingId" = 'z-fail'
      BEGIN
        SELECT RAISE(ABORT, 'forced candidate failure');
      END
    `);

    try {
      await expect(
        adoptExternalBillingSubscriptions(NOW)
      ).rejects.toThrow();
      expect(await prisma.subscription.count()).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe(
        "DROP TRIGGER IF EXISTS fail_external_adoption"
      );
    }
  });
});
