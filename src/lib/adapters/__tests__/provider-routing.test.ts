import type { Prisma, Provider } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encrypt } from "@/lib/crypto";

const adapterMocks = vi.hoisted(() => ({
  custom: vi.fn(),
  googleAi: vi.fn(),
  openai: vi.fn(),
  stripe: vi.fn(),
  cloudflare: vi.fn(),
}));

vi.mock("../custom", () => ({ fetchUsage: adapterMocks.custom }));
vi.mock("../google-ai", () => ({ fetchUsage: adapterMocks.googleAi }));
vi.mock("../openai", () => ({ fetchUsage: adapterMocks.openai }));
vi.mock("../stripe", () => ({ fetchUsage: adapterMocks.stripe }));
vi.mock("../cloudflare", () => ({ fetchUsage: adapterMocks.cloudflare }));

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
    alertConfigGeneration: 0,
    credits: 0,
    refreshIntervalMin: 60,
    groupId: null,
    billingAccountIdentity: null,
    label: null,
    budgetControlsEnabled: false,
    budgetBreachState: "ok",
    budgetBreachStreak: 0,
    budgetControlPeriodStart: null,
    budgetPausedAt: null,
    budgetPauseReason: null,
    budgetPauseThresholdUsd: null,
    budgetPauseObservedSpendUsd: null,
    budgetControlLastActionAt: null,
    keyDisableRecommended: false,
    createdAt: new Date("2026-07-11T00:00:00.000Z"),
  };
}

describe("provider adapter credential routing", () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = "42".repeat(32);
    adapterMocks.custom.mockResolvedValue(EMPTY_RESULT);
    adapterMocks.googleAi.mockResolvedValue(EMPTY_RESULT);
    adapterMocks.openai.mockResolvedValue(EMPTY_RESULT);
    adapterMocks.stripe.mockResolvedValue(EMPTY_RESULT);
    adapterMocks.cloudflare.mockResolvedValue(EMPTY_RESULT);
  });

  afterEach(() => {
    delete process.env.ENCRYPTION_KEY;
    adapterMocks.custom.mockReset();
    adapterMocks.googleAi.mockReset();
    adapterMocks.openai.mockReset();
    adapterMocks.stripe.mockReset();
    adapterMocks.cloudflare.mockReset();
  });

  it.each([
    ["openai", adapterMocks.openai],
    ["stripe", adapterMocks.stripe],
    ["gemini", adapterMocks.googleAi],
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

  it.each([
    "cloudflare",
    "cloudflare-usage-jays",
    "cloudflare-socratic",
    "cloudflare-congress",
    "cloudflare-jay-old",
  ])("routes %s to the Cloudflare adapter", async (name) => {
    await fetchProviderUsage(
      provider(name, "builtin", { accountId: "acct", authMode: "api_token" })
    );
    expect(adapterMocks.cloudflare).toHaveBeenCalledOnce();
    expect(adapterMocks.custom).not.toHaveBeenCalled();
  });

  it.each([
    "gemini",
    "gemini-api",
    "gemini.api",
    "generative-language",
    "google-ai-studio",
    "Google Gemini",
    "googlegemini",
  ])(
    "routes the historical built-in Gemini alias %s to the Google adapter",
    async (name) => {
      await fetchProviderUsage(provider(name, "builtin"));

      expect(adapterMocks.googleAi).toHaveBeenCalledWith(
        "collision-secret",
        {},
        {
          apiKeyConfigured: true,
          apiKeyReadable: true,
          secretConfigConfigured: false,
          secretConfigReadable: true,
        }
      );
      expect(adapterMocks.custom).not.toHaveBeenCalled();
    }
  );

  it("still routes readable Gemini billing when the API key ciphertext is unreadable", async () => {
    const row = provider("google-ai", "builtin", {
      billingDataset: "billing-project.billing_export",
      serviceAccountJson: "legacy-readable-service-account",
    });
    row.apiKey = "corrupt-api-key-ciphertext";

    await fetchProviderUsage(row);

    expect(adapterMocks.googleAi).toHaveBeenCalledWith(
      "",
      {
        billingDataset: "billing-project.billing_export",
        serviceAccountJson: "legacy-readable-service-account",
      },
      {
        apiKeyConfigured: true,
        apiKeyReadable: false,
        secretConfigConfigured: false,
        secretConfigReadable: true,
      }
    );
  });

  it("still routes readable Gemini key validation when secret config is unreadable", async () => {
    const row = provider("gemini", "builtin", {
      billingDataset: "billing-project.billing_export",
    });
    row.secretConfig = "corrupt-secret-config-ciphertext";

    await fetchProviderUsage(row);

    expect(adapterMocks.googleAi).toHaveBeenCalledWith(
      "collision-secret",
      { billingDataset: "billing-project.billing_export" },
      {
        apiKeyConfigured: true,
        apiKeyReadable: true,
        secretConfigConfigured: true,
        secretConfigReadable: false,
      }
    );
  });

  it("fails generic/manual providers closed before invoking any adapter", async () => {
    await expect(
      fetchProviderUsage(provider("openai", "generic"))
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });

    expect(adapterMocks.custom).not.toHaveBeenCalled();
    expect(adapterMocks.openai).not.toHaveBeenCalled();
  });

  it("treats explicit push providers as intentionally non-pollable", async () => {
    await expect(
      fetchProviderUsage(provider("anthropic", "push"))
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });

    expect(adapterMocks.custom).not.toHaveBeenCalled();
    expect(adapterMocks.openai).not.toHaveBeenCalled();
  });

  it.each(["tradier", "intrinio", "alpaca", "robinhood", "vercel", "firecrawl"])(
    "refuses to poll dormant or retired built-in %s",
    async (name) => {
      await expect(fetchProviderUsage(provider(name, "builtin"))).rejects.toMatchObject({
        code: "UNSUPPORTED",
      });
      expect(adapterMocks.custom).not.toHaveBeenCalled();
      expect(adapterMocks.openai).not.toHaveBeenCalled();
    }
  );

  it("does not let a custom type bypass a retired canonical name", async () => {
    await expect(fetchProviderUsage(provider("Vercel", "custom"))).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    expect(adapterMocks.custom).not.toHaveBeenCalled();
  });

  it("does not fall back to custom for an unknown built-in slug", async () => {
    await expect(
      fetchProviderUsage(provider("future-provider", "builtin", {
        endpoint: "https://attacker.example/collect",
      }))
    ).rejects.toMatchObject({ code: "CONFIGURATION_ERROR" });

    expect(adapterMocks.custom).not.toHaveBeenCalled();
  });

  it("reports an unknown provider type as a configuration error", async () => {
    await expect(
      fetchProviderUsage(provider("openai", "mystery"))
    ).rejects.toMatchObject({ code: "CONFIGURATION_ERROR" });

    expect(adapterMocks.custom).not.toHaveBeenCalled();
    expect(adapterMocks.openai).not.toHaveBeenCalled();
  });
});
