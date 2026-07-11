import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { decrypt, decryptJson, encrypt, encryptJson } from "@/lib/crypto";

const findUnique = vi.fn();
const update = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    provider: {
      findUnique: (args: unknown) => findUnique(args),
      update: (args: unknown) => update(args),
    },
    project: { findMany: vi.fn() },
  },
}));

describe("PUT /api/providers/:id credential operations", () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = "55".repeat(32);
    findUnique.mockReset().mockResolvedValue({
      id: "provider-1",
      config: { accountId: "acct" },
      secretConfig: encryptJson({
        apiSecret: "old-secret",
        managementKey: "keep-me",
      }),
    });
    update.mockReset().mockImplementation(async (args) => ({
      id: "provider-1",
      ...args.data,
    }));
  });

  afterEach(() => {
    delete process.env.ENCRYPTION_KEY;
  });

  it("clears the primary key and one secondary secret without exposing or clearing others", async () => {
    const { PUT } = await import("../route");
    const response = await PUT(
      new NextRequest("https://usage.jays.services/api/providers/provider-1", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          apiKeyAction: "clear",
          secretConfigOperations: [{ path: ["apiSecret"], action: "clear" }],
        }),
      }),
      { params: Promise.resolve({ id: "provider-1" }) }
    );

    expect(response.status).toBe(200);
    const data = update.mock.calls[0][0].data;
    expect(data.apiKey).toBeNull();
    expect(decryptJson(data.secretConfig)).toEqual({ managementKey: "keep-me" });
    expect(data.config).toEqual({ accountId: "acct" });
  });

  it("replaces the primary key while explicitly preserving an existing secondary value", async () => {
    const { PUT } = await import("../route");
    const response = await PUT(
      new NextRequest("https://usage.jays.services/api/providers/provider-1", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          apiKeyAction: "replace",
          apiKey: "next-primary-key",
          config: { accountId: "acct-2", apiSecret: "incoming-secret" },
          secretConfigOperations: [{ path: ["apiSecret"], action: "preserve" }],
        }),
      }),
      { params: Promise.resolve({ id: "provider-1" }) }
    );

    expect(response.status).toBe(200);
    const data = update.mock.calls[0][0].data;
    expect(decrypt(data.apiKey)).toBe("next-primary-key");
    expect(decryptJson(data.secretConfig)).toEqual({
      apiSecret: "old-secret",
      managementKey: "keep-me",
    });
    expect(data.config).toEqual({ accountId: "acct-2" });
  });
});
