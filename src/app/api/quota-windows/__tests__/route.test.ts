import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  loadLatestQuotaWindowEvents: vi.fn(),
}));

vi.mock("@/lib/quota-events-loader", () => ({
  loadLatestQuotaWindowEvents: mocks.loadLatestQuotaWindowEvents,
}));

let GET: typeof import("../route").GET;
let createSessionToken: typeof import("@/lib/auth").createSessionToken;
let SESSION_COOKIE_NAME: typeof import("@/lib/auth").SESSION_COOKIE_NAME;

const READ_TOKEN = "native-read-token";

beforeAll(async () => {
  process.env.SESSION_SECRET = "quota-windows-route-test-secret";
  ({ GET } = await import("../route"));
  ({ createSessionToken, SESSION_COOKIE_NAME } = await import("@/lib/auth"));
});

beforeEach(() => {
  delete process.env.USAGE_READ_TOKEN;
  delete process.env.USAGE_INGEST_TOKEN;
  delete process.env.USAGE_READ_TOKEN_ALLOW_INGEST_FALLBACK;
  mocks.loadLatestQuotaWindowEvents.mockReset();
  mocks.loadLatestQuotaWindowEvents.mockResolvedValue([]);
});

function request(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("https://usage.jays.services/api/quota-windows", {
    method: "GET",
    headers,
  });
}

describe("GET /api/quota-windows", () => {
  it("503s when no read token is configured", async () => {
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(mocks.loadLatestQuotaWindowEvents).not.toHaveBeenCalled();
  });

  it("accepts the dedicated read bearer token", async () => {
    process.env.USAGE_READ_TOKEN = READ_TOKEN;
    mocks.loadLatestQuotaWindowEvents.mockResolvedValue([
      {
        provider: "google-antigravity",
        label: "Claude Opus 4.6 (Thinking)",
        credits: 0,
        limit: 100,
        occurredAt: new Date("2026-09-04T04:20:02.182Z"),
        metadata: { modelId: "claude-opus-4-6-thinking", isExhausted: true },
      },
    ]);

    const response = await GET(request({ authorization: `Bearer ${READ_TOKEN}` }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.skipModelTypes).toEqual([
      { instanceId: "antigravity", model: "claude-opus-4-6-thinking" },
    ]);
    expect(response.headers.get("x-api-version")).toBe("1");
  });

  it("accepts a dashboard session", async () => {
    const response = await GET(
      request({
        cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}`,
      })
    );
    expect(response.status).toBe(200);
    expect(mocks.loadLatestQuotaWindowEvents).toHaveBeenCalledOnce();
  });

  it("merges the PROVIDER_MANIFEST_JSON knob into providerGroups (additive)", async () => {
    process.env.USAGE_READ_TOKEN = READ_TOKEN;
    process.env.PROVIDER_MANIFEST_JSON = JSON.stringify({
      version: "1",
      providers: [
        {
          key: "anthropic",
          label: "Claude (Renamed)",
          sortOrder: 5,
          iconHint: "anthropic-v2",
          aliases: ["claude-suite"],
          expected: true,
          terms: { defaultWindowLabel: "5h" },
        },
        {
          key: "muse",
          label: "Muse",
          sortOrder: 100,
          iconHint: "muse",
          expected: true,
          terms: { defaultWindowLabel: "monthly" },
        },
      ],
    });
    mocks.loadLatestQuotaWindowEvents.mockResolvedValue([
      {
        provider: "claude-suite",
        label: "suite window",
        credits: 50,
        limit: 100,
        occurredAt: new Date("2026-09-04T04:20:02.182Z"),
        metadata: { bucketId: "claude-suite:5h" },
      },
    ]);
    try {
      const response = await GET(request({ authorization: `Bearer ${READ_TOKEN}` }));
      expect(response.status).toBe(200);
      const body = await response.json();
      // Alias normalization is visible on windows[].providerKey ...
      expect(body.windows[0].providerKey).toBe("anthropic");
      expect(body.windows[0].providerLabel).toBe("Claude (Renamed)");
      // ... and providerGroups carry the manifest display fields.
      const anthropic = body.providerGroups.find(
        (g: { provider: string }) => g.provider === "anthropic"
      );
      expect(anthropic.sortOrder).toBe(5);
      expect(anthropic.iconHint).toBe("anthropic-v2");
      expect(anthropic.terms).toEqual({ defaultWindowLabel: "5h" });
      expect(anthropic.windows).toHaveLength(1);
      // A brand-new manifest provider appears with an empty row.
      const muse = body.providerGroups.find(
        (g: { provider: string }) => g.provider === "muse"
      );
      expect(muse.providerLabel).toBe("Muse");
      expect(muse.expected).toBe(true);
      expect(muse.windows).toEqual([]);
    } finally {
      delete process.env.PROVIDER_MANIFEST_JSON;
    }
  });
});
