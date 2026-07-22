import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  computeProjectBudgetStatus: vi.fn(),
}));

vi.mock("@/lib/budget-status", () => ({
  computeProjectBudgetStatus: mocks.computeProjectBudgetStatus,
}));

let GET: typeof import("../route").GET;
let createSessionToken: typeof import("@/lib/auth").createSessionToken;
let SESSION_COOKIE_NAME: typeof import("@/lib/auth").SESSION_COOKIE_NAME;

const READ_TOKEN = "native-read-token";

beforeAll(async () => {
  process.env.SESSION_SECRET = "budget-status-route-test-secret";
  ({ GET } = await import("../route"));
  ({ createSessionToken, SESSION_COOKIE_NAME } = await import("@/lib/auth"));
});

beforeEach(() => {
  delete process.env.USAGE_READ_TOKEN;
  delete process.env.USAGE_INGEST_TOKEN;
  delete process.env.USAGE_READ_TOKEN_ALLOW_INGEST_FALLBACK;
  mocks.computeProjectBudgetStatus.mockReset();
  mocks.computeProjectBudgetStatus.mockResolvedValue({
    generatedAt: "2026-07-21T00:00:00.000Z",
    providers: [],
    projects: [],
    summary: {},
  });
});

function request(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("https://usage.jays.services/api/budget-status", {
    method: "GET",
    headers,
  });
}

describe("GET /api/budget-status authentication", () => {
  it("keeps the existing configuration error for unauthenticated read clients", async () => {
    const response = await GET(request());

    expect(response.status).toBe(503);
    expect(mocks.computeProjectBudgetStatus).not.toHaveBeenCalled();
  });

  it("rejects a request without a valid bearer or dashboard session", async () => {
    process.env.USAGE_READ_TOKEN = READ_TOKEN;

    const response = await GET(request({ authorization: "Bearer wrong-token" }));

    expect(response.status).toBe(401);
    expect(mocks.computeProjectBudgetStatus).not.toHaveBeenCalled();
  });

  it("accepts the dedicated read bearer token", async () => {
    process.env.USAGE_READ_TOKEN = READ_TOKEN;

    const response = await GET(
      request({ authorization: `Bearer ${READ_TOKEN}` })
    );

    expect(response.status).toBe(200);
    expect(mocks.computeProjectBudgetStatus).toHaveBeenCalledOnce();
  });

  it("accepts a verified dashboard session without requiring a read token", async () => {
    const response = await GET(
      request({
        cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}`,
      })
    );

    expect(response.status).toBe(200);
    expect(mocks.computeProjectBudgetStatus).toHaveBeenCalledOnce();
  });
});
