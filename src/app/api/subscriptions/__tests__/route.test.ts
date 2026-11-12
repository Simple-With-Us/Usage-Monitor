import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { NextRequest } from "next/server";
import { setupPrismaSqliteTestDb } from "@/lib/__tests__/setup-test-db";

// Exercises the real GET/POST /api/subscriptions route handlers against a
// throwaway SQLite file, following this repo's `DATABASE_URL=file:<tmpdir>/...`
// convention (see subscription-materializer.test.ts). Covers:
//   - GET's dual auth (dashboard session cookie OR USAGE_READ_TOKEN/
//     USAGE_INGEST_TOKEN bearer, mirroring GET /api/budget-status).
//   - GET's knobEnv/freeTierKnobEnv merge (subscription override vs the
//     provider's free-tier ProviderPlan.knobEnv).
//   - POST staying session-cookie-only even though the middleware exclusion
//     (src/middleware.ts's `api/subscriptions/?$`) now covers the whole
//     collection path, not just GET.

let dbPath: string;
let GET: typeof import("../route").GET;
let POST: typeof import("../route").POST;
let PUT: typeof import("../[id]/route").PUT;
let prisma: typeof import("@/lib/prisma").prisma;
let createSessionToken: typeof import("@/lib/auth").createSessionToken;
let SESSION_COOKIE_NAME: typeof import("@/lib/auth").SESSION_COOKIE_NAME;
let planSubscriptionCharges: typeof import("@/lib/subscription-materializer").planSubscriptionCharges;

const READ_TOKEN = "read-token-abc";
const SESSION_PASSWORD = "test-dashboard-password";

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subscriptions-route-test-"));
  dbPath = path.join(dir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.USAGE_READ_TOKEN = READ_TOKEN;
  process.env.DASHBOARD_PASSWORD = SESSION_PASSWORD;
  process.env.SESSION_SECRET = "test-session-secret";
  delete process.env.USAGE_INGEST_TOKEN;

  setupPrismaSqliteTestDb(dbPath);

  ({ GET, POST } = await import("../route"));
  ({ PUT } = await import("../[id]/route"));
  ({ prisma } = await import("@/lib/prisma"));
  ({ createSessionToken, SESSION_COOKIE_NAME } = await import("@/lib/auth"));
  ({ planSubscriptionCharges } = await import("@/lib/subscription-materializer"));
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

function getRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("https://usage.jays.services/api/subscriptions", {
    method: "GET",
    headers,
  });
}

function postRequest(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("https://usage.jays.services/api/subscriptions", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function sessionCookieHeader(): Record<string, string> {
  return { cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}` };
}

function liveMonthlyPeriod(now = new Date()): {
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
} {
  return {
    currentPeriodStart: new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
    ),
    currentPeriodEnd: new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)
    ),
  };
}

function activeProratedMonthlyPeriod(now = new Date()): {
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
} {
  return {
    currentPeriodStart: new Date(now.getTime() - 24 * 60 * 60 * 1_000),
    currentPeriodEnd: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1_000),
  };
}

describe("GET /api/subscriptions — auth", () => {
  it("401s an unauthenticated request (no session cookie, no token)", async () => {
    const res = await GET(getRequest());
    expect(res.status).toBe(401);
  });

  it("401s an invalid bearer token", async () => {
    const res = await GET(getRequest({ "x-usage-ingest-token": "wrong-token" }));
    expect(res.status).toBe(401);
  });

  it("accepts a valid USAGE_READ_TOKEN bearer", async () => {
    const res = await GET(getRequest({ "x-usage-ingest-token": READ_TOKEN }));
    expect(res.status).toBe(200);
  });

  it("accepts the canonical x-usage-read-token header (X3 alias)", async () => {
    const res = await GET(getRequest({ "x-usage-read-token": READ_TOKEN }));
    expect(res.status).toBe(200);
  });

  it("marks the read surface version with an x-api-version response header (X4)", async () => {
    const res = await GET(getRequest({ "x-usage-read-token": READ_TOKEN }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-api-version")).toBe("1");
  });

  it("accepts a valid Authorization: Bearer header", async () => {
    const res = await GET(getRequest({ authorization: `Bearer ${READ_TOKEN}` }));
    expect(res.status).toBe(200);
  });

  it("accepts a valid dashboard session cookie", async () => {
    const res = await GET(getRequest(sessionCookieHeader()));
    expect(res.status).toBe(200);
  });
});

describe("GET /api/subscriptions — knobEnv / freeTierKnobEnv", () => {
  it("returns the subscription's own knobEnv as the effective value when set, alongside the provider's free tier", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "tiingo",
        displayName: "Tiingo",
        type: "builtin",
        refreshIntervalMin: 60,
        plan: {
          create: {
            knobEnv: {
              PROVIDER_QUOTA_TIINGO_PER_HOUR: "50",
              PROVIDER_QUOTA_TIINGO_PER_DAY: "1000",
            },
          },
        },
      },
    });
    await prisma.subscription.create({
      data: {
        providerId: provider.id,
        name: "Power",
        costUsd: 30,
        status: "considering",
        startDate: new Date("2026-07-01T00:00:00Z"),
        currentPeriodStart: new Date("2026-07-01T00:00:00Z"),
        nextRenewalAt: new Date("2026-08-01T00:00:00Z"),
        knobEnv: { PROVIDER_QUOTA_TIINGO_PER_HOUR: "10000", PROVIDER_QUOTA_TIINGO_PER_DAY: "100000" },
      },
    });

    const res = await GET(getRequest({ "x-usage-ingest-token": READ_TOKEN }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    expect(body[0].status).toBe("considering");
    expect(body[0].knobEnv).toEqual({
      PROVIDER_QUOTA_TIINGO_PER_HOUR: "10000",
      PROVIDER_QUOTA_TIINGO_PER_DAY: "100000",
    });
    expect(body[0].freeTierKnobEnv).toEqual({
      PROVIDER_QUOTA_TIINGO_PER_HOUR: "50",
      PROVIDER_QUOTA_TIINGO_PER_DAY: "1000",
    });
  });

  it("falls back to the provider's free-tier knobEnv when the subscription has none of its own", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "finnhub",
        displayName: "Finnhub",
        type: "builtin",
        refreshIntervalMin: 60,
        plan: { create: { knobEnv: { PROVIDER_RATE_LIMIT_FINNHUB_PER_MIN: "50" } } },
      },
    });
    await prisma.subscription.create({
      data: {
        providerId: provider.id,
        name: "Free",
        costUsd: 0,
        status: "active",
        startDate: new Date("2026-07-01T00:00:00Z"),
        currentPeriodStart: new Date("2026-07-01T00:00:00Z"),
        nextRenewalAt: new Date("2026-08-01T00:00:00Z"),
        // no knobEnv override
      },
    });

    const res = await GET(getRequest({ "x-usage-ingest-token": READ_TOKEN }));
    const body = await res.json();
    expect(body[0].knobEnv).toEqual({ PROVIDER_RATE_LIMIT_FINNHUB_PER_MIN: "50" });
    expect(body[0].freeTierKnobEnv).toEqual({ PROVIDER_RATE_LIMIT_FINNHUB_PER_MIN: "50" });
  });

  it("returns null for both when neither the subscription nor the provider has a knobEnv", async () => {
    const provider = await prisma.provider.create({
      data: { name: "massive", displayName: "Massive", type: "builtin", refreshIntervalMin: 60 },
    });
    await prisma.subscription.create({
      data: {
        providerId: provider.id,
        name: "Stocks Starter",
        costUsd: 29,
        status: "active",
        startDate: new Date("2026-07-01T00:00:00Z"),
        currentPeriodStart: new Date("2026-07-01T00:00:00Z"),
        nextRenewalAt: new Date("2026-08-01T00:00:00Z"),
      },
    });

    const res = await GET(getRequest({ "x-usage-ingest-token": READ_TOKEN }));
    const body = await res.json();
    expect(body[0].knobEnv).toBeNull();
    expect(body[0].freeTierKnobEnv).toBeNull();
  });

  it("still returns a bare top-level array (consumed directly by src/app/settings/page.tsx)", async () => {
    const res = await GET(getRequest({ "x-usage-ingest-token": READ_TOKEN }));
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it("falls back to the free-tier knobEnv for a canceled subscription — its paid override is not effective", async () => {
    // Regression for a P2 review finding: the effective knobEnv contract is
    // "a subscription's knobEnv overrides the provider baseline ONLY while
    // active|considering." A paused/canceled row's own knobEnv is stale and
    // must never be reported as effective — only the provider's free-tier
    // baseline should. freeTierKnobEnv stays the provider baseline either way.
    const provider = await prisma.provider.create({
      data: {
        name: "fmp",
        displayName: "FMP",
        type: "builtin",
        refreshIntervalMin: 60,
        plan: { create: { knobEnv: { PROVIDER_RATE_LIMIT_FMP_PER_MIN: "5" } } },
      },
    });
    await prisma.subscription.create({
      data: {
        providerId: provider.id,
        name: "Premium (canceled)",
        costUsd: 59,
        status: "canceled",
        startDate: new Date("2026-06-01T00:00:00Z"),
        currentPeriodStart: new Date("2026-06-01T00:00:00Z"),
        nextRenewalAt: new Date("2026-07-01T00:00:00Z"),
        knobEnv: { PROVIDER_RATE_LIMIT_FMP_PER_MIN: "750" },
      },
    });

    const res = await GET(getRequest({ "x-usage-ingest-token": READ_TOKEN }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].status).toBe("canceled");
    // Effective knobEnv is the FREE-TIER baseline, not the stale paid override.
    expect(body[0].knobEnv).toEqual({ PROVIDER_RATE_LIMIT_FMP_PER_MIN: "5" });
    // freeTierKnobEnv is always the provider baseline, unaffected by status.
    expect(body[0].freeTierKnobEnv).toEqual({ PROVIDER_RATE_LIMIT_FMP_PER_MIN: "5" });
  });

  it("returns an expired effective status and free-tier knobs after a non-renewing term ends", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "fmp",
        displayName: "FMP",
        type: "builtin",
        plan: { create: { knobEnv: { PROVIDER_RATE_LIMIT_FMP_PER_MIN: "5" } } },
      },
    });
    await prisma.subscription.create({
      data: {
        providerId: provider.id,
        name: "Ended annual term",
        costUsd: 59,
        status: "active",
        autoRenew: false,
        startDate: new Date("2019-01-01T00:00:00Z"),
        currentPeriodStart: new Date("2019-01-01T00:00:00Z"),
        nextRenewalAt: new Date("2020-01-01T00:00:00Z"),
        knobEnv: { PROVIDER_RATE_LIMIT_FMP_PER_MIN: "750" },
      },
    });

    const res = await GET(getRequest({ "x-usage-ingest-token": READ_TOKEN }));
    const body = await res.json();

    expect(body[0].status).toBe("active");
    expect(body[0].effectiveStatus).toBe("expired");
    expect(body[0].knobEnv).toEqual({ PROVIDER_RATE_LIMIT_FMP_PER_MIN: "5" });
  });

  it("still applies the paid override for 'active' and 'considering' rows (unaffected by the fix above)", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "massive",
        displayName: "Massive",
        type: "builtin",
        refreshIntervalMin: 60,
        plan: { create: { knobEnv: { PROVIDER_QUOTA_MASSIVE_PER_DAY: "100" } } },
      },
    });
    await prisma.subscription.create({
      data: {
        providerId: provider.id,
        name: "Active plan",
        costUsd: 29,
        status: "active",
        startDate: new Date("2026-07-01T00:00:00Z"),
        currentPeriodStart: new Date("2026-07-01T00:00:00Z"),
        nextRenewalAt: new Date("2026-08-01T00:00:00Z"),
        knobEnv: { PROVIDER_QUOTA_MASSIVE_PER_DAY: "5000" },
      },
    });
    await prisma.subscription.create({
      data: {
        providerId: provider.id,
        name: "Candidate plan",
        costUsd: 79,
        status: "considering",
        startDate: new Date("2026-07-01T00:00:00Z"),
        currentPeriodStart: new Date("2026-07-01T00:00:00Z"),
        nextRenewalAt: new Date("2026-08-01T00:00:00Z"),
        knobEnv: { PROVIDER_QUOTA_MASSIVE_PER_DAY: "20000" },
      },
    });

    const res = await GET(getRequest({ "x-usage-ingest-token": READ_TOKEN }));
    const body = await res.json();
    const active = body.find((s: { name: string }) => s.name === "Active plan");
    const considering = body.find((s: { name: string }) => s.name === "Candidate plan");
    expect(active.knobEnv).toEqual({ PROVIDER_QUOTA_MASSIVE_PER_DAY: "5000" });
    expect(considering.knobEnv).toEqual({ PROVIDER_QUOTA_MASSIVE_PER_DAY: "20000" });
  });
});

describe("POST /api/subscriptions — stays session-cookie-only", () => {
  it("401s a request with a VALID read token but no session cookie", async () => {
    const provider = await prisma.provider.create({
      data: { name: "fmp", displayName: "FMP", type: "builtin", refreshIntervalMin: 60 },
    });
    const res = await POST(
      postRequest(
        { providerId: provider.id, name: "Starter", costUsd: 22 },
        { "x-usage-ingest-token": READ_TOKEN }
      )
    );
    expect(res.status).toBe(401);
  });

  it("401s an unauthenticated request", async () => {
    const provider = await prisma.provider.create({
      data: { name: "fmp", displayName: "FMP", type: "builtin", refreshIntervalMin: 60 },
    });
    const res = await POST(postRequest({ providerId: provider.id, name: "Starter", costUsd: 22 }));
    expect(res.status).toBe(401);
  });

  it("succeeds with a valid dashboard session cookie and persists knobEnv + considering status", async () => {
    const provider = await prisma.provider.create({
      data: { name: "fmp", displayName: "FMP", type: "builtin", refreshIntervalMin: 60 },
    });
    const res = await POST(
      postRequest(
        {
          providerId: provider.id,
          name: "Premium",
          costUsd: 59,
          status: "considering",
          knobEnv: { SOME_KNOB: "value" },
        },
        sessionCookieHeader()
      )
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.status).toBe("considering");

    const stored = await prisma.subscription.findUnique({ where: { id: body.id } });
    expect(stored?.knobEnv).toEqual({ SOME_KNOB: "value" });
  });

  it("leaves an unlinked same-price manual charge unguarded and additive", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "cloudflare",
        displayName: "Cloudflare",
        type: "builtin",
        refreshIntervalMin: 60,
      },
    });
    await prisma.providerExternalBilling.create({
      data: {
        providerId: provider.id,
        source: "cloudflare-subscriptions",
        externalId: "workers-paid-guarded",
        paidRecurringAuthoritative: true,
        kind: "subscription",
        serviceName: "Workers Paid",
        status: "paid",
        amountUsd: 5,
        currency: "USD",
        billingInterval: "monthly",
        ...liveMonthlyPeriod(),
        rollupRole: "canonical",
        dateKind: "renewal",
        syncedAt: new Date(),
      },
    });
    const body = {
      providerId: provider.id,
      name: "Owner-entered Workers Paid",
      costUsd: 5,
      interval: "monthly",
      intervalCount: 1,
    };

    const first = await POST(postRequest(body, sessionCookieHeader()));
    expect(first.status).toBe(201);
    const stored = await prisma.subscription.findFirst();
    expect(stored).toMatchObject({
      externalBillingSource: null,
      externalBillingId: null,
      externalBillingManaged: false,
    });
    expect(stored?.externalAdoptionGuardKey).toBeNull();

    const duplicate = await POST(postRequest(body, sessionCookieHeader()));
    expect(duplicate.status).toBe(201);
    expect(await prisma.subscription.count()).toBe(2);
    expect(
      await prisma.subscription.count({
        where: { externalAdoptionGuardKey: { not: null } },
      })
    ).toBe(0);
  });

  it("claims a guard only for the exact owner-linked authoritative identity", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "cloudflare-exact-guard",
        displayName: "Cloudflare exact guard",
        type: "builtin",
        refreshIntervalMin: 60,
      },
    });
    await prisma.providerExternalBilling.create({
      data: {
        providerId: provider.id,
        source: "cloudflare-subscriptions",
        externalId: "workers-paid-exact-guard",
        paidRecurringAuthoritative: true,
        kind: "subscription",
        serviceName: "Workers Paid",
        status: "paid",
        amountUsd: 5,
        currency: "USD",
        billingInterval: "monthly",
        ...liveMonthlyPeriod(),
        rollupRole: "canonical",
        dateKind: "renewal",
        syncedAt: new Date(),
      },
    });

    const response = await POST(
      postRequest(
        {
          providerId: provider.id,
          name: "Owner-linked Workers Paid",
          costUsd: 5,
          interval: "monthly",
          intervalCount: 1,
          externalBillingSource: "cloudflare-subscriptions",
          externalBillingId: "workers-paid-exact-guard",
        },
        sessionCookieHeader()
      )
    );

    expect(response.status).toBe(201);
    expect(await prisma.subscription.findFirst()).toMatchObject({
      externalBillingSource: "cloudflare-subscriptions",
      externalBillingId: "workers-paid-exact-guard",
      externalAdoptionGuardKey: `external-paid-recurring:${provider.id}:monthly:500`,
    });
  });

  it("still allows same-price manual accounts when no external charge is authoritative", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "anthropic",
        displayName: "Anthropic",
        type: "builtin",
        refreshIntervalMin: 60,
      },
    });
    const first = await POST(
      postRequest(
        { providerId: provider.id, name: "Max account 1", costUsd: 200 },
        sessionCookieHeader()
      )
    );
    const second = await POST(
      postRequest(
        { providerId: provider.id, name: "Max account 2", costUsd: 200 },
        sessionCookieHeader()
      )
    );

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await prisma.subscription.count()).toBe(2);
    expect(
      await prisma.subscription.count({
        where: { externalAdoptionGuardKey: { not: null } },
      })
    ).toBe(0);
  });

  it("rejects linking one provider billing identity to multiple subscriptions", async () => {
    const provider = await prisma.provider.create({
      data: { name: "cloudflare", displayName: "Cloudflare", type: "builtin" },
    });
    await prisma.providerExternalBilling.create({
      data: {
        providerId: provider.id,
        source: "cloudflare-subscriptions",
        externalId: "workers-paid",
        kind: "subscription",
        status: "active",
        amountUsd: 5,
        currency: "USD",
        billingInterval: "monthly",
        ...liveMonthlyPeriod(),
        syncedAt: new Date(),
      },
    });
    await prisma.subscription.create({
      data: {
        providerId: provider.id,
        externalBillingSource: "cloudflare-subscriptions",
        externalBillingId: "workers-paid",
        name: "Existing link",
        costUsd: 5,
        startDate: new Date("2026-07-01T00:00:00Z"),
        currentPeriodStart: new Date("2026-07-01T00:00:00Z"),
        nextRenewalAt: new Date("2026-08-01T00:00:00Z"),
      },
    });

    const response = await POST(
      postRequest(
        {
          providerId: provider.id,
          name: "Duplicate link",
          costUsd: 5,
          externalBillingSource: "cloudflare-subscriptions",
          externalBillingId: "workers-paid",
        },
        sessionCookieHeader()
      )
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("already linked"),
    });
    expect(await prisma.subscription.count()).toBe(1);
  });

  it("rejects a provider billing identity whose amount does not match the local charge", async () => {
    const provider = await prisma.provider.create({
      data: { name: "cloudflare", displayName: "Cloudflare", type: "builtin" },
    });
    await prisma.providerExternalBilling.create({
      data: {
        providerId: provider.id,
        source: "cloudflare-subscriptions",
        externalId: "workers-paid",
        kind: "subscription",
        status: "active",
        amountUsd: 20,
        currency: "USD",
        billingInterval: "month",
        ...liveMonthlyPeriod(),
        syncedAt: new Date(),
      },
    });

    const response = await POST(
      postRequest(
        {
          providerId: provider.id,
          name: "Mismatched link",
          costUsd: 5,
          interval: "monthly",
          externalBillingSource: "cloudflare-subscriptions",
          externalBillingId: "workers-paid",
        },
        sessionCookieHeader()
      )
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("match the subscription"),
    });
    expect(await prisma.subscription.count()).toBe(0);
  });

  it("anchors a new linked subscription to the provider's current period", async () => {
    const provider = await prisma.provider.create({
      data: { name: "cloudflare", displayName: "Cloudflare", type: "builtin" },
    });
    const livePeriod = activeProratedMonthlyPeriod();
    await prisma.providerExternalBilling.create({
      data: {
        providerId: provider.id,
        source: "cloudflare-subscriptions",
        externalId: "current-workers-paid",
        kind: "subscription",
        status: "paid",
        amountUsd: 5,
        currency: "USD",
        billingInterval: "monthly",
        ...livePeriod,
        syncedAt: new Date(),
      },
    });

    const response = await POST(
      postRequest(
        {
          providerId: provider.id,
          name: "Current provider term",
          costUsd: 5,
          interval: "monthly",
          intervalCount: 1,
          anchorDay: 31,
          startDate: "2019-01-01",
          externalBillingSource: "cloudflare-subscriptions",
          externalBillingId: "current-workers-paid",
        },
        sessionCookieHeader()
      )
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    const stored = await prisma.subscription.findUnique({
      where: { id: body.id },
    });
    expect(stored?.startDate.toISOString()).toBe(
      livePeriod.currentPeriodStart.toISOString()
    );
    expect(stored?.currentPeriodStart.toISOString()).toBe(
      livePeriod.currentPeriodStart.toISOString()
    );
    expect(stored?.nextRenewalAt.toISOString()).toBe(
      livePeriod.currentPeriodEnd.toISOString()
    );
    expect(stored?.anchorDay).toBeNull();
    expect(stored?.lastChargedPeriodStart).toBeNull();
    expect(stored).not.toBeNull();
    const chargePlan = planSubscriptionCharges(
      {
        id: stored!.id,
        name: stored!.name,
        costUsd: stored!.costUsd,
        currency: stored!.currency,
        interval: stored!.interval,
        intervalCount: stored!.intervalCount,
        projectId: stored!.projectId,
        autoRenew: stored!.autoRenew,
        currentPeriodStart: stored!.currentPeriodStart,
        nextRenewalAt: stored!.nextRenewalAt,
        lastChargedPeriodStart: stored!.lastChargedPeriodStart,
        provider: { name: provider.name },
      },
      new Date()
    );
    expect(chargePlan?.inputs).toHaveLength(1);
  });

  it("rejects a provider billing identity whose upstream sync is stale", async () => {
    const provider = await prisma.provider.create({
      data: { name: "cloudflare", displayName: "Cloudflare", type: "builtin" },
    });
    await prisma.providerExternalBilling.create({
      data: {
        providerId: provider.id,
        source: "cloudflare-subscriptions",
        externalId: "stale-workers-paid",
        kind: "subscription",
        status: "active",
        amountUsd: 5,
        currency: "USD",
        billingInterval: "monthly",
        ...liveMonthlyPeriod(),
        syncedAt: new Date(Date.now() - 25 * 60 * 60 * 1_000),
      },
    });

    const response = await POST(
      postRequest(
        {
          providerId: provider.id,
          name: "Stale provider link",
          costUsd: 5,
          externalBillingSource: "cloudflare-subscriptions",
          externalBillingId: "stale-workers-paid",
        },
        sessionCookieHeader()
      )
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("fresh, current"),
    });
    expect(await prisma.subscription.count()).toBe(0);
  });
});

describe("PUT /api/subscriptions/:id — provider editing", () => {
  it("requires an exact relink before restoring an adoption guard", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "cloudflare",
        displayName: "Cloudflare",
        type: "builtin",
        refreshIntervalMin: 60,
      },
    });
    const period = liveMonthlyPeriod();
    await prisma.providerExternalBilling.create({
      data: {
        providerId: provider.id,
        source: "cloudflare-subscriptions",
        externalId: "workers-paid-edit-guard",
        paidRecurringAuthoritative: true,
        kind: "subscription",
        serviceName: "Workers Paid",
        status: "paid",
        amountUsd: 5,
        currency: "USD",
        billingInterval: "monthly",
        ...period,
        rollupRole: "canonical",
        dateKind: "renewal",
        syncedAt: new Date(),
      },
    });
    const originalGuard = `external-paid-recurring:${provider.id}:monthly:500`;
    const subscription = await prisma.subscription.create({
      data: {
        providerId: provider.id,
        externalBillingSource: "cloudflare-subscriptions",
        externalBillingId: "workers-paid-edit-guard",
        externalBillingManaged: true,
        externalAdoptionGuardKey: originalGuard,
        name: "Workers Paid",
        costUsd: 5,
        currency: "USD",
        interval: "monthly",
        intervalCount: 1,
        autoRenew: false,
        status: "active",
        startDate: period.currentPeriodStart,
        currentPeriodStart: period.currentPeriodStart,
        nextRenewalAt: period.currentPeriodEnd,
      },
    });

    const reshapeResponse = await PUT(
      new Request(`https://usage.jays.services/api/subscriptions/${subscription.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          externalBillingSource: null,
          externalBillingId: null,
          costUsd: 6,
          interval: "annual",
        }),
      }),
      { params: Promise.resolve({ id: subscription.id }) }
    );

    expect(reshapeResponse.status).toBe(200);
    expect(
      await prisma.subscription.findUnique({ where: { id: subscription.id } })
    ).toMatchObject({
      externalBillingSource: null,
      externalBillingId: null,
      externalBillingManaged: false,
      externalAdoptionGuardKey: null,
      costUsd: 6,
      interval: "annual",
    });

    // Price/cadence equivalence alone is not identity and must remain additive.
    const rematchResponse = await PUT(
      new Request(`https://usage.jays.services/api/subscriptions/${subscription.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ costUsd: 5, interval: "monthly" }),
      }),
      { params: Promise.resolve({ id: subscription.id }) }
    );

    expect(rematchResponse.status).toBe(200);
    expect(
      await prisma.subscription.findUnique({ where: { id: subscription.id } })
    ).toMatchObject({
      externalBillingSource: null,
      externalBillingId: null,
      externalBillingManaged: false,
      externalAdoptionGuardKey: null,
      costUsd: 5,
      interval: "monthly",
    });

    const relinkResponse = await PUT(
      new Request(`https://usage.jays.services/api/subscriptions/${subscription.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          externalBillingSource: "cloudflare-subscriptions",
          externalBillingId: "workers-paid-edit-guard",
        }),
      }),
      { params: Promise.resolve({ id: subscription.id }) }
    );

    expect(relinkResponse.status).toBe(200);
    expect(
      await prisma.subscription.findUnique({ where: { id: subscription.id } })
    ).toMatchObject({
      externalBillingSource: "cloudflare-subscriptions",
      externalBillingId: "workers-paid-edit-guard",
      externalBillingManaged: false,
      externalAdoptionGuardKey: originalGuard,
    });
  });

  it("allows a notes edit on an unchanged linked term that is effectively expired", async () => {
    const provider = await prisma.provider.create({
      data: { name: "cloudflare", displayName: "Cloudflare", type: "builtin" },
    });
    await prisma.providerExternalBilling.create({
      data: {
        providerId: provider.id,
        source: "cloudflare-subscriptions",
        externalId: "historic-workers-paid",
        kind: "subscription",
        status: "active",
        amountUsd: 5,
        currency: "USD",
        billingInterval: "monthly",
        ...liveMonthlyPeriod(),
        syncedAt: new Date(),
      },
    });
    const subscription = await prisma.subscription.create({
      data: {
        providerId: provider.id,
        externalBillingSource: "cloudflare-subscriptions",
        externalBillingId: "historic-workers-paid",
        name: "Historic Workers Paid",
        costUsd: 5,
        currency: "USD",
        interval: "monthly",
        intervalCount: 1,
        autoRenew: false,
        status: "active",
        startDate: new Date("2019-01-01T00:00:00Z"),
        currentPeriodStart: new Date("2019-01-01T00:00:00Z"),
        nextRenewalAt: new Date("2019-02-01T00:00:00Z"),
      },
    });

    const response = await PUT(
      new Request(`https://usage.jays.services/api/subscriptions/${subscription.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          providerId: provider.id,
          externalBillingSource: "cloudflare-subscriptions",
          externalBillingId: "historic-workers-paid",
          name: "Historic Workers Paid",
          costUsd: 5,
          currency: "USD",
          interval: "monthly",
          intervalCount: 1,
          autoRenew: false,
          status: "active",
          startDate: "2019-01-01",
          notes: "Keep the receipt reference",
        }),
      }),
      { params: Promise.resolve({ id: subscription.id }) }
    );

    expect(response.status).toBe(200);
    const stored = await prisma.subscription.findUnique({
      where: { id: subscription.id },
    });
    expect(stored?.notes).toBe("Keep the receipt reference");
    expect(stored?.currentPeriodStart.toISOString()).toBe(
      "2019-01-01T00:00:00.000Z"
    );
    expect(stored?.nextRenewalAt.toISOString()).toBe(
      "2019-02-01T00:00:00.000Z"
    );
  });

  it("reanchors an expired linked term before enabling another renewal", async () => {
    const provider = await prisma.provider.create({
      data: { name: "cloudflare", displayName: "Cloudflare", type: "builtin" },
    });
    const livePeriod = liveMonthlyPeriod();
    await prisma.providerExternalBilling.create({
      data: {
        providerId: provider.id,
        source: "cloudflare-subscriptions",
        externalId: "renewed-workers-paid",
        kind: "subscription",
        status: "active",
        amountUsd: 5,
        currency: "USD",
        billingInterval: "monthly",
        ...livePeriod,
        syncedAt: new Date(),
      },
    });
    const historicPeriod = new Date("2019-01-01T00:00:00Z");
    const subscription = await prisma.subscription.create({
      data: {
        providerId: provider.id,
        externalBillingSource: "cloudflare-subscriptions",
        externalBillingId: "renewed-workers-paid",
        name: "Expired Workers Paid",
        costUsd: 5,
        interval: "monthly",
        intervalCount: 1,
        autoRenew: false,
        status: "active",
        startDate: historicPeriod,
        currentPeriodStart: historicPeriod,
        nextRenewalAt: new Date("2019-02-01T00:00:00Z"),
        lastChargedPeriodStart: historicPeriod,
      },
    });

    const response = await PUT(
      new Request(`https://usage.jays.services/api/subscriptions/${subscription.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          externalBillingSource: "cloudflare-subscriptions",
          externalBillingId: "renewed-workers-paid",
          autoRenew: true,
          status: "active",
          activationMode: "repurchase",
        }),
      }),
      { params: Promise.resolve({ id: subscription.id }) }
    );

    expect(response.status).toBe(200);
    const stored = await prisma.subscription.findUnique({
      where: { id: subscription.id },
    });
    expect(stored?.startDate.toISOString()).toBe(
      livePeriod.currentPeriodStart.toISOString()
    );
    expect(stored?.currentPeriodStart.toISOString()).toBe(
      livePeriod.currentPeriodStart.toISOString()
    );
    expect(stored?.nextRenewalAt.toISOString()).toBe(
      livePeriod.currentPeriodEnd.toISOString()
    );
    expect(stored?.lastChargedPeriodStart).toBeNull();
  });

  it("reanchors a paused non-renewing linked term when repurchased", async () => {
    const provider = await prisma.provider.create({
      data: { name: "cloudflare", displayName: "Cloudflare", type: "builtin" },
    });
    const livePeriod = liveMonthlyPeriod();
    await prisma.providerExternalBilling.create({
      data: {
        providerId: provider.id,
        source: "cloudflare-subscriptions",
        externalId: "repurchased-workers-paid",
        kind: "subscription",
        status: "active",
        amountUsd: 5,
        currency: "USD",
        billingInterval: "monthly",
        ...livePeriod,
        syncedAt: new Date(),
      },
    });
    const historicPeriod = new Date("2019-01-01T00:00:00Z");
    const subscription = await prisma.subscription.create({
      data: {
        providerId: provider.id,
        externalBillingSource: "cloudflare-subscriptions",
        externalBillingId: "repurchased-workers-paid",
        name: "Paused Workers Paid",
        costUsd: 5,
        interval: "monthly",
        intervalCount: 1,
        autoRenew: false,
        status: "paused",
        startDate: historicPeriod,
        currentPeriodStart: historicPeriod,
        nextRenewalAt: new Date("2019-02-01T00:00:00Z"),
        lastChargedPeriodStart: historicPeriod,
      },
    });

    const response = await PUT(
      new Request(`https://usage.jays.services/api/subscriptions/${subscription.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          externalBillingSource: "cloudflare-subscriptions",
          externalBillingId: "repurchased-workers-paid",
          autoRenew: false,
          status: "active",
          activationMode: "repurchase",
        }),
      }),
      { params: Promise.resolve({ id: subscription.id }) }
    );

    expect(response.status).toBe(200);
    const stored = await prisma.subscription.findUnique({
      where: { id: subscription.id },
    });
    expect(stored?.status).toBe("active");
    expect(stored?.autoRenew).toBe(false);
    expect(stored?.currentPeriodStart.toISOString()).toBe(
      livePeriod.currentPeriodStart.toISOString()
    );
    expect(stored?.nextRenewalAt.toISOString()).toBe(
      livePeriod.currentPeriodEnd.toISOString()
    );
    expect(stored?.lastChargedPeriodStart).toBeNull();
  });

  it("reanchors a linked resume to the provider period and marks it paid", async () => {
    const provider = await prisma.provider.create({
      data: { name: "cloudflare", displayName: "Cloudflare", type: "builtin" },
    });
    const livePeriod = liveMonthlyPeriod();
    await prisma.providerExternalBilling.create({
      data: {
        providerId: provider.id,
        source: "cloudflare-subscriptions",
        externalId: "resumed-workers-paid",
        kind: "subscription",
        status: "active",
        amountUsd: 5,
        currency: "USD",
        billingInterval: "monthly",
        ...livePeriod,
        syncedAt: new Date(),
      },
    });
    const historicPeriod = new Date("2019-01-01T00:00:00Z");
    const subscription = await prisma.subscription.create({
      data: {
        providerId: provider.id,
        externalBillingSource: "cloudflare-subscriptions",
        externalBillingId: "resumed-workers-paid",
        name: "Paused Workers Paid",
        costUsd: 5,
        interval: "monthly",
        intervalCount: 1,
        autoRenew: true,
        status: "paused",
        startDate: historicPeriod,
        currentPeriodStart: historicPeriod,
        nextRenewalAt: new Date("2019-02-01T00:00:00Z"),
        lastChargedPeriodStart: historicPeriod,
      },
    });

    const response = await PUT(
      new Request(`https://usage.jays.services/api/subscriptions/${subscription.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          externalBillingSource: "cloudflare-subscriptions",
          externalBillingId: "resumed-workers-paid",
          status: "active",
          activationMode: "resume",
        }),
      }),
      { params: Promise.resolve({ id: subscription.id }) }
    );

    expect(response.status).toBe(200);
    const stored = await prisma.subscription.findUnique({
      where: { id: subscription.id },
    });
    expect(stored?.currentPeriodStart.toISOString()).toBe(
      livePeriod.currentPeriodStart.toISOString()
    );
    expect(stored?.nextRenewalAt.toISOString()).toBe(
      livePeriod.currentPeriodEnd.toISOString()
    );
    expect(stored?.lastChargedPeriodStart?.toISOString()).toBe(
      livePeriod.currentPeriodStart.toISOString()
    );
    expect(stored).not.toBeNull();
    expect(
      planSubscriptionCharges(
        {
          id: stored!.id,
          name: stored!.name,
          costUsd: stored!.costUsd,
          currency: stored!.currency,
          interval: stored!.interval,
          intervalCount: stored!.intervalCount,
          projectId: stored!.projectId,
          autoRenew: stored!.autoRenew,
          currentPeriodStart: stored!.currentPeriodStart,
          nextRenewalAt: stored!.nextRenewalAt,
          lastChargedPeriodStart: stored!.lastChargedPeriodStart,
          provider: { name: provider.name },
        },
        new Date()
      )
    ).toBeNull();
  });

  it("rejects backdating or re-anchoring an unchanged provider billing link", async () => {
    const provider = await prisma.provider.create({
      data: { name: "cloudflare", displayName: "Cloudflare", type: "builtin" },
    });
    const livePeriod = liveMonthlyPeriod();
    await prisma.providerExternalBilling.create({
      data: {
        providerId: provider.id,
        source: "cloudflare-subscriptions",
        externalId: "fixed-workers-paid",
        kind: "subscription",
        status: "active",
        amountUsd: 5,
        currency: "USD",
        billingInterval: "monthly",
        ...livePeriod,
        syncedAt: new Date(),
      },
    });
    const subscription = await prisma.subscription.create({
      data: {
        providerId: provider.id,
        externalBillingSource: "cloudflare-subscriptions",
        externalBillingId: "fixed-workers-paid",
        name: "Workers Paid",
        costUsd: 5,
        interval: "monthly",
        intervalCount: 1,
        startDate: livePeriod.currentPeriodStart,
        currentPeriodStart: livePeriod.currentPeriodStart,
        nextRenewalAt: livePeriod.currentPeriodEnd,
      },
    });

    for (const update of [
      { startDate: "2019-01-01" },
      { anchorDay: 15 },
    ]) {
      const response = await PUT(
        new Request(`https://usage.jays.services/api/subscriptions/${subscription.id}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(update),
        }),
        { params: Promise.resolve({ id: subscription.id }) }
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: expect.stringContaining("Unlink"),
      });
    }

    const stored = await prisma.subscription.findUnique({
      where: { id: subscription.id },
    });
    expect(stored?.startDate.toISOString()).toBe(
      livePeriod.currentPeriodStart.toISOString()
    );
    expect(stored?.anchorDay).toBeNull();
  });

  it("links charged history only when its watermark matches the provider period", async () => {
    const provider = await prisma.provider.create({
      data: { name: "cloudflare", displayName: "Cloudflare", type: "builtin" },
    });
    const livePeriod = liveMonthlyPeriod();
    await prisma.providerExternalBilling.create({
      data: {
        providerId: provider.id,
        source: "cloudflare-subscriptions",
        externalId: "watermarked-workers-paid",
        kind: "subscription",
        status: "active",
        amountUsd: 5,
        currency: "USD",
        billingInterval: "monthly",
        ...livePeriod,
        syncedAt: new Date(),
      },
    });
    const historicPeriod = new Date("2019-01-01T00:00:00Z");
    const subscription = await prisma.subscription.create({
      data: {
        providerId: provider.id,
        name: "Previously charged Workers Paid",
        costUsd: 5,
        interval: "monthly",
        startDate: historicPeriod,
        currentPeriodStart: historicPeriod,
        nextRenewalAt: new Date("2019-02-01T00:00:00Z"),
        lastChargedPeriodStart: historicPeriod,
      },
    });
    const linkBody = JSON.stringify({
      externalBillingSource: "cloudflare-subscriptions",
      externalBillingId: "watermarked-workers-paid",
    });

    const mismatchedResponse = await PUT(
      new Request(`https://usage.jays.services/api/subscriptions/${subscription.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: linkBody,
      }),
      { params: Promise.resolve({ id: subscription.id }) }
    );
    expect(mismatchedResponse.status).toBe(400);
    await expect(mismatchedResponse.json()).resolves.toMatchObject({
      error: expect.stringContaining("different billing period"),
    });

    await prisma.subscription.update({
      where: { id: subscription.id },
      data: {
        startDate: livePeriod.currentPeriodStart,
        currentPeriodStart: livePeriod.currentPeriodStart,
        nextRenewalAt: livePeriod.currentPeriodEnd,
        lastChargedPeriodStart: livePeriod.currentPeriodStart,
      },
    });
    const matchingResponse = await PUT(
      new Request(`https://usage.jays.services/api/subscriptions/${subscription.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: linkBody,
      }),
      { params: Promise.resolve({ id: subscription.id }) }
    );
    expect(matchingResponse.status).toBe(200);
    const stored = await prisma.subscription.findUnique({
      where: { id: subscription.id },
    });
    expect(stored?.externalBillingId).toBe("watermarked-workers-paid");
    expect(stored?.lastChargedPeriodStart?.toISOString()).toBe(
      livePeriod.currentPeriodStart.toISOString()
    );
  });

  it("rejects linking charged history to an overlapping provider period with the same start", async () => {
    const provider = await prisma.provider.create({
      data: { name: "cloudflare", displayName: "Cloudflare", type: "builtin" },
    });
    const cadencePeriod = liveMonthlyPeriod();
    const shortenedPeriodEnd = new Date(
      Math.floor((Date.now() + cadencePeriod.currentPeriodEnd.getTime()) / 2)
    );
    await prisma.providerExternalBilling.create({
      data: {
        providerId: provider.id,
        source: "cloudflare-subscriptions",
        externalId: "shortened-workers-paid",
        kind: "subscription",
        status: "active",
        amountUsd: 5,
        currency: "USD",
        billingInterval: "monthly",
        currentPeriodStart: cadencePeriod.currentPeriodStart,
        currentPeriodEnd: shortenedPeriodEnd,
        syncedAt: new Date(),
      },
    });
    const subscription = await prisma.subscription.create({
      data: {
        providerId: provider.id,
        name: "Already charged Workers Paid",
        costUsd: 5,
        interval: "monthly",
        startDate: cadencePeriod.currentPeriodStart,
        currentPeriodStart: cadencePeriod.currentPeriodStart,
        nextRenewalAt: cadencePeriod.currentPeriodEnd,
        lastChargedPeriodStart: cadencePeriod.currentPeriodStart,
      },
    });

    const response = await PUT(
      new Request(`https://usage.jays.services/api/subscriptions/${subscription.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          externalBillingSource: "cloudflare-subscriptions",
          externalBillingId: "shortened-workers-paid",
        }),
      }),
      { params: Promise.resolve({ id: subscription.id }) }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("different billing period"),
    });
    const stored = await prisma.subscription.findUnique({
      where: { id: subscription.id },
    });
    expect(stored?.externalBillingId).toBeNull();
    expect(stored?.nextRenewalAt.toISOString()).toBe(
      cadencePeriod.currentPeriodEnd.toISOString()
    );
  });

  it("rejects an edit that would make an existing provider billing link incompatible", async () => {
    const provider = await prisma.provider.create({
      data: { name: "cloudflare", displayName: "Cloudflare", type: "builtin" },
    });
    await prisma.providerExternalBilling.create({
      data: {
        providerId: provider.id,
        source: "cloudflare-subscriptions",
        externalId: "workers-paid",
        kind: "subscription",
        status: "active",
        amountUsd: 5,
        currency: "USD",
        billingInterval: "month",
        ...liveMonthlyPeriod(),
        syncedAt: new Date(),
      },
    });
    const subscription = await prisma.subscription.create({
      data: {
        providerId: provider.id,
        externalBillingSource: "cloudflare-subscriptions",
        externalBillingId: "workers-paid",
        name: "Workers Paid",
        costUsd: 5,
        interval: "monthly",
        status: "active",
        startDate: new Date("2026-07-01T00:00:00Z"),
        currentPeriodStart: new Date("2026-07-01T00:00:00Z"),
        nextRenewalAt: new Date("2026-08-01T00:00:00Z"),
      },
    });

    const response = await PUT(
      new Request(`https://usage.jays.services/api/subscriptions/${subscription.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ costUsd: 6 }),
      }),
      { params: Promise.resolve({ id: subscription.id }) }
    );

    expect(response.status).toBe(400);
    expect(
      (await prisma.subscription.findUnique({ where: { id: subscription.id } }))
        ?.costUsd
    ).toBe(5);
  });

  it("moves a subscription to another existing provider", async () => {
    const original = await prisma.provider.create({
      data: { name: "fmp", displayName: "FMP", type: "builtin", refreshIntervalMin: 60 },
    });
    const replacement = await prisma.provider.create({
      data: { name: "tiingo", displayName: "Tiingo", type: "builtin", refreshIntervalMin: 60 },
    });
    const subscription = await prisma.subscription.create({
      data: {
        providerId: original.id,
        name: "Market data plan",
        costUsd: 20,
        startDate: new Date("2026-07-01T00:00:00Z"),
        currentPeriodStart: new Date("2026-07-01T00:00:00Z"),
        nextRenewalAt: new Date("2026-08-01T00:00:00Z"),
      },
    });

    const response = await PUT(
      new Request(`https://usage.jays.services/api/subscriptions/${subscription.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerId: replacement.id }),
      }),
      { params: Promise.resolve({ id: subscription.id }) }
    );

    expect(response.status).toBe(200);
    const stored = await prisma.subscription.findUnique({ where: { id: subscription.id } });
    expect(stored?.providerId).toBe(replacement.id);
  });

  it("rejects an unknown provider without changing the subscription", async () => {
    const provider = await prisma.provider.create({
      data: { name: "fmp", displayName: "FMP", type: "builtin", refreshIntervalMin: 60 },
    });
    const subscription = await prisma.subscription.create({
      data: {
        providerId: provider.id,
        name: "Market data plan",
        costUsd: 20,
        startDate: new Date("2026-07-01T00:00:00Z"),
        currentPeriodStart: new Date("2026-07-01T00:00:00Z"),
        nextRenewalAt: new Date("2026-08-01T00:00:00Z"),
      },
    });

    const response = await PUT(
      new Request(`https://usage.jays.services/api/subscriptions/${subscription.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerId: "missing-provider" }),
      }),
      { params: Promise.resolve({ id: subscription.id }) }
    );

    expect(response.status).toBe(400);
    const stored = await prisma.subscription.findUnique({ where: { id: subscription.id } });
    expect(stored?.providerId).toBe(provider.id);
  });

  it("rejects moving a provider billing link onto an identity used by another subscription", async () => {
    const provider = await prisma.provider.create({
      data: { name: "cloudflare", displayName: "Cloudflare", type: "builtin" },
    });
    await prisma.providerExternalBilling.create({
      data: {
        providerId: provider.id,
        source: "cloudflare-subscriptions",
        externalId: "workers-paid",
        kind: "subscription",
        status: "active",
        amountUsd: 5,
        currency: "USD",
        billingInterval: "monthly",
        ...liveMonthlyPeriod(),
        syncedAt: new Date(),
      },
    });
    const existing = await prisma.subscription.create({
      data: {
        providerId: provider.id,
        externalBillingSource: "cloudflare-subscriptions",
        externalBillingId: "workers-paid",
        name: "Existing link",
        costUsd: 5,
        startDate: new Date("2026-07-01T00:00:00Z"),
        currentPeriodStart: new Date("2026-07-01T00:00:00Z"),
        nextRenewalAt: new Date("2026-08-01T00:00:00Z"),
      },
    });
    const candidate = await prisma.subscription.create({
      data: {
        providerId: provider.id,
        name: "Candidate",
        costUsd: 5,
        startDate: new Date("2026-07-01T00:00:00Z"),
        currentPeriodStart: new Date("2026-07-01T00:00:00Z"),
        nextRenewalAt: new Date("2026-08-01T00:00:00Z"),
      },
    });

    const response = await PUT(
      new Request(`https://usage.jays.services/api/subscriptions/${candidate.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          externalBillingSource: "cloudflare-subscriptions",
          externalBillingId: "workers-paid",
        }),
      }),
      { params: Promise.resolve({ id: candidate.id }) }
    );

    expect(response.status).toBe(409);
    expect(existing.id).not.toBe(candidate.id);
    const stored = await prisma.subscription.findUnique({ where: { id: candidate.id } });
    expect(stored?.externalBillingId).toBeNull();
  });
});
