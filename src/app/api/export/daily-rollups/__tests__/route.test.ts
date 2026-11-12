import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { externalUsageEventDailyRollup: { findMany: mocks.findMany } },
}));

let GET: typeof import("../route").GET;
let createSessionToken: typeof import("@/lib/auth").createSessionToken;
let SESSION_COOKIE_NAME: typeof import("@/lib/auth").SESSION_COOKIE_NAME;

const READ_TOKEN = "export-route-read-token";

function rollupRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "row-1",
    day: new Date("2026-07-20T00:00:00.000Z"),
    groupKey: "grp-1",
    sourceApp: "claude-code",
    environment: "prod",
    provider: "anthropic",
    service: "claude-code",
    label: null,
    keyRef: null,
    billingMode: "api",
    metricType: "tokens",
    unit: "tokens",
    limitWindow: null,
    tier: null,
    confidence: "exact",
    projectId: null,
    eventCount: 12,
    pricedEventCount: 12,
    unpricedEventCount: 0,
    unclassifiedCostEventCount: 0,
    totalCostUsd: 1.25,
    totalRequests: 12,
    totalQuantity: 3400,
    totalCredits: 0,
    maxLimit: null,
    latestOccurredAt: new Date("2026-07-20T08:30:00.000Z"),
    createdAt: new Date("2026-07-20T09:00:00.000Z"),
    updatedAt: new Date("2026-07-20T09:00:00.000Z"),
    ...overrides,
  };
}

beforeAll(async () => {
  process.env.SESSION_SECRET = "export-route-test-secret";
  ({ GET } = await import("../route"));
  ({ createSessionToken, SESSION_COOKIE_NAME } = await import("@/lib/auth"));
});

beforeEach(() => {
  delete process.env.USAGE_READ_TOKEN;
  delete process.env.USAGE_INGEST_TOKEN;
  delete process.env.USAGE_READ_TOKEN_ALLOW_INGEST_FALLBACK;
  mocks.findMany.mockReset();
  mocks.findMany.mockResolvedValue([rollupRow()]);
});

function request(
  url = "https://usage.jays.services/api/export/daily-rollups",
  headers: Record<string, string> = {}
): NextRequest {
  return new NextRequest(url, { method: "GET", headers });
}

function bearerRequest(url?: string): NextRequest {
  return request(url, { authorization: `Bearer ${READ_TOKEN}` });
}

describe("GET /api/export/daily-rollups", () => {
  it("rejects unauthenticated requests without querying", async () => {
    process.env.USAGE_READ_TOKEN = READ_TOKEN;

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("rejects a wrong bearer token", async () => {
    process.env.USAGE_READ_TOKEN = READ_TOKEN;

    const response = await GET(
      request(undefined, { authorization: "Bearer wrong-token" })
    );

    expect(response.status).toBe(401);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("exports JSON for a bearer read token with a bounded default window", async () => {
    process.env.USAGE_READ_TOKEN = READ_TOKEN;
    const expectedTo = new Date();
    expectedTo.setUTCHours(0, 0, 0, 0);
    const expectedFrom = new Date(expectedTo.getTime() - 29 * 86_400_000);

    const response = await GET(bearerRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.rowCount).toBe(1);
    expect(body.truncated).toBe(false);
    expect(body.rows[0]).toMatchObject({
      day: "2026-07-20",
      provider: "anthropic",
      eventCount: 12,
      totalCostUsd: 1.25,
      latestOccurredAt: "2026-07-20T08:30:00.000Z",
    });

    const where = mocks.findMany.mock.calls[0][0].where;
    expect(where.day.gte.getTime()).toBe(expectedFrom.getTime());
    // Inclusive `to` day => exclusive upper bound at the next UTC midnight.
    expect(where.day.lt.getTime()).toBe(
      expectedTo.getTime() + 86_400_000
    );
    expect(mocks.findMany.mock.calls[0][0].take).toBe(10_001);
  });

  it("honors an explicit from/to window", async () => {
    process.env.USAGE_READ_TOKEN = READ_TOKEN;

    const response = await GET(
      bearerRequest(
        "https://usage.jays.services/api/export/daily-rollups?from=2026-07-01&to=2026-07-14"
      )
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.from).toBe("2026-07-01");
    expect(body.to).toBe("2026-07-14");
    const where = mocks.findMany.mock.calls[0][0].where;
    expect(where.day.gte.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(where.day.lt.toISOString()).toBe("2026-07-15T00:00:00.000Z");
  });

  it("accepts a verified dashboard session", async () => {
    const token = createSessionToken();
    const response = await GET(
      request(undefined, { cookie: `${SESSION_COOKIE_NAME}=${token}` })
    );

    expect(response.status).toBe(200);
    expect(mocks.findMany).toHaveBeenCalledTimes(1);
  });

  it("exports CSV with a formula-injection guard and attachment headers", async () => {
    process.env.USAGE_READ_TOKEN = READ_TOKEN;
    mocks.findMany.mockResolvedValue([
      rollupRow({ groupKey: "=HYPERLINK(\"https://evil.example\")" }),
    ]);

    const response = await GET(
      bearerRequest(
        "https://usage.jays.services/api/export/daily-rollups?format=csv&from=2026-07-20&to=2026-07-20"
      )
    );
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="daily-rollups_2026-07-20_2026-07-20.csv"'
    );
    const lines = text.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("day,groupKey,sourceApp");
    expect(lines[1]).toContain(
      "'=HYPERLINK(\"\"https://evil.example\"\")"
    );
    expect(lines[1]).toContain("2026-07-20");
  });

  it("rejects malformed, inverted, and oversized windows without querying", async () => {
    process.env.USAGE_READ_TOKEN = READ_TOKEN;

    for (const query of [
      "from=2026-13-01",
      "from=2026-02-30",
      "to=07/01/2026",
      "from=2026-07-20&to=2026-07-01",
      "from=2026-01-01&to=2026-07-01", // 182 days > 92-day maximum
    ]) {
      const response = await GET(
        bearerRequest(
          `https://usage.jays.services/api/export/daily-rollups?${query}`
        )
      );
      expect(response.status).toBe(400);
    }
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("rejects an unknown format", async () => {
    process.env.USAGE_READ_TOKEN = READ_TOKEN;

    const response = await GET(
      bearerRequest(
        "https://usage.jays.services/api/export/daily-rollups?format=xlsx"
      )
    );

    expect(response.status).toBe(400);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("caps rows and reports truncation", async () => {
    process.env.USAGE_READ_TOKEN = READ_TOKEN;
    mocks.findMany.mockResolvedValue(
      Array.from({ length: 10_001 }, (_, i) => rollupRow({ id: `row-${i}` }))
    );

    const response = await GET(bearerRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.rowCount).toBe(10_000);
    expect(body.truncated).toBe(true);
  });

  it("returns 500 when the database read fails", async () => {
    process.env.USAGE_READ_TOKEN = READ_TOKEN;
    mocks.findMany.mockRejectedValue(new Error("database unavailable"));

    const response = await GET(bearerRequest());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Failed to export daily rollups",
    });
  });
});
