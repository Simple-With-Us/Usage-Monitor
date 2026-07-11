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

const READ_TOKEN = "read-token-abc";
const SESSION_PASSWORD = "test-dashboard-password";

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subscriptions-route-test-"));
  dbPath = path.join(dir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.USAGE_READ_TOKEN = READ_TOKEN;
  process.env.DASHBOARD_PASSWORD = SESSION_PASSWORD;
  delete process.env.USAGE_INGEST_TOKEN;

  setupPrismaSqliteTestDb(dbPath);

  ({ GET, POST } = await import("../route"));
  ({ PUT } = await import("../[id]/route"));
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
});

describe("PUT /api/subscriptions/:id — provider editing", () => {
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
});
