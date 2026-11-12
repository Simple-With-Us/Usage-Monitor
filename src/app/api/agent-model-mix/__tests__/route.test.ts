import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  loadAgentModelMixRows: vi.fn(),
}));

vi.mock("@/lib/agent-model-mix", async () => {
  const actual = await vi.importActual<typeof import("@/lib/agent-model-mix")>(
    "@/lib/agent-model-mix"
  );
  return {
    ...actual,
    // Only the DB-loading function is mocked; buildAgentModelMixReport (the
    // pure reducer) stays real, matching the budget-status route test
    // pattern.
    loadAgentModelMixRows: mocks.loadAgentModelMixRows,
  };
});

let GET: typeof import("../route").GET;
let createSessionToken: typeof import("@/lib/auth").createSessionToken;
let SESSION_COOKIE_NAME: typeof import("@/lib/auth").SESSION_COOKIE_NAME;

const READ_TOKEN = "native-read-token";

beforeAll(async () => {
  process.env.SESSION_SECRET = "agent-model-mix-route-test-secret";
  ({ GET } = await import("../route"));
  ({ createSessionToken, SESSION_COOKIE_NAME } = await import("@/lib/auth"));
});

beforeEach(() => {
  delete process.env.USAGE_READ_TOKEN;
  delete process.env.USAGE_INGEST_TOKEN;
  delete process.env.USAGE_READ_TOKEN_ALLOW_INGEST_FALLBACK;
  mocks.loadAgentModelMixRows.mockReset();
  mocks.loadAgentModelMixRows.mockResolvedValue([]);
});

function request(
  searchParams: Record<string, string> = {},
  headers: Record<string, string> = {}
): NextRequest {
  const url = new URL("https://usage.jays.services/api/agent-model-mix");
  for (const [key, value] of Object.entries(searchParams)) {
    url.searchParams.set(key, value);
  }
  return new NextRequest(url, { method: "GET", headers });
}

describe("GET /api/agent-model-mix authentication", () => {
  it("returns 503 when no read token is configured and there is no dashboard session", async () => {
    const response = await GET(request());

    expect(response.status).toBe(503);
    expect(mocks.loadAgentModelMixRows).not.toHaveBeenCalled();
  });

  it("rejects a request without a valid bearer or dashboard session", async () => {
    process.env.USAGE_READ_TOKEN = READ_TOKEN;

    const response = await GET(request({}, { authorization: "Bearer wrong-token" }));

    expect(response.status).toBe(401);
    expect(mocks.loadAgentModelMixRows).not.toHaveBeenCalled();
  });

  it("accepts the dedicated read bearer token", async () => {
    process.env.USAGE_READ_TOKEN = READ_TOKEN;

    const response = await GET(request({}, { authorization: `Bearer ${READ_TOKEN}` }));

    expect(response.status).toBe(200);
    expect(mocks.loadAgentModelMixRows).toHaveBeenCalledOnce();
  });

  it("accepts a verified dashboard session without requiring a read token", async () => {
    const response = await GET(
      request({}, { cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}` })
    );

    expect(response.status).toBe(200);
    expect(mocks.loadAgentModelMixRows).toHaveBeenCalledOnce();
  });
});

describe("GET /api/agent-model-mix windowing", () => {
  beforeEach(() => {
    process.env.USAGE_READ_TOKEN = READ_TOKEN;
  });

  it("defaults to a trailing 7-day window", async () => {
    const response = await GET(request({}, { authorization: `Bearer ${READ_TOKEN}` }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.days).toBe(7);
    const spanMs = Date.parse(body.windowEnd) - Date.parse(body.windowStart);
    expect(spanMs).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("honors an explicit days param within bounds", async () => {
    const response = await GET(
      request({ days: "14" }, { authorization: `Bearer ${READ_TOKEN}` })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.days).toBe(14);
  });

  it("rejects a days param outside 1-90", async () => {
    const response = await GET(
      request({ days: "0" }, { authorization: `Bearer ${READ_TOKEN}` })
    );
    expect(response.status).toBe(400);

    const tooLarge = await GET(
      request({ days: "91" }, { authorization: `Bearer ${READ_TOKEN}` })
    );
    expect(tooLarge.status).toBe(400);
  });

  it("honors an explicit since/until pair and rejects until <= since", async () => {
    const ok = await GET(
      request(
        { since: "2026-09-01T00:00:00.000Z", until: "2026-09-08T00:00:00.000Z" },
        { authorization: `Bearer ${READ_TOKEN}` }
      )
    );
    expect(ok.status).toBe(200);
    const okBody = await ok.json();
    expect(okBody.windowStart).toBe("2026-09-01T00:00:00.000Z");
    expect(okBody.windowEnd).toBe("2026-09-08T00:00:00.000Z");

    const backwards = await GET(
      request(
        { since: "2026-09-08T00:00:00.000Z", until: "2026-09-01T00:00:00.000Z" },
        { authorization: `Bearer ${READ_TOKEN}` }
      )
    );
    expect(backwards.status).toBe(400);
  });

  it("shapes the response with the documented field set", async () => {
    mocks.loadAgentModelMixRows.mockResolvedValue([
      {
        sourceApp: "claude-code",
        provider: "anthropic",
        model: "claude-sonnet-5",
        seat: null,
        project: "usage-monitor",
        tokens: 1234567,
        costUsd: 12.34,
        eventCount: 42,
      },
    ]);

    const response = await GET(request({}, { authorization: `Bearer ${READ_TOKEN}` }));
    const body = await response.json();

    expect(body.costSemantics).toBe("estimated_api_equivalent_not_authoritative");
    expect(body.billingMode).toBe("estimated");
    expect(body.seatDataAvailable).toBe(false);
    expect(body.rows).toEqual([
      {
        sourceApp: "claude-code",
        provider: "anthropic",
        model: "claude-sonnet-5",
        seat: null,
        project: "usage-monitor",
        tokens: 1234567,
        costUsd: 12.34,
        eventCount: 42,
      },
    ]);
    expect(body.totals).toEqual({ tokens: 1234567, costUsd: 12.34, eventCount: 42 });
  });
});
