import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { NextRequest } from "next/server";
import { setupPrismaSqliteTestDb } from "@/lib/__tests__/setup-test-db";

// The plan-vs-subscription exclusivity invariant (a provider's recurring fee
// is modeled EITHER as ProviderPlan.fixedMonthlyCostUsd OR as a Subscription,
// never both) is application-enforced only. Both writers preflight the
// opposing side, then RE-CHECK it inside their write transaction under
// SQLite's writer lock (see planFixedCostConflicts /
// PlanSubscriptionExclusivityError in src/lib/provider-plan.ts). These tests
// cover both the preflight 400s and the TOCTOU recheck: the race is simulated
// deterministically by stubbing ONLY the preflight read to return a stale
// no-conflict snapshot while the database already holds the conflicting row —
// exactly what a concurrent writer committing between preflight and
// transaction would produce. The in-transaction re-read runs against the real
// database and must catch it.

let dbPath: string;
let POST_SUBSCRIPTIONS: typeof import("../route").POST;
let PUT_PROVIDER: typeof import("../../providers/[id]/route").PUT;
let prisma: typeof import("@/lib/prisma").prisma;
let createSessionToken: typeof import("@/lib/auth").createSessionToken;
let SESSION_COOKIE_NAME: typeof import("@/lib/auth").SESSION_COOKIE_NAME;

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-subscription-exclusivity-test-"));
  dbPath = path.join(dir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.SESSION_SECRET = "test-session-secret";

  setupPrismaSqliteTestDb(dbPath);

  ({ POST: POST_SUBSCRIPTIONS } = await import("../route"));
  ({ PUT: PUT_PROVIDER } = await import("../../providers/[id]/route"));
  ({ prisma } = await import("@/lib/prisma"));
  ({ createSessionToken, SESSION_COOKIE_NAME } = await import("@/lib/auth"));
}, 60_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (dbPath && fs.existsSync(dbPath)) fs.rmSync(dbPath, { force: true });
});

beforeEach(async () => {
  await prisma.subscription.deleteMany();
  await prisma.providerPlan.deleteMany();
  await prisma.provider.deleteMany();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function subscriptionPostRequest(body: unknown): NextRequest {
  return new NextRequest("https://usage.jays.services/api/subscriptions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}`,
    },
    body: JSON.stringify(body),
  });
}

function providerPutRequest(providerId: string, body: unknown): NextRequest {
  return new NextRequest(`https://usage.jays.services/api/providers/${providerId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function createProvider(plan?: { fixedMonthlyCostUsd: number }) {
  return prisma.provider.create({
    data: {
      name: "fmp",
      displayName: "FMP",
      type: "builtin",
      refreshIntervalMin: 60,
      ...(plan ? { plan: { create: plan } } : {}),
    },
    include: { plan: true },
  });
}

async function createActiveSubscription(providerId: string) {
  const now = new Date();
  return prisma.subscription.create({
    data: {
      providerId,
      name: "Starter",
      costUsd: 22,
      status: "active",
      startDate: new Date(now.getTime() - 24 * 60 * 60 * 1_000),
      currentPeriodStart: new Date(now.getTime() - 24 * 60 * 60 * 1_000),
      nextRenewalAt: new Date(now.getTime() + 29 * 24 * 60 * 60 * 1_000),
    },
  });
}

describe("POST /api/subscriptions — plan exclusivity", () => {
  it("preflight-400s when the provider already has a plan fixed monthly cost", async () => {
    const provider = await createProvider({ fixedMonthlyCostUsd: 20 });
    const res = await POST_SUBSCRIPTIONS(
      subscriptionPostRequest({ providerId: provider.id, name: "Starter", costUsd: 22 })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("already has a Plan price / mo");
    expect(await prisma.subscription.count()).toBe(0);
  });

  it("transaction recheck rejects a plan price committed after a stale preflight read (TOCTOU)", async () => {
    // The DB already holds the conflicting plan (as if PUT /api/providers/:id
    // committed it just after this request's preflight ran) — the stubbed
    // preflight is the stale snapshot from before that commit.
    const provider = await createProvider({ fixedMonthlyCostUsd: 20 });
    vi.spyOn(prisma.provider, "findUnique").mockResolvedValueOnce({
      ...provider,
      plan: { fixedMonthlyCostUsd: null },
    } as never);

    const res = await POST_SUBSCRIPTIONS(
      subscriptionPostRequest({ providerId: provider.id, name: "Starter", costUsd: 22 })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("already has a Plan price / mo");
    // The transaction rolled back: no subscription row was committed.
    expect(await prisma.subscription.count()).toBe(0);
  });

  it("creates the subscription when no plan fixed cost exists (guard does not overblock)", async () => {
    const provider = await createProvider();
    const res = await POST_SUBSCRIPTIONS(
      subscriptionPostRequest({ providerId: provider.id, name: "Starter", costUsd: 22 })
    );
    expect(res.status).toBe(201);
    expect(await prisma.subscription.count({ where: { providerId: provider.id } })).toBe(1);
  });
});

describe("PUT /api/providers/:id — subscription exclusivity", () => {
  it("preflight-400s a plan fixed cost when an active subscription exists", async () => {
    const provider = await createProvider();
    await createActiveSubscription(provider.id);

    const res = await PUT_PROVIDER(
      providerPutRequest(provider.id, { plan: { fixedMonthlyCostUsd: 25 } }),
      { params: Promise.resolve({ id: provider.id }) }
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("active/considering Subscription");
    expect(
      await prisma.providerPlan.findUnique({ where: { providerId: provider.id } })
    ).toBeNull();
  });

  it("transaction recheck rejects a subscription committed after a stale preflight read (TOCTOU)", async () => {
    // The DB already holds the conflicting active subscription (as if POST
    // /api/subscriptions committed it just after this request's preflight
    // ran) — the stubbed preflight is the stale no-subscription snapshot.
    const provider = await createProvider();
    await createActiveSubscription(provider.id);
    vi.spyOn(prisma.subscription, "findFirst").mockResolvedValueOnce(null);

    const res = await PUT_PROVIDER(
      providerPutRequest(provider.id, { plan: { fixedMonthlyCostUsd: 25 } }),
      { params: Promise.resolve({ id: provider.id }) }
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("active/considering Subscription");
    // The transaction rolled back: the plan upsert never committed.
    expect(
      await prisma.providerPlan.findUnique({ where: { providerId: provider.id } })
    ).toBeNull();
  });

  it("accepts a plan fixed cost when no active/considering subscription exists", async () => {
    const provider = await createProvider();

    const res = await PUT_PROVIDER(
      providerPutRequest(provider.id, { plan: { fixedMonthlyCostUsd: 25 } }),
      { params: Promise.resolve({ id: provider.id }) }
    );
    expect(res.status).toBe(200);
    const plan = await prisma.providerPlan.findUnique({ where: { providerId: provider.id } });
    expect(plan?.fixedMonthlyCostUsd).toBe(25);
  });
});
