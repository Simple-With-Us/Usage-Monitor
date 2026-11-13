import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  readAlertDeliveryConfig: vi.fn(),
  apnsConfigured: vi.fn(),
  loadApnsConfig: vi.fn(),
  count: vi.fn(),
}));

vi.mock("@/lib/alert-delivery", () => ({
  readAlertDeliveryConfig: mocks.readAlertDeliveryConfig,
}));

vi.mock("@/lib/apns", () => ({
  apnsConfigured: mocks.apnsConfigured,
  loadApnsConfig: mocks.loadApnsConfig,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    apnsDeviceToken: {
      count: mocks.count,
    },
  },
}));

let GET: typeof import("../route").GET;
let PUT: typeof import("../route").PUT;
let createSessionToken: typeof import("@/lib/auth").createSessionToken;
let SESSION_COOKIE_NAME: typeof import("@/lib/auth").SESSION_COOKIE_NAME;

const READ_TOKEN = "read-token-settings-test";

beforeAll(async () => {
  process.env.SESSION_SECRET = "settings-route-test-secret-at-least-32-chars";
  process.env.USAGE_READ_TOKEN = READ_TOKEN;
  ({ GET, PUT } = await import("../route"));
  ({ createSessionToken, SESSION_COOKIE_NAME } = await import("@/lib/auth"));
});

beforeEach(() => {
  mocks.readAlertDeliveryConfig.mockReset();
  mocks.apnsConfigured.mockReset();
  mocks.loadApnsConfig.mockReset();
  mocks.count.mockReset();
  mocks.readAlertDeliveryConfig.mockReturnValue({
    minSeverity: "warning",
    reminderHours: 24,
    channels: [
      { kind: "email", from: "ops@example.com", to: "jay@example.com" },
    ],
  });
  mocks.apnsConfigured.mockReturnValue(false);
  mocks.loadApnsConfig.mockReturnValue({});
  mocks.count.mockResolvedValue(0);
});

function request(
  method: string,
  headers: Record<string, string> = {},
  body?: unknown
): NextRequest {
  return new NextRequest("https://usage.jays.services/api/settings", {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe("GET /api/settings", () => {
  it("accepts USAGE_READ_TOKEN and omits email addresses", async () => {
    const response = await GET(
      request("GET", { authorization: `Bearer ${READ_TOKEN}` })
    );
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.notifications.emailConfigured).toBe(true);
    expect(data.notifications.channels[0]).toEqual({ kind: "email" });
  });

  it("returns email addresses only for a dashboard session", async () => {
    const response = await GET(
      request("GET", {
        cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}`,
      })
    );
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.notifications.channels[0]).toEqual({
      kind: "email",
      from: "ops@example.com",
      to: "jay@example.com",
    });
  });
});

describe("PUT /api/settings", () => {
  it("rejects USAGE_READ_TOKEN (read token must not mutate alert routing)", async () => {
    const response = await PUT(
      request(
        "PUT",
        { authorization: `Bearer ${READ_TOKEN}` },
        { minSeverity: "critical" }
      )
    );
    expect(response.status).toBe(401);
    expect(process.env.ALERT_MIN_SEVERITY).not.toBe("critical");
  });

  it("accepts a dashboard session", async () => {
    const response = await PUT(
      request(
        "PUT",
        { cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}` },
        { minSeverity: "critical" }
      )
    );
    expect(response.status).toBe(200);
    expect(process.env.ALERT_MIN_SEVERITY).toBe("critical");
  });
});
