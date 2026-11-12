import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    apnsDeviceToken: {
      findMany: mocks.findMany,
      upsert: mocks.upsert,
    },
  },
}));

let GET: typeof import("../route").GET;
let POST: typeof import("../route").POST;
let createSessionToken: typeof import("@/lib/auth").createSessionToken;
let SESSION_COOKIE_NAME: typeof import("@/lib/auth").SESSION_COOKIE_NAME;

const READ_TOKEN = "read-token-apns-test";

beforeAll(async () => {
  process.env.SESSION_SECRET = "settings-route-test-secret-at-least-32-chars";
  process.env.USAGE_READ_TOKEN = READ_TOKEN;
  ({ GET, POST } = await import("../route"));
  ({ createSessionToken, SESSION_COOKIE_NAME } = await import("@/lib/auth"));
});

beforeEach(() => {
  mocks.findMany.mockReset();
  mocks.upsert.mockReset();
  mocks.findMany.mockResolvedValue([]);
  mocks.upsert.mockResolvedValue({
    id: "tok_1",
    updatedAt: new Date("2026-09-18T00:00:00.000Z"),
  });
});

function request(
  method: string,
  headers: Record<string, string> = {},
  body?: unknown
): NextRequest {
  return new NextRequest("https://usage.jays.services/api/apns/device-tokens", {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe("GET /api/apns/device-tokens", () => {
  it("accepts USAGE_READ_TOKEN (read access is unchanged)", async () => {
    const response = await GET(
      request("GET", { authorization: `Bearer ${READ_TOKEN}` })
    );
    expect(response.status).toBe(200);
  });

  it("accepts a dashboard session", async () => {
    const response = await GET(
      request("GET", { cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}` })
    );
    expect(response.status).toBe(200);
  });

  it("rejects an unauthenticated request", async () => {
    const response = await GET(request("GET"));
    expect(response.status).toBe(401);
  });

  it("previews a long token and passes through a short one unmasked", async () => {
    mocks.findMany.mockResolvedValue([
      {
        id: "tok_long",
        deviceToken: "a".repeat(64),
        deviceModel: null,
        osVersion: null,
        environment: "production",
        createdAt: new Date("2026-09-18T00:00:00.000Z"),
        updatedAt: new Date("2026-09-18T00:00:00.000Z"),
      },
      {
        id: "tok_short",
        deviceToken: "short",
        deviceModel: null,
        osVersion: null,
        environment: "production",
        createdAt: new Date("2026-09-18T00:00:00.000Z"),
        updatedAt: new Date("2026-09-18T00:00:00.000Z"),
      },
    ]);

    const response = await GET(
      request("GET", { cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}` })
    );
    const data = await response.json();

    expect(data.count).toBe(2);
    expect(data.tokens[0].deviceTokenPreview).toBe(`${"a".repeat(6)}...${"a".repeat(6)}`);
    expect(data.tokens[0].deviceToken).toBeUndefined();
    expect(data.tokens[1].deviceTokenPreview).toBe("short");
  });
});

describe("POST /api/apns/device-tokens", () => {
  it("rejects USAGE_READ_TOKEN (read token must not enroll a device)", async () => {
    const response = await POST(
      request(
        "POST",
        { authorization: `Bearer ${READ_TOKEN}` },
        { deviceToken: "a".repeat(64) }
      )
    );
    expect(response.status).toBe(401);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("accepts a dashboard session", async () => {
    const response = await POST(
      request(
        "POST",
        { cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}` },
        { deviceToken: "a".repeat(64) }
      )
    );
    expect(response.status).toBe(200);
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
  });

  it("rejects an unauthenticated request", async () => {
    const response = await POST(request("POST", {}, { deviceToken: "a".repeat(64) }));
    expect(response.status).toBe(401);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("rejects a missing deviceToken with 400", async () => {
    const response = await POST(
      request(
        "POST",
        { cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}` },
        { deviceModel: "iPhone" }
      )
    );
    expect(response.status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("returns 500 when the upsert throws", async () => {
    mocks.upsert.mockRejectedValueOnce(new Error("db unavailable"));

    const response = await POST(
      request(
        "POST",
        { cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}` },
        { deviceToken: "a".repeat(64) }
      )
    );
    const data = await response.json();

    expect(response.status).toBe(500);
    expect(data.error).toBe("db unavailable");
  });
});
