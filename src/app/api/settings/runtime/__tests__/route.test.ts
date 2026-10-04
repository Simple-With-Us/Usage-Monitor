import { beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

let GET: typeof import("../route").GET;
let PUT: typeof import("../route").PUT;
let POST: typeof import("../route").POST;
let createSessionToken: typeof import("@/lib/auth").createSessionToken;
let SESSION_COOKIE_NAME: typeof import("@/lib/auth").SESSION_COOKIE_NAME;

beforeAll(async () => {
process.env.SESSION_SECRET = "test-session-secret-value-32-chars!!";
  ({ GET, PUT, POST } = await import("../route"));
  ({ createSessionToken, SESSION_COOKIE_NAME } = await import("@/lib/auth"));
  // No Infisical creds in CI: the settings service stays in env-fallback mode.
  const { appSettings } = await import("@/lib/app-settings");
  await appSettings.init();
});

function request(
  method: string,
  headers: Record<string, string> = {},
  body?: unknown
): NextRequest {
  return new NextRequest("https://usage.jays.services/api/settings/runtime", {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function sessionHeaders(): Record<string, string> {
  return { cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}` };
}

describe("GET /api/settings/runtime", () => {
  it("returns 403 without a dashboard session", async () => {
    const response = await GET(request("GET"));
    expect(response.status).toBe(403);
  });

  it("returns knob metadata (no secret values) for a dashboard session", async () => {
    const response = await GET(request("GET", sessionHeaders()));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.ok).toBe(true);
    expect(data.mode).toBe("env");
    const keys = data.settings.map((s: { key: string }) => s.key);
    expect(keys).toContain("ALERT_MIN_SEVERITY");
    expect(keys).toContain("ADAPTER_HTTP_TIMEOUT_MS");
    // No secret material is ever exposed here.
    expect(keys).not.toContain("USAGE_INGEST_TOKEN");
    expect(keys).not.toContain("ENCRYPTION_KEY");
    const severity = data.settings.find(
      (s: { key: string }) => s.key === "ALERT_MIN_SEVERITY"
    );
    expect(severity.type).toBe("string");
    expect(severity.defaultValue).toBe("warning");
    expect(typeof severity.value).toBe("string");
  });
});

describe("PUT /api/settings/runtime", () => {
  it("returns 403 without a dashboard session", async () => {
    const response = await PUT(
      request("PUT", {}, { key: "ALERT_MIN_SEVERITY", value: "critical" })
    );
    expect(response.status).toBe(403);
  });

  it("returns 400 for an unknown key", async () => {
    const response = await PUT(
      request("PUT", sessionHeaders(), { key: "USAGE_INGEST_TOKEN", value: "x" })
    );
    expect(response.status).toBe(400);
  });

  it("returns 400 for an invalid value", async () => {
    const response = await PUT(
      request("PUT", sessionHeaders(), { key: "ALERT_MIN_SEVERITY", value: "panic" })
    );
    expect(response.status).toBe(400);
    expect(process.env.ALERT_MIN_SEVERITY).not.toBe("panic");
  });

  it("write-through saves a valid knob (env-fallback mode)", async () => {
    const response = await PUT(
      request("PUT", sessionHeaders(), { key: "ALERT_MIN_SEVERITY", value: "critical" })
    );
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.ok).toBe(true);
    expect(data.key).toBe("ALERT_MIN_SEVERITY");
    expect(data.value).toBe("critical");
    expect(process.env.ALERT_MIN_SEVERITY).toBe("critical");
    delete process.env.ALERT_MIN_SEVERITY;
  });
});

describe("POST /api/settings/runtime", () => {
  it("returns 403 without a dashboard session", async () => {
    const response = await POST(request("POST"));
    expect(response.status).toBe(403);
  });

  it("refreshes for a dashboard session", async () => {
    const response = await POST(request("POST", sessionHeaders()));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.ok).toBe(true);
  });
});
