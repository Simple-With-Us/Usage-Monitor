import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createSessionToken, SESSION_COOKIE_NAME } from "@/lib/auth";
import { GET } from "../route";

const mocks = vi.hoisted(() => ({
  getLatestMacHealth: vi.fn(),
}));

vi.mock("@/lib/mac-health", () => ({
  getLatestMacHealth: mocks.getLatestMacHealth,
}));

describe("GET /api/health/mac", () => {
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
    mocks.getLatestMacHealth.mockReset();
    mocks.getLatestMacHealth.mockResolvedValue({
      ok: true,
      mac: {
        hostname: "Jays-MacBook-Pro",
        cpuUsage: 12.5,
      },
    });
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("authorizes requests with a valid dashboard session cookie", async () => {
    const sessionToken = createSessionToken();
    const request = new NextRequest("https://usage.jays.services/api/health/mac", {
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
      },
    });

    const response = await GET(request);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.mac.hostname).toBe("Jays-MacBook-Pro");
  });

  it("authorizes requests with a valid USAGE_READ_TOKEN bearer header", async () => {
    const request = new NextRequest("https://usage.jays.services/api/health/mac", {
      headers: {
        authorization: "Bearer read-token-1234567890abcdef",
      },
    });

    const response = await GET(request);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.mac.hostname).toBe("Jays-MacBook-Pro");
  });

  it("rejects unauthorized requests with 401 when no valid session or token is provided", async () => {
    const request = new NextRequest("https://usage.jays.services/api/health/mac");
    const response = await GET(request);
    expect(response.status).toBe(401);
  });

  it("rejects invalid bearer tokens with 401", async () => {
    const request = new NextRequest("https://usage.jays.services/api/health/mac", {
      headers: {
        authorization: "Bearer invalid-token",
      },
    });
    const response = await GET(request);
    expect(response.status).toBe(401);
  });
});
