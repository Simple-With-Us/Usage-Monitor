import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  deleteMany: vi.fn(),
  findMany: vi.fn(),
  createAlert: vi.fn(),
  findAlert: vi.fn(),
  findDevice: vi.fn(),
  createDelivery: vi.fn(),
  updateDeliveries: vi.fn(),
  updateDevice: vi.fn(),
  send: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    codeCapsPushAlert: { deleteMany: mocks.deleteMany, create: mocks.createAlert, findUnique: mocks.findAlert },
    codeCapsPushDevice: { findMany: mocks.findMany, findUnique: mocks.findDevice, updateMany: mocks.updateDevice },
    codeCapsPushAlertDelivery: { create: mocks.createDelivery, updateMany: mocks.updateDeliveries, findFirst: vi.fn().mockResolvedValue(null) },
  },
}));

vi.mock("@/lib/codecaps-push", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/codecaps-push")>();
  return {
    ...actual,
    loadCodeCapsApnsConfig: () => ({
      keyId: "K1",
      teamId: "T1",
      bundleId: "com.simplewithus.codecaps.ios",
      privateKeyPem: "fake-test-key",
    }),
  };
});

vi.mock("@/lib/apns", () => ({ sendApnsPush: mocks.send }));

let POST: typeof import("../route").POST;
const INGEST_TOKEN = "codecaps-ingest-test-token";
const OCCURRED_AT = new Date(Date.now() - 30_000).toISOString();
const preferences = {
  options: Object.fromEntries(["anomaly", "runaway", "vendorReset", "quotaReset", "quotaExhaustion"].map((kind) => [kind, {
    enabled: true,
    notification: true,
    popup: false,
    sound: "Glass",
  }])) ,
};

beforeAll(async () => {
  process.env.USAGE_INGEST_TOKEN = INGEST_TOKEN;
  delete process.env.USAGE_INGEST_PRODUCER_TOKENS;
  ({ POST } = await import("../route"));
});

beforeEach(() => {
  mocks.deleteMany.mockReset().mockResolvedValue({ count: 0 });
  mocks.findMany.mockReset().mockResolvedValue([{
    id: "device-1",
    generation: BigInt(1),
    deviceToken: "a".repeat(64),
    environment: "sandbox",
    preferences,
  }]);
  mocks.createAlert.mockReset().mockResolvedValue({ id: "alert-1" });
  mocks.findAlert.mockReset().mockResolvedValue({
    id: "runaway|openai|5h|first-seen",
    kind: "runaway",
    providerKey: "openai",
    providerTitle: "Codex",
    windowLabel: "5h",
    summary: "Usage is unusually high.",
    occurredAt: new Date(OCCURRED_AT),
  });
  mocks.findDevice.mockReset().mockResolvedValue({
    generation: BigInt(1),
    isActive: true,
    deviceToken: "a".repeat(64),
    environment: "sandbox",
    preferences,
  });
  mocks.createDelivery.mockReset().mockResolvedValue({ id: "delivery-1" });
  mocks.updateDeliveries.mockReset().mockResolvedValue({ count: 1 });
  mocks.updateDevice.mockReset().mockResolvedValue({ count: 1 });
  mocks.send.mockReset().mockResolvedValue({ ok: true, disposition: "delivered" });
  process.env.USAGE_INGEST_TOKEN = INGEST_TOKEN;
  delete process.env.USAGE_INGEST_PRODUCER_TOKENS;
});

function request(alerts: unknown[], token = INGEST_TOKEN): NextRequest {
  return new NextRequest("https://usage.jays.services/api/codecaps/push/alerts", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ alerts }),
  });
}

function alert(overrides: Record<string, unknown> = {}) {
  return {
    id: "runaway|openai|5h|first-seen",
    kind: "runaway",
    providerKey: "openai",
    providerTitle: "Codex",
    windowLabel: "5h",
    summary: "Usage is unusually high.",
    occurredAt: OCCURRED_AT,
    ...overrides,
  };
}

describe("POST /api/codecaps/push/alerts", () => {
  it("persists, deduplicates by occurrence ID, and sends the selected CodeCaps sound", async () => {
    const response = await POST(request([alert()]));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      received: 1,
      persisted: 1,
      delivered: 1,
      failed: 0,
    });
    expect(mocks.createAlert).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({
      title: "Codex · 5h",
      sound: "alarm-glass.wav",
      interruptionLevel: "active",
    }), expect.objectContaining({ config: expect.objectContaining({
      bundleId: "com.simplewithus.codecaps.ios",
    }) }));
  });

  it("retries an existing pending receipt for a duplicate occurrence", async () => {
    mocks.createAlert.mockRejectedValueOnce({ code: "P2002" });
    mocks.createDelivery.mockRejectedValueOnce({ code: "P2002" });
    const response = await POST(request([alert()]));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ duplicates: 1, delivered: 1 });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.updateDeliveries).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ outcome: "sending" }),
    }));
  });

  it("returns a retryable status and allows a later post to retry the receipt", async () => {
    mocks.send.mockResolvedValueOnce({ ok: false, disposition: "retryable" });
    const first = await POST(request([alert()]));
    expect(first.status).toBe(503);
    expect(await first.json()).toMatchObject({ retryableFailures: 1, failed: 1 });

    mocks.createAlert.mockRejectedValueOnce({ code: "P2002" });
    mocks.createDelivery.mockRejectedValueOnce({ code: "P2002" });
    const second = await POST(request([alert()]));
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ duplicates: 1, delivered: 1 });
    expect(mocks.send).toHaveBeenCalledTimes(2);
  });

  it("rejects stale alerts before persisting them", async () => {
    const response = await POST(request([alert({
      occurredAt: new Date(Date.now() - 16 * 60_000).toISOString(),
    })]));
    expect(response.status).toBe(422);
    expect(mocks.createAlert).not.toHaveBeenCalled();
  });

  it("requires a scoped token to name CodeCaps when scoped producer tokens are configured", async () => {
    process.env.USAGE_INGEST_PRODUCER_TOKENS = `other:${INGEST_TOKEN}`;
    const response = await POST(request([alert()]));
    expect(response.status).toBe(403);
    expect(mocks.createAlert).not.toHaveBeenCalled();
  });
});
