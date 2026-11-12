import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    provider: {
      findMany: vi.fn(async () => []),
    },
  },
}));

vi.mock("@/lib/crypto", () => ({
  decrypt: vi.fn((v: string) => v),
}));

vi.mock("@/lib/adapters/openrouter", () => ({
  fetchUsage: vi.fn(),
}));

import { fetchUsage } from "@/lib/adapters/openrouter";
import {
  __resetOpenRouterCreditProbeCache,
  probeOpenRouterCredits,
  toPublicOpenRouterCreditProbe,
} from "@/lib/openrouter-credit-probe";

const fetchUsageMock = vi.mocked(fetchUsage);

describe("openrouter-credit-probe", () => {
  beforeEach(() => {
    __resetOpenRouterCreditProbeCache();
    delete process.env.OPENROUTER_MANAGEMENT_KEY;
    delete process.env.OPENROUTER_ADMIN_KEY;
    delete process.env.OPENROUTER_LOW_CREDIT_USD;
    delete process.env.OPENROUTER_KEY_LIMIT_LOW_USD;
    delete process.env.OPENROUTER_CREDIT_CHECK_INTERVAL_MS;
    fetchUsageMock.mockReset();
  });

  it("returns configured=false when no key is available (no alert)", async () => {
    const r = await probeOpenRouterCredits(1000);
    expect(r.configured).toBe(false);
    expect(r.ok).toBe(true);
    expect(fetchUsageMock).not.toHaveBeenCalled();
  });

  it("ok=true for healthy management account + keys", async () => {
    process.env.OPENROUTER_ADMIN_KEY = "sk-or-mgmt";
    fetchUsageMock.mockResolvedValue({
      balance: 50,
      credits: 100,
      totalCost: null,
      totalRequests: null,
      rawData: {
        capabilities: { managementKeyConfirmed: true },
        keys: [
          { label: "st", disabled: false, limitUsd: 40, limitRemainingUsd: 20 },
          { label: "ct", disabled: false, limitUsd: 40, limitRemainingUsd: 15 },
        ],
      },
    });
    const r = await probeOpenRouterCredits(1000);
    expect(r.ok).toBe(true);
    expect(r.configured).toBe(true);
    expect(r.source).toBe("management");
    expect(r.keysChecked).toBe(true);
    expect(r.keysWithLimit).toBe(2);
    expect(r.remainingUsd).toBe(50);
    expect(r.reasons).toEqual([]);
  });

  it("ok=false when account remaining is below threshold", async () => {
    process.env.OPENROUTER_ADMIN_KEY = "sk-or-mgmt";
    process.env.OPENROUTER_LOW_CREDIT_USD = "3";
    fetchUsageMock.mockResolvedValue({
      balance: 1.5,
      credits: 100,
      totalCost: null,
      totalRequests: null,
      rawData: {
        capabilities: { managementKeyConfirmed: true },
        keys: [],
      },
    });
    const r = await probeOpenRouterCredits(1000);
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain("account_low");
  });

  it("ok=false when any enabled key has limit_remaining <= 0", async () => {
    process.env.OPENROUTER_MANAGEMENT_KEY = "sk-or-mgmt";
    fetchUsageMock.mockResolvedValue({
      balance: 80,
      credits: 100,
      totalCost: null,
      totalRequests: null,
      rawData: {
        capabilities: { managementKeyConfirmed: true },
        keys: [
          { label: "st", disabled: false, limitUsd: 50, limitRemainingUsd: 0 },
          { label: "old", disabled: true, limitUsd: 10, limitRemainingUsd: 0 },
        ],
      },
    });
    const r = await probeOpenRouterCredits(1000);
    expect(r.ok).toBe(false);
    expect(r.keysLimitReached).toBe(1);
    expect(r.reasons).toContain("key_limit_reached");
  });

  it("ignores keys labeled onboarding or test when checking limits", async () => {
    process.env.OPENROUTER_MANAGEMENT_KEY = "sk-or-mgmt";
    fetchUsageMock.mockResolvedValue({
      balance: 80,
      credits: 100,
      totalCost: null,
      totalRequests: null,
      rawData: {
        capabilities: { managementKeyConfirmed: true },
        keys: [
          { label: "onboarding-key", disabled: false, limitUsd: 5, limitRemainingUsd: 0 },
          { label: "test-run", disabled: false, limitUsd: 10, limitRemainingUsd: 0 },
          { label: "st-production", disabled: false, limitUsd: 100, limitRemainingUsd: 50 },
        ],
      },
    });
    const r = await probeOpenRouterCredits(1000);
    expect(r.ok).toBe(true);
    expect(r.keysLimitReached).toBe(0);
    expect(r.reasons).toEqual([]);
  });

  it("ok=false when any enabled key is low on its limit", async () => {
    process.env.OPENROUTER_ADMIN_KEY = "sk-or-mgmt";
    process.env.OPENROUTER_KEY_LIMIT_LOW_USD = "5";
    fetchUsageMock.mockResolvedValue({
      balance: 80,
      credits: 100,
      totalCost: null,
      totalRequests: null,
      rawData: {
        capabilities: { managementKeyConfirmed: true },
        keys: [{ label: "st", disabled: false, limitUsd: 50, limitRemainingUsd: 2 }],
      },
    });
    const r = await probeOpenRouterCredits(1000);
    expect(r.ok).toBe(false);
    expect(r.keysLimitLow).toBe(1);
    expect(r.reasons).toContain("key_limit_low");
  });

  it("fails open when fetchUsage throws", async () => {
    process.env.OPENROUTER_ADMIN_KEY = "sk-or-mgmt";
    fetchUsageMock.mockRejectedValue(new Error("boom"));
    const r = await probeOpenRouterCredits(1000);
    expect(r.ok).toBe(true);
    expect(r.error).toMatch(/boom/);
  });

  it("public projection keeps ok first for UptimeRobot keyword", async () => {
    process.env.OPENROUTER_ADMIN_KEY = "sk-or-mgmt";
    fetchUsageMock.mockResolvedValue({
      balance: 0.5,
      credits: 10,
      totalCost: null,
      totalRequests: null,
      rawData: {
        capabilities: { managementKeyConfirmed: true },
        keys: [],
      },
    });
    const r = await probeOpenRouterCredits(1000);
    const body = toPublicOpenRouterCreditProbe(r);
    const raw = JSON.stringify(body);
    expect(raw).toContain('"openrouterCredits":{"ok":false');
    // USD figures must not leak on the public probe.
    expect(raw).not.toMatch(/remainingUsd|totalUsd|usedUsd/);
    expect(body.ok).toBe(true); // route always healthy
  });

  it("caches within the interval", async () => {
    process.env.OPENROUTER_ADMIN_KEY = "sk-or-mgmt";
    process.env.OPENROUTER_CREDIT_CHECK_INTERVAL_MS = "600000";
    fetchUsageMock.mockResolvedValue({
      balance: 40,
      credits: 50,
      totalCost: null,
      totalRequests: null,
      rawData: { capabilities: { managementKeyConfirmed: true }, keys: [] },
    });
    await probeOpenRouterCredits(1000);
    await probeOpenRouterCredits(2000);
    expect(fetchUsageMock).toHaveBeenCalledTimes(1);
    await probeOpenRouterCredits(1000 + 600001);
    expect(fetchUsageMock).toHaveBeenCalledTimes(2);
  });
});
