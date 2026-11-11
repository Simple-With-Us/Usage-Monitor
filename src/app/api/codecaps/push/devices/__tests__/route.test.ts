import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  updateMany: vi.fn(),
  findUnique: vi.fn(),
  findUniqueOrThrow: vi.fn(),
  loadApnsConfig: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback({
      codeCapsPushDevice: {
        create: mocks.create,
        updateMany: mocks.updateMany,
        findUnique: mocks.findUnique,
        findUniqueOrThrow: mocks.findUniqueOrThrow,
      },
    })),
  },
}));

vi.mock("@/lib/codecaps-push", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/codecaps-push")>();
  return { ...actual, loadCodeCapsApnsConfig: mocks.loadApnsConfig };
});

let POST: typeof import("../route").POST;
let DELETE: typeof import("../route").DELETE;
const REGISTRATION_TOKEN = "codecaps-registration-test-token";

beforeAll(async () => {
  process.env.CODECAPS_PUSH_REGISTRATION_TOKEN = REGISTRATION_TOKEN;
  ({ POST, DELETE } = await import("../route"));
});

beforeEach(() => {
  mocks.loadApnsConfig.mockReset().mockReturnValue({ keyId: "K", teamId: "T", bundleId: "com.simplewithus.codecaps.ios", privateKeyPem: "test" });
  mocks.create.mockReset();
  mocks.updateMany.mockReset();
  mocks.findUnique.mockReset().mockResolvedValue(null);
  mocks.findUniqueOrThrow.mockReset().mockResolvedValue({
    id: "device-1",
    installationId: "6a875ea5-28c8-4b80-8d24-2c383da87a65",
    generation: BigInt(1),
    isActive: true,
    updatedAt: new Date("2026-10-20T00:00:00.000Z"),
  });
  mocks.create.mockResolvedValue({
    id: "device-1",
    installationId: "6a875ea5-28c8-4b80-8d24-2c383da87a65",
    generation: BigInt(1),
    isActive: true,
    updatedAt: new Date("2026-10-20T00:00:00.000Z"),
  });
  mocks.updateMany.mockResolvedValue({ count: 1 });
});

function request(method: string, token: string, body: unknown): NextRequest {
  return new NextRequest("https://usage.jays.services/api/codecaps/push/devices", {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const registration = {
  installationId: "6a875ea5-28c8-4b80-8d24-2c383da87a65",
  generation: 1,
  deviceToken: "a".repeat(64),
  environment: "production",
  preferences: {
    options: Object.fromEntries(["anomaly", "runaway", "vendorReset", "quotaReset", "quotaExhaustion"].map((kind) => [kind, {
      enabled: true,
      notification: true,
      popup: true,
      sound: "system.default",
    }])) ,
  },
};

describe("CodeCaps push device routes", () => {
  it("registers a device with the dedicated bearer token", async () => {
    const response = await POST(request("POST", REGISTRATION_TOKEN, registration));
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.device.deviceToken).toBeUndefined();
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        installationId: registration.installationId,
        OR: [{ generation: { lt: BigInt(1) } }, { generation: BigInt(1), isActive: true }],
      },
    }));
  });

  it("rejects the read token before database writes", async () => {
    const response = await POST(request("POST", "read-token", registration));
    expect(response.status).toBe(401);
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("requires configured APNs credentials before storing an enrollment", async () => {
    mocks.loadApnsConfig.mockReturnValueOnce(null);
    const response = await POST(request("POST", REGISTRATION_TOKEN, registration));
    expect(response.status).toBe(503);
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("deactivates the installation on DELETE", async () => {
    const response = await DELETE(request("DELETE", REGISTRATION_TOKEN, {
      installationId: registration.installationId,
      generation: 2,
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, removed: true });
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        installationId: registration.installationId,
        OR: [{ generation: { lt: BigInt(2) } }, { generation: BigInt(2), isActive: true }],
      },
      data: expect.objectContaining({ isActive: false, deviceToken: null }),
    }));
  });

  it("does not let an older POST replace a newer generation", async () => {
    mocks.updateMany.mockResolvedValueOnce({ count: 0 });
    mocks.findUnique.mockResolvedValueOnce({
      id: "device-1",
      installationId: registration.installationId,
      generation: BigInt(4),
      isActive: false,
      updatedAt: new Date("2026-10-20T00:00:00.000Z"),
    });
    const response = await POST(request("POST", REGISTRATION_TOKEN, {
      ...registration,
      generation: 3,
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, applied: false, device: { generation: 4 } });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("creates an inactive tombstone when DELETE arrives before the first POST", async () => {
    mocks.updateMany.mockResolvedValueOnce({ count: 0 });
    mocks.findUnique.mockResolvedValueOnce(null);
    const response = await DELETE(request("DELETE", REGISTRATION_TOKEN, {
      installationId: registration.installationId,
      generation: 2,
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, removed: true, generation: 2 });
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        installationId: registration.installationId,
        generation: BigInt(2),
        isActive: false,
        deviceToken: null,
      }),
    }));
  });

  it("does not allow a same-generation POST to resurrect a tombstone", async () => {
    mocks.updateMany.mockResolvedValueOnce({ count: 0 });
    mocks.findUnique.mockResolvedValueOnce({
      id: "device-1",
      installationId: registration.installationId,
      generation: BigInt(2),
      isActive: false,
      updatedAt: new Date("2026-10-20T00:00:00.000Z"),
    });
    const response = await POST(request("POST", REGISTRATION_TOKEN, { ...registration, generation: 2 }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ applied: false, device: { isActive: false, generation: 2 } });
  });
});
