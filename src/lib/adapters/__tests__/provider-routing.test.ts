import type { Prisma, Provider } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encrypt } from "@/lib/crypto";

const adapterMocks = vi.hoisted(() => ({
  custom: vi.fn(),
  openai: vi.fn(),
  stripe: vi.fn(),
}));

vi.mock("../custom", () => ({ fetchUsage: adapterMocks.custom }));
vi.mock("../openai", () => ({ fetchUsage: adapterMocks.openai }));
vi.mock("../stripe", () => ({ fetchUsage: adapterMocks.stripe }));

import { fetchProviderUsage } from "../index";

const EMPTY_RESULT = {
  balance: null,
  totalCost: null,
  totalRequests: null,
  credits: null,
  rawData: null,
};

function provider(
  name: string,
  type: string,
  config: Prisma.JsonObject = {}
): Provider {
  return {
    id: `provider-${type}-${name}`,
    name,
    displayName: name,
    type,
    category: null,
    apiKey: encrypt("collision-secret"),
    config,
    secretConfig: null,
    isActive: true,
    credits: 0,
    refreshIntervalMin: 60,
    groupId: null,
    label: null,
    createdAt: new Date("2026-07-11T00:00:00.000Z"),
  };
}

describe("provider adapter credential routing", () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = "42".repeat(32);
    adapterMocks.custom.mockResolvedValue(EMPTY_RESULT);
    adapterMocks.openai.mockResolvedValue(EMPTY_RESULT);
    adapterMocks.stripe.mockResolvedValue(EMPTY_RESULT);
  });

  afterEach(() => {
    delete process.env.ENCRYPTION_KEY;
    adapterMocks.custom.mockReset();
    adapterMocks.openai.mockReset();
    adapterMocks.stripe.mockReset();
  });

  it.each([
    ["openai", adapterMocks.openai],
    ["stripe", adapterMocks.stripe],
  ])(
    "routes a custom provider named %s only to its custom endpoint adapter",
    async (name, builtInMock) => {
      const config = {
        endpoint: "https://usage-collector.example/account",
        authType: "bearer",
        costPath: "$.cost",
      };

      await fetchProviderUsage(provider(name, "custom", config));

      expect(adapterMocks.custom).toHaveBeenCalledOnce();
      expect(adapterMocks.custom).toHaveBeenCalledWith(
        "collision-secret",
        config
      );
      expect(builtInMock).not.toHaveBeenCalled();
    }
  );

  it("still routes a built-in provider to its matching built-in adapter", async () => {
    await fetchProviderUsage(provider("openai", "builtin"));

    expect(adapterMocks.openai).toHaveBeenCalledWith("collision-secret", {});
    expect(adapterMocks.custom).not.toHaveBeenCalled();
  });

  it("fails generic/manual providers closed before invoking any adapter", async () => {
    await expect(
      fetchProviderUsage(provider("openai", "generic"))
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });

    expect(adapterMocks.custom).not.toHaveBeenCalled();
    expect(adapterMocks.openai).not.toHaveBeenCalled();
  });

  it("does not fall back to custom for an unknown built-in slug", async () => {
    await expect(
      fetchProviderUsage(provider("future-provider", "builtin", {
        endpoint: "https://attacker.example/collect",
      }))
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });

    expect(adapterMocks.custom).not.toHaveBeenCalled();
  });
});
