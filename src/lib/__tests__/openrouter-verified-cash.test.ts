import { afterEach, describe, expect, it } from "vitest";
import {
  resolveOpenRouterVerifiedCash,
  resolveOpenRouterVerifiedCashConfig,
  type OpenRouterVerifiedCashConfig,
  type OpenRouterVerifiedCashInput,
} from "@/lib/openrouter-verified-cash";

// Pure unit tests — no DB, no Prisma, no wall clock.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ENABLED_CONFIG: OpenRouterVerifiedCashConfig = { enabled: true, minCoverage: 0.9 };
const DISABLED_CONFIG: OpenRouterVerifiedCashConfig = { enabled: false, minCoverage: 0.9 };

function input(overrides: Partial<OpenRouterVerifiedCashInput> = {}): OpenRouterVerifiedCashInput {
  return {
    providerCanonicalKey: "openrouter",
    observedVariableUsageUsd: 10.0,
    verifiedCoverage: 0.95,
    periodVerifiedCostUsd: 12.5,
    config: ENABLED_CONFIG,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// resolveOpenRouterVerifiedCashConfig
// ---------------------------------------------------------------------------

describe("resolveOpenRouterVerifiedCashConfig", () => {
  afterEach(() => {
    delete process.env.OPENROUTER_VERIFIED_PREFERRED_CASH;
    delete process.env.OPENROUTER_VERIFIED_PREFERRED_MIN_COVERAGE;
  });

  it("is disabled by default (env unset)", () => {
    const cfg = resolveOpenRouterVerifiedCashConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.minCoverage).toBe(0.9);
  });

  it.each(["true", "1", "yes"])('enables on %s', (val) => {
    process.env.OPENROUTER_VERIFIED_PREFERRED_CASH = val;
    expect(resolveOpenRouterVerifiedCashConfig().enabled).toBe(true);
  });

  it.each(["false", "0", "no", "maybe", ""])('stays disabled on %s', (val) => {
    process.env.OPENROUTER_VERIFIED_PREFERRED_CASH = val;
    expect(resolveOpenRouterVerifiedCashConfig().enabled).toBe(false);
  });

  it("parses a valid OPENROUTER_VERIFIED_PREFERRED_MIN_COVERAGE", () => {
    process.env.OPENROUTER_VERIFIED_PREFERRED_MIN_COVERAGE = "0.75";
    expect(resolveOpenRouterVerifiedCashConfig().minCoverage).toBe(0.75);
  });

  it("defaults to 0.9 when coverage env is empty string", () => {
    process.env.OPENROUTER_VERIFIED_PREFERRED_MIN_COVERAGE = "";
    expect(resolveOpenRouterVerifiedCashConfig().minCoverage).toBe(0.9);
  });

  it("defaults to 0.9 when coverage env is not a number", () => {
    process.env.OPENROUTER_VERIFIED_PREFERRED_MIN_COVERAGE = "abc";
    expect(resolveOpenRouterVerifiedCashConfig().minCoverage).toBe(0.9);
  });

  it("defaults to 0.9 when coverage env is out of 0..1 range", () => {
    process.env.OPENROUTER_VERIFIED_PREFERRED_MIN_COVERAGE = "1.5";
    expect(resolveOpenRouterVerifiedCashConfig().minCoverage).toBe(0.9);
  });

  it("accepts edge values 0 and 1 as valid thresholds", () => {
    process.env.OPENROUTER_VERIFIED_PREFERRED_MIN_COVERAGE = "0";
    expect(resolveOpenRouterVerifiedCashConfig().minCoverage).toBe(0);

    process.env.OPENROUTER_VERIFIED_PREFERRED_MIN_COVERAGE = "1";
    expect(resolveOpenRouterVerifiedCashConfig().minCoverage).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// resolveOpenRouterVerifiedCash — feature-off path
// ---------------------------------------------------------------------------

describe("resolveOpenRouterVerifiedCash — feature disabled", () => {
  it("returns observedVariableUsageUsd unchanged when config.enabled is false", () => {
    const result = resolveOpenRouterVerifiedCash(input({ config: DISABLED_CONFIG }));
    expect(result.usageCost).toBe(10.0);
    expect(result.verifiedPreferredCashApplied).toBe(false);
    expect(result.verifiedPreferredCashUsd).toBeNull();
  });

  it("never applies even with perfect coverage when disabled", () => {
    const result = resolveOpenRouterVerifiedCash(
      input({ config: DISABLED_CONFIG, verifiedCoverage: 1.0, periodVerifiedCostUsd: 99 })
    );
    expect(result.verifiedPreferredCashApplied).toBe(false);
    expect(result.usageCost).toBe(10.0);
  });
});

// ---------------------------------------------------------------------------
// resolveOpenRouterVerifiedCash — enabled, happy path
// ---------------------------------------------------------------------------

describe("resolveOpenRouterVerifiedCash — substitution applies", () => {
  it("substitutes the verified cost when all conditions hold", () => {
    const result = resolveOpenRouterVerifiedCash(input());
    expect(result.usageCost).toBe(12.5);
    expect(result.verifiedPreferredCashApplied).toBe(true);
    expect(result.verifiedPreferredCashUsd).toBe(12.5);
  });

  it("applies when coverage is exactly at the threshold", () => {
    const result = resolveOpenRouterVerifiedCash(
      input({ verifiedCoverage: 0.9, config: { enabled: true, minCoverage: 0.9 } })
    );
    expect(result.verifiedPreferredCashApplied).toBe(true);
    expect(result.usageCost).toBe(12.5);
  });

  it("applies when verified cost is 0 (legitimately free period)", () => {
    const result = resolveOpenRouterVerifiedCash(
      input({ periodVerifiedCostUsd: 0, verifiedCoverage: 1.0 })
    );
    expect(result.usageCost).toBe(0);
    expect(result.verifiedPreferredCashApplied).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveOpenRouterVerifiedCash — guard conditions (one failed condition each)
// ---------------------------------------------------------------------------

describe("resolveOpenRouterVerifiedCash — guard conditions", () => {
  it("does not apply for a non-openrouter provider", () => {
    const result = resolveOpenRouterVerifiedCash(input({ providerCanonicalKey: "anthropic" }));
    expect(result.verifiedPreferredCashApplied).toBe(false);
    expect(result.usageCost).toBe(10.0);
  });

  it("does not apply when verifiedCoverage is null (no verifiable events)", () => {
    const result = resolveOpenRouterVerifiedCash(input({ verifiedCoverage: null }));
    expect(result.verifiedPreferredCashApplied).toBe(false);
    expect(result.usageCost).toBe(10.0);
  });

  it("does not apply when coverage is below threshold", () => {
    const result = resolveOpenRouterVerifiedCash(
      input({ verifiedCoverage: 0.89, config: { enabled: true, minCoverage: 0.9 } })
    );
    expect(result.verifiedPreferredCashApplied).toBe(false);
    expect(result.usageCost).toBe(10.0);
  });

  it("does not apply when periodVerifiedCostUsd is null (no reconciliation run yet)", () => {
    const result = resolveOpenRouterVerifiedCash(input({ periodVerifiedCostUsd: null }));
    expect(result.verifiedPreferredCashApplied).toBe(false);
    expect(result.usageCost).toBe(10.0);
  });

  it("does not apply when periodVerifiedCostUsd is NaN", () => {
    const result = resolveOpenRouterVerifiedCash(input({ periodVerifiedCostUsd: NaN }));
    expect(result.verifiedPreferredCashApplied).toBe(false);
    expect(result.usageCost).toBe(10.0);
  });

  it("does not apply when periodVerifiedCostUsd is Infinity", () => {
    const result = resolveOpenRouterVerifiedCash(input({ periodVerifiedCostUsd: Infinity }));
    expect(result.verifiedPreferredCashApplied).toBe(false);
    expect(result.usageCost).toBe(10.0);
  });

  it("does not apply when periodVerifiedCostUsd is negative", () => {
    const result = resolveOpenRouterVerifiedCash(input({ periodVerifiedCostUsd: -0.01 }));
    expect(result.verifiedPreferredCashApplied).toBe(false);
    expect(result.usageCost).toBe(10.0);
  });
});

// ---------------------------------------------------------------------------
// resolveOpenRouterVerifiedCash — threshold edge cases
// ---------------------------------------------------------------------------

describe("resolveOpenRouterVerifiedCash — threshold edge cases", () => {
  it("applies when minCoverage is 0 and verifiedCoverage is 0", () => {
    const result = resolveOpenRouterVerifiedCash(
      input({
        verifiedCoverage: 0,
        config: { enabled: true, minCoverage: 0 },
      })
    );
    expect(result.verifiedPreferredCashApplied).toBe(true);
  });

  it("does not apply when verifiedCoverage is 0 and minCoverage is 0.9 (default)", () => {
    const result = resolveOpenRouterVerifiedCash(input({ verifiedCoverage: 0 }));
    expect(result.verifiedPreferredCashApplied).toBe(false);
  });

  it("applies for a custom lower threshold (0.75)", () => {
    const result = resolveOpenRouterVerifiedCash(
      input({
        verifiedCoverage: 0.80,
        config: { enabled: true, minCoverage: 0.75 },
      })
    );
    expect(result.verifiedPreferredCashApplied).toBe(true);
    expect(result.usageCost).toBe(12.5);
  });
});

// ---------------------------------------------------------------------------
// resolveOpenRouterVerifiedCash — output fields are always present
// ---------------------------------------------------------------------------

describe("resolveOpenRouterVerifiedCash — return shape", () => {
  it("always returns all three fields regardless of outcome", () => {
    for (const cfg of [ENABLED_CONFIG, DISABLED_CONFIG]) {
      const result = resolveOpenRouterVerifiedCash(input({ config: cfg }));
      expect(typeof result.usageCost).toBe("number");
      expect(typeof result.verifiedPreferredCashApplied).toBe("boolean");
      // verifiedPreferredCashUsd may be null or number — both are valid
      expect(result).toHaveProperty("verifiedPreferredCashUsd");
    }
  });

  it("verifiedPreferredCashUsd equals usageCost when applied", () => {
    const result = resolveOpenRouterVerifiedCash(input());
    expect(result.verifiedPreferredCashApplied).toBe(true);
    expect(result.verifiedPreferredCashUsd).toBe(result.usageCost);
  });

  it("verifiedPreferredCashUsd is null when not applied", () => {
    const result = resolveOpenRouterVerifiedCash(input({ config: DISABLED_CONFIG }));
    expect(result.verifiedPreferredCashApplied).toBe(false);
    expect(result.verifiedPreferredCashUsd).toBeNull();
  });
});
