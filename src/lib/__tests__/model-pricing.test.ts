import { describe, it, expect } from "vitest";
import {
  deriveTokenCostUsd,
  getModelPricing,
  resolvePricingKey,
  PRICING_SNAPSHOT_META,
} from "../pricing/model-pricing";

describe("resolvePricingKey", () => {
  it("resolves bare catalog keys exactly", () => {
    expect(resolvePricingKey("claude-sonnet-4-5")).toBe("claude-sonnet-4-5");
  });

  it("resolves dated model variants directly present in the catalog", () => {
    expect(resolvePricingKey("claude-sonnet-4-5-20250929")).toBe("claude-sonnet-4-5-20250929");
  });

  it("strips provider prefixes progressively", () => {
    expect(resolvePricingKey("anthropic/claude-sonnet-4-5")).toBe("claude-sonnet-4-5");
    expect(resolvePricingKey("openrouter/anthropic/claude-sonnet-4-5")).toBe("claude-sonnet-4-5");
  });

  it("fuzzy-matches alias suffixes to the longest catalog prefix", () => {
    // e.g. a producer reports "claude-sonnet-4-5-latest"; the catalog only
    // lists the base and dated keys.
    expect(resolvePricingKey("claude-sonnet-4-5-latest")).toBe("claude-sonnet-4-5");
  });

  it("returns null for unknown models instead of guessing", () => {
    expect(resolvePricingKey("definitely-not-a-real-model-xyz")).toBeNull();
    expect(resolvePricingKey("")).toBeNull();
  });

  it("prices Grok Build model ids against xAI list rates without rewriting LiteLLM", () => {
    expect(resolvePricingKey("grok-4.6-build")).toBe("grok-4.6-build");
    expect(resolvePricingKey("xai/grok-4.5-build")).toBe("xai/grok-4.5-build");
    const grok46 = getModelPricing("grok-4.6-build");
    expect(grok46?.pricing.input_cost_per_token).toBeCloseTo(2e-6, 12);
    expect(grok46?.pricing.output_cost_per_token).toBeCloseTo(6e-6, 12);
    expect(grok46?.pricing.cache_read_input_token_cost).toBeCloseTo(5e-7, 12);
    const derived = deriveTokenCostUsd(grok46!.pricing, {
      input: 1_000_000,
      output: 1_000_000,
      cacheRead: 1_000_000,
    });
    expect(derived.complete).toBe(true);
    expect(derived.costUsd).toBeCloseTo(8.5, 6);
  });

  it("prices current Gemini 3.7 Flash without rewriting the LiteLLM snapshot", () => {
    expect(resolvePricingKey("gemini-3.7-flash")).toBe("gemini-3.7-flash");
    expect(resolvePricingKey("google/gemini-3.7-flash")).toBe("gemini-3.7-flash");
    expect(resolvePricingKey("google/gemini-3.7-flash:batch")).toBe("gemini-3.7-flash:batch");
    const interactive = getModelPricing("google/gemini-3.7-flash");
    const batch = getModelPricing("google/gemini-3.7-flash:batch");
    expect(interactive?.pricing.input_cost_per_token).toBeCloseTo(3.75e-7, 12);
    expect(interactive?.pricing.output_cost_per_token).toBeCloseTo(1.875e-6, 12);
    expect(batch?.pricing.input_cost_per_token).toBeCloseTo(1.875e-7, 12);
    expect(batch?.pricing.output_cost_per_token).toBeCloseTo(9.375e-7, 12);
  });

  it("prices GPT-6 Astra at official OpenAI API-equivalent rates", () => {
    const astra = getModelPricing("gpt-6-astra");
    expect(astra?.pricing.input_cost_per_token).toBeCloseTo(10e-6, 12);
    expect(astra?.pricing.cache_read_input_token_cost).toBeCloseTo(1e-6, 12);
    expect(astra?.pricing.output_cost_per_token).toBeCloseTo(50e-6, 12);
    const derived = deriveTokenCostUsd(astra!.pricing, {
      input: 1_000_000,
      cacheRead: 1_000_000,
      output: 1_000_000,
    });
    expect(derived.costUsd).toBeCloseTo(61, 6);
  });

  it("prices the current Codex standard models and leaves Spark unknown", () => {
    const cases = [
      ["gpt-5.6-luna", 0.2e-6, 0.02e-6, 1.2e-6],
      ["gpt-5.6-terra", 2e-6, 0.2e-6, 12e-6],
      ["gpt-5.6-sol", 4e-6, 0.4e-6, 20e-6],
    ] as const;
    for (const [model, input, cacheRead, output] of cases) {
      const pricing = getModelPricing(model)?.pricing;
      expect(pricing?.input_cost_per_token).toBeCloseTo(input, 12);
      expect(pricing?.cache_read_input_token_cost).toBeCloseTo(cacheRead, 12);
      expect(pricing?.output_cost_per_token).toBeCloseTo(output, 12);
    }
    expect(resolvePricingKey("gpt-5.3-codex-spark")).toBeNull();
  });

  it("prices Claude Opus 5 at Anthropic list rates (not retired Opus 4.1)", () => {
    const pricing = getModelPricing("claude-opus-5")?.pricing;
    expect(pricing?.input_cost_per_token).toBeCloseTo(5e-6, 12);
    expect(pricing?.output_cost_per_token).toBeCloseTo(25e-6, 12);
    expect(pricing?.cache_read_input_token_cost).toBeCloseTo(0.5e-6, 12);
    expect(pricing?.cache_creation_input_token_cost).toBeCloseTo(6.25e-6, 12);
    const derived = deriveTokenCostUsd(pricing!, {
      input: 1_000_000,
      output: 1_000_000,
      cacheRead: 1_000_000,
      cacheCreation: 1_000_000,
    });
    expect(derived.complete).toBe(true);
    expect(derived.costUsd).toBeCloseTo(36.75, 6);
  });

  it("prices Claude Opus 5.5 explicitly instead of fuzzy-matching Opus 5", () => {
    expect(resolvePricingKey("claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(resolvePricingKey("claude-opus-5.5")).toBe("claude-opus-5-5");
    const pricing = getModelPricing("claude-opus-5-5")?.pricing;
    expect(pricing?.input_cost_per_token).toBeCloseTo(4e-6, 12);
    expect(pricing?.output_cost_per_token).toBeCloseTo(20e-6, 12);
    expect(pricing?.cache_read_input_token_cost).toBeCloseTo(0.2e-6, 12);
    expect(pricing?.cache_creation_input_token_cost).toBeCloseTo(5e-6, 12);
  });

  it("prices Claude Sonnet 5.5 explicitly", () => {
    expect(resolvePricingKey("claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
    const pricing = getModelPricing("claude-sonnet-5-5")?.pricing;
    expect(pricing?.input_cost_per_token).toBeCloseTo(2e-6, 12);
    expect(pricing?.cache_read_input_token_cost).toBeCloseTo(0.1e-6, 12);
    expect(pricing?.output_cost_per_token).toBeCloseTo(10e-6, 12);
    expect(pricing?.cache_creation_input_token_cost).toBeCloseTo(2.5e-6, 12);
  });

  it("prices Claude Sonnet 5 with 5m cache-write rate", () => {
    const pricing = getModelPricing("claude-sonnet-5")?.pricing;
    expect(pricing?.input_cost_per_token).toBeCloseTo(2e-6, 12);
    expect(pricing?.cache_read_input_token_cost).toBeCloseTo(0.2e-6, 12);
    expect(pricing?.output_cost_per_token).toBeCloseTo(10e-6, 12);
    expect(pricing?.cache_creation_input_token_cost).toBeCloseTo(2.5e-6, 12);
  });

  it("prices grok-4.7 at xAI list rates", () => {
    expect(resolvePricingKey("grok-4.7")).toBe("grok-4.7");
    const pricing = getModelPricing("grok-4.7")?.pricing;
    expect(pricing?.input_cost_per_token).toBeCloseTo(2e-6, 12);
    expect(pricing?.output_cost_per_token).toBeCloseTo(6e-6, 12);
    expect(pricing?.cache_read_input_token_cost).toBeCloseTo(5e-7, 12);
    const derived = deriveTokenCostUsd(pricing!, {
      input: 1_000_000,
      output: 1_000_000,
      cacheRead: 1_000_000,
    });
    expect(derived.complete).toBe(true);
    expect(derived.costUsd).toBeCloseTo(8.5, 6);
  });

  it("does not apply a flat DeepSeek V4 catalog rate without an event time", () => {
    // The LiteLLM snapshot still has one stale rate for these ids.  Peak and
    // off-peak are priced per event in deepseek-payg.ts, not from that row.
    expect(resolvePricingKey("deepseek-v4-flash")).toBeNull();
    expect(resolvePricingKey("deepseek-v4-pro")).toBeNull();
    expect(resolvePricingKey("deepseek-flash")).toBeNull();
    expect(resolvePricingKey("deepseek/deepseek-v4-pro")).toBeNull();
    expect(resolvePricingKey("openrouter/deepseek/deepseek-v4-flash-20260913")).toBeNull();
    expect(getModelPricing("deepseek/deepseek-v4-pro")).toBeNull();
    expect(getModelPricing("deepseek-flash")).toBeNull();
  });

  it("caches lookups without changing results", () => {
    const first = resolvePricingKey("gpt-4o");
    const second = resolvePricingKey("gpt-4o");
    expect(first).toBe("gpt-4o");
    expect(second).toBe(first);
  });
});

describe("deriveTokenCostUsd", () => {
  const sonnet = getModelPricing("claude-sonnet-4-5");
  if (!sonnet) throw new Error("snapshot missing claude-sonnet-4-5 canary");

  it("prices all four Claude token types from the catalog", () => {
    const derived = deriveTokenCostUsd(sonnet.pricing, {
      input: 1_000_000,
      output: 1_000_000,
      cacheRead: 1_000_000,
      cacheCreation: 1_000_000,
    });
    // claude-sonnet-4-5: $3 input, $15 output, $0.30 cache read, $3.75 cache
    // creation per 1M tokens -> $22.05 total.
    expect(derived.complete).toBe(true);
    expect(derived.costUsd).toBeCloseTo(22.05, 6);
  });

  it("flags incomplete derivation when a present token type has no rate", () => {
    const derived = deriveTokenCostUsd(
      { input_cost_per_token: 1e-6 },
      { input: 1000, cacheRead: 5000 }
    );
    expect(derived.complete).toBe(false);
    expect(derived.costUsd).toBeCloseTo(0.001, 9);
  });

  it("uses >200k-context rates only when explicitly requested", () => {
    // Claude 4.6+ bills 1M context at the standard rate, so use a model with a
    // real long-context tier: Grok 4.6 doubles input above 200k ($2 -> $4 per 1M).
    const grok = getModelPricing("grok-4.6")!;
    const base = deriveTokenCostUsd(grok.pricing, { input: 1_000_000 });
    const longCtx = deriveTokenCostUsd(grok.pricing, { input: 1_000_000 }, { above200k: true });
    const viaNewName = deriveTokenCostUsd(grok.pricing, { input: 1_000_000 }, { longContext: true });
    expect(base.costUsd).toBeCloseTo(2, 6);
    expect(longCtx.costUsd).toBeCloseTo(4, 6);
    expect(viaNewName.costUsd).toBeCloseTo(4, 6);
  });

  it("treats zero/negative counts as absent rather than incomplete", () => {
    const derived = deriveTokenCostUsd({ input_cost_per_token: 1e-6 }, { input: 0, cacheRead: -5 });
    expect(derived.complete).toBe(true);
    expect(derived.costUsd).toBe(0);
  });
});

describe("PRICING_SNAPSHOT_META", () => {
  it("carries provenance for the bundled catalog", () => {
    expect(PRICING_SNAPSHOT_META.source).toContain("litellm");
    expect(PRICING_SNAPSHOT_META.modelCount).toBeGreaterThan(1000);
    expect(PRICING_SNAPSHOT_META.upstreamSha256).toMatch(/^[a-f0-9]{64}$/);
  });
});
