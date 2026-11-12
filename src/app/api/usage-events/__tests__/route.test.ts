import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  eventFindMany: vi.fn(),
  projectFindMany: vi.fn(),
  providerFindMany: vi.fn(),
  summarize: vi.fn(),
  buildDailySpendSeries: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    externalUsageEvent: { findMany: mocks.eventFindMany },
    project: { findMany: mocks.projectFindMany },
    provider: { findMany: mocks.providerFindMany },
  },
}));

vi.mock("@/lib/external-usage-events", () => ({
  summarizeExternalUsageEvents: mocks.summarize,
  buildDailySpendSeries: mocks.buildDailySpendSeries,
  classifyCostCoverage: () => "complete",
}));

vi.mock("@/lib/data-retention", () => ({
  getExternalEventRawCutoff: () => new Date("2026-01-01T00:00:00.000Z"),
}));

vi.mock("@/lib/provider-identity", () => ({
  resolveProviderIdentity: () => null,
}));

let GET: typeof import("../route").GET;
let createSessionToken: typeof import("@/lib/auth").createSessionToken;
let SESSION_COOKIE_NAME: typeof import("@/lib/auth").SESSION_COOKIE_NAME;

const READ_TOKEN = "usage-events-route-read-token";

function eventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt-1",
    sourceApp: "codex-smoke",
    provider: "openai",
    service: "responses",
    projectId: null,
    metricType: "cost",
    quantity: null,
    unit: null,
    limit: null,
    credits: null,
    costUsd: 1.5,
    requests: 3,
    billingMode: "actual",
    confidence: "actual",
    verificationStatus: null,
    occurredAt: new Date("2026-07-20T08:30:00.000Z"),
    idempotencyKey: "evt-key-1",
    metadata: null,
    ...overrides,
  };
}

beforeAll(async () => {
  process.env.SESSION_SECRET = "usage-events-route-test-secret";
  ({ GET } = await import("../route"));
  ({ createSessionToken, SESSION_COOKIE_NAME } = await import("@/lib/auth"));
});

beforeEach(() => {
  delete process.env.USAGE_READ_TOKEN;
  delete process.env.USAGE_INGEST_TOKEN;
  delete process.env.USAGE_READ_TOKEN_ALLOW_INGEST_FALLBACK;
  mocks.eventFindMany.mockReset();
  mocks.eventFindMany.mockResolvedValue([eventRow()]);
  mocks.projectFindMany.mockReset();
  mocks.projectFindMany.mockResolvedValue([]);
  mocks.providerFindMany.mockReset();
  mocks.providerFindMany.mockResolvedValue([]);
  mocks.summarize.mockReset();
  mocks.summarize.mockResolvedValue({
    groups: [],
    derivedCostEstimateUsd: 0,
    derivedCostEstimateEventCount: 0,
  });
  mocks.buildDailySpendSeries.mockReset();
  mocks.buildDailySpendSeries.mockResolvedValue([]);
});

function request(
  url = "https://usage.jays.services/api/usage-events?raw=1",
  headers: Record<string, string> = {}
): NextRequest {
  return new NextRequest(url, { method: "GET", headers });
}

function bearerRequest(url?: string): NextRequest {
  return request(url, { authorization: `Bearer ${READ_TOKEN}` });
}

describe("GET /api/usage-events auth", () => {
  it("rejects unauthenticated requests without querying", async () => {
    process.env.USAGE_READ_TOKEN = READ_TOKEN;

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(mocks.eventFindMany).not.toHaveBeenCalled();
    expect(mocks.summarize).not.toHaveBeenCalled();
  });

  it("rejects a wrong bearer token", async () => {
    process.env.USAGE_READ_TOKEN = READ_TOKEN;

    const response = await GET(
      request(undefined, { authorization: "Bearer wrong-token" })
    );

    expect(response.status).toBe(401);
    expect(mocks.eventFindMany).not.toHaveBeenCalled();
  });

  it("serves raw events for a bearer read token (poster snapshot path)", async () => {
    process.env.USAGE_READ_TOKEN = READ_TOKEN;

    const response = await GET(bearerRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.mode).toBe("raw");
    expect(body.events).toHaveLength(1);
    expect(body.events[0].idempotencyKey).toBe("evt-key-1");
    expect(mocks.eventFindMany).toHaveBeenCalledTimes(1);
  });

  it("serves the summary for a bearer read token", async () => {
    process.env.USAGE_READ_TOKEN = READ_TOKEN;

    const response = await GET(
      bearerRequest("https://usage.jays.services/api/usage-events?days=30")
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.mode).toBe("summary");
    expect(mocks.summarize).toHaveBeenCalledTimes(1);
  });

  it("accepts a verified dashboard session", async () => {
    const token = createSessionToken();
    const response = await GET(
      request(undefined, { cookie: `${SESSION_COOKIE_NAME}=${token}` })
    );

    expect(response.status).toBe(200);
    expect(mocks.eventFindMany).toHaveBeenCalledTimes(1);
  });
});
