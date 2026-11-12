import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createSessionToken, SESSION_COOKIE_NAME } from "@/lib/auth";
import { GET } from "../route";

const mocks = vi.hoisted(() => ({
  computeAgentsOverview: vi.fn(),
}));

vi.mock("@/lib/agents-overview", () => ({
  computeAgentsOverview: mocks.computeAgentsOverview,
}));

describe("GET /api/agents-overview", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = {
      ...originalEnv,
      NODE_ENV: "production",
      SESSION_SECRET: "test-session-secret-at-least-32-chars-long",
      USAGE_READ_TOKEN: "read-token-1234567890abcdef",
      ADMIN_PASSWORD: "secret-password-xyz",
    };
    mocks.computeAgentsOverview.mockReset();
    mocks.computeAgentsOverview.mockResolvedValue({
      ok: true,
      windowDays: 30,
      windowLabel: "Last 30 Days",
      summary: {
        activeAgentCount: 3,
        totalAgentCount: 6,
        totalTokens: 1500000,
        totalApiEquivalentCostUsd: 45.2,
        totalSubscriptionCostUsd: 60.0,
        totalNetSavingsUsd: 0,
        savingsMultiplier: 0.8,
        topModel: "claude-3-7-sonnet",
      },
      platforms: [],
      modelDistribution: [],
    });
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("authorizes requests with a valid dashboard session cookie", async () => {
    const sessionToken = createSessionToken();
    const request = new NextRequest("https://usage.jays.services/api/agents-overview?window=30d", {
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
      },
    });

    const response = await GET(request);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.ok).toBe(true);
    expect(data.summary.totalTokens).toBe(1500000);
    expect(mocks.computeAgentsOverview).toHaveBeenCalledWith(30);
  });

  it("authorizes requests with a valid USAGE_READ_TOKEN bearer header", async () => {
    const request = new NextRequest("https://usage.jays.services/api/agents-overview?window=7d", {
      headers: {
        authorization: "Bearer read-token-1234567890abcdef",
      },
    });

    const response = await GET(request);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.ok).toBe(true);
    expect(mocks.computeAgentsOverview).toHaveBeenCalledWith(7);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const request = new NextRequest("https://usage.jays.services/api/agents-overview");
    const response = await GET(request);
    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.ok).toBe(false);
  });

  it("correctly parses 5h window parameter", async () => {
    const sessionToken = createSessionToken();
    const request = new NextRequest("https://usage.jays.services/api/agents-overview?window=5h", {
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
      },
    });

    const response = await GET(request);
    expect(response.status).toBe(200);
    expect(mocks.computeAgentsOverview).toHaveBeenCalledWith(0.2083);
  });
});
