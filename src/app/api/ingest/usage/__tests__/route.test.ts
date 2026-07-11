import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { MAX_USAGE_TELEMETRY_BODY_BYTES } from "@/lib/usage-telemetry";

const persistExternalUsageEvents = vi.fn();
const syncStatusToUsageSnapshot = vi.fn();

vi.mock("@/lib/external-usage-events", () => ({
  ExternalUsageIdempotencyCollisionError: class extends Error {},
  persistExternalUsageEvents: (events: unknown) => persistExternalUsageEvents(events),
  syncStatusToUsageSnapshot: (events: unknown) => syncStatusToUsageSnapshot(events),
}));

vi.mock("@/lib/project-resolver", () => ({
  resolveProjectIdsByName: vi.fn().mockResolvedValue(new Map()),
}));

const TOKEN = "test-ingest-token";

function headers(extra: Record<string, string> = {}) {
  return {
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
    ...extra,
  };
}

describe("POST /api/ingest/usage body limits", () => {
  beforeEach(() => {
    process.env.USAGE_INGEST_TOKEN = TOKEN;
    persistExternalUsageEvents.mockReset().mockResolvedValue({
      attempted: 1,
      persisted: 1,
      skippedPrunedDuplicates: 0,
      newEvents: [],
    });
    syncStatusToUsageSnapshot.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete process.env.USAGE_INGEST_TOKEN;
  });

  it("rejects an oversized declared Content-Length before JSON decoding", async () => {
    const { POST } = await import("../route");
    const request = new NextRequest("https://usage.jays.services/api/ingest/usage", {
      method: "POST",
      headers: headers({
        "content-length": String(MAX_USAGE_TELEMETRY_BODY_BYTES + 1),
      }),
      body: "{}",
    });

    const response = await POST(request);
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("exceeds"),
    });
    expect(persistExternalUsageEvents).not.toHaveBeenCalled();
  });

  it("rejects an oversized chunked stream before JSON decoding", async () => {
    const { POST } = await import("../route");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_USAGE_TELEMETRY_BODY_BYTES));
        controller.enqueue(new Uint8Array([0x7b]));
        controller.close();
      },
    });
    const request = new NextRequest(
      new Request("https://usage.jays.services/api/ingest/usage", {
        method: "POST",
        headers: headers(),
        body: stream,
        duplex: "half",
      } as RequestInit & { duplex: "half" })
    );

    const response = await POST(request);
    expect(response.status).toBe(413);
    expect(persistExternalUsageEvents).not.toHaveBeenCalled();
  });

  it("preserves valid ingest behavior below the limit", async () => {
    const { POST } = await import("../route");
    const request = new NextRequest("https://usage.jays.services/api/ingest/usage", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        sourceApp: "socratic-trade",
        provider: "openai",
        occurredAt: "2026-07-11T12:00:00.000Z",
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(202);
    expect(persistExternalUsageEvents).toHaveBeenCalledTimes(1);
  });
});
