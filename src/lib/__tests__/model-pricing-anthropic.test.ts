// UM-1591: Anthropic API-equivalent pricing, model-name resolution, 1h cache
// writes, long-prompt tier.  Rates pinned against
// platform.claude.com/docs/en/about-claude/pricing (read 2026-10-17) so a bad
// snapshot refresh fails CI instead of silently shifting the owner's
// "true PAYG equivalent" total.
import { describe, it, expect } from "vitest";
import {
  canonicalTokenType,
  deriveTokenCostUsd,
  getModelPricing,
  isOneHourCacheTtl,
  normalizeModelName,
  resolvePricingKey,
} from "../pricing/model-pricing";

// USD per MTok: input, output, cache read, 5m write, 1h write.
const ANTHROPIC_LIST: Record<string, [number, number, number, number, number]> = {
  "claude-fable-5-1": [10, 50, 0.25, 12.5, 20],
  "claude-fable-5": [10, 50, 1, 12.5, 20],
  "claude-opus-5-5": [4, 20, 0.2, 5, 8],
  "claude-opus-5": [5, 25, 0.5, 6.25, 10],
  "claude-sonnet-5-5": [2, 10, 0.1, 2.5, 4],
  "claude-sonnet-5": [2, 10, 0.2, 2.5, 4],
  "claude-haiku-5-5": [0.1, 0.5, 0.01, 0.125, 0.2],
  "claude-haiku-4-5": [1, 5, 0.1, 1.25, 2],
};

describe("Anthropic list rates (pinned to the pricing page)", () => {
  for (const [model, [inp, out, read, w5, w1]] of Object.entries(ANTHROPIC_LIST)) {
    it(`${model} matches the published input/output/cache rates`, () => {
      const resolved = getModelPricing(model);
      expect(resolved?.key).toBe(model);
      const p = resolved!.pricing;
      expect(p.input_cost_per_token! * 1e6).toBeCloseTo(inp, 9);
      expect(p.output_cost_per_token! * 1e6).toBeCloseTo(out, 9);
      expect(p.cache_read_input_token_cost! * 1e6).toBeCloseTo(read, 9);
      expect(p.cache_creation_input_token_cost! * 1e6).toBeCloseTo(w5, 9);
      expect(p.cache_creation_input_token_cost_above_1hr! * 1e6).toBeCloseTo(w1, 9);
    });
  }
});

describe("[1m] handling", () => {
  it("normalizeModelName strips the marker and reports the 1M variant", () => {
    expect(normalizeModelName("claude-opus-5-5[1m]")).toEqual({
      name: "claude-opus-5-5",
      context1m: true,
    });
    expect(normalizeModelName("claude-opus-5-5")).toEqual({
      name: "claude-opus-5-5",
      context1m: false,
    });
    expect(normalizeModelName("claude-opus-5.5[1M]").name).toBe("claude-opus-5-5");
    expect(normalizeModelName("claude-sonnet-5[200k]")).toEqual({
      name: "claude-sonnet-5",
      context1m: false,
    });
  });

  it("claude-opus-5-5[1m] prices at Opus 5.5, not Opus 5 (was +69%)", () => {
    expect(resolvePricingKey("claude-opus-5-5[1m]")).toBe("claude-opus-5-5");
    expect(getModelPricing("claude-opus-5-5[1m]")?.pricing.input_cost_per_token).toBeCloseTo(4e-6, 12);
  });

  it("claude-opus-5[1m] resolves to Opus 5 instead of being unpriced", () => {
    expect(resolvePricingKey("claude-opus-5[1m]")).toBe("claude-opus-5");
  });

  it("claude-sonnet-5[1m] resolves to Sonnet 5 (UM-1610: prod showed it unpriced)", () => {
    expect(resolvePricingKey("claude-sonnet-5[1m]")).toBe("claude-sonnet-5");
    expect(getModelPricing("claude-sonnet-5[1m]")?.pricing).toEqual(getModelPricing("claude-sonnet-5")?.pricing);
    expect(getModelPricing("claude-sonnet-5[1m]")?.pricing.input_cost_per_token).toBeCloseTo(2e-6, 12);
  });

  it("1M context carries no premium on Claude 4.6+ (same rates as the bare id)", () => {
    expect(getModelPricing("claude-sonnet-5-5[1m]")?.pricing).toEqual(
      getModelPricing("claude-sonnet-5-5")?.pricing
    );
  });
});

describe("prefix fallback never matches a shorter version key", () => {
  it("claude-fable-5-1 resolves to its own row, not claude-fable-5 (was +40%)", () => {
    expect(resolvePricingKey("claude-fable-5-1")).toBe("claude-fable-5-1");
    expect(resolvePricingKey("claude-fable-5-1[1m]")).toBe("claude-fable-5-1");
  });

  it("an unknown newer version is unpriced rather than priced as the shorter key", () => {
    expect(resolvePricingKey("claude-opus-5-9")).toBeNull();
    expect(resolvePricingKey("claude-sonnet-5-9")).toBeNull();
    expect(resolvePricingKey("claude-haiku-9-9")).toBeNull();
    expect(getModelPricing("claude-opus-5-9")).toBeNull();
  });

  it("-5 does not match -5-5 even with a date suffix", () => {
    expect(resolvePricingKey("claude-opus-5-5-20260401")).toBe("claude-opus-5-5");
    expect(resolvePricingKey("claude-opus-5-20260401")).toBe("claude-opus-5");
  });

  it("still matches date and alias suffixes", () => {
    expect(resolvePricingKey("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5-20251001");
    expect(resolvePricingKey("claude-haiku-4-5-99999999")).toBe("claude-haiku-4-5");
    expect(resolvePricingKey("claude-sonnet-4-5-latest")).toBe("claude-sonnet-4-5");
  });

  it("folds dotted Claude versions (Copilot reports claude-haiku-4.5)", () => {
    expect(resolvePricingKey("claude-haiku-4.5")).toBe("claude-haiku-4-5");
    expect(resolvePricingKey("claude-sonnet-5.5")).toBe("claude-sonnet-5-5");
  });
});

describe("Claude Haiku 5.5", () => {
  it("is priced (was unpriced)", () => {
    expect(resolvePricingKey("claude-haiku-5-5")).toBe("claude-haiku-5-5");
  });

  it("prompts over 100k tokens pay 5x on every category incl. 1h writes", () => {
    const p = getModelPricing("claude-haiku-5-5")!.pricing;
    const tokens = {
      input: 1e6,
      output: 1e6,
      cacheRead: 1e6,
      cacheCreation: 1e6,
      cacheCreation1h: 1e6,
    };
    // 0.10 + 0.50 + 0.01 + 0.125 + 0.20
    expect(deriveTokenCostUsd(p, tokens).costUsd).toBeCloseTo(0.935, 9);
    // 0.50 + 2.50 + 0.05 + 0.625 + 1.00
    expect(deriveTokenCostUsd(p, tokens, { longContext: true }).costUsd).toBeCloseTo(4.675, 9);
  });
});

describe("1h cache writes", () => {
  it("price at the 1h rate, separately from 5m writes", () => {
    const p = getModelPricing("claude-sonnet-5-5")!.pricing;
    const five = deriveTokenCostUsd(p, { cacheCreation: 1e6 });
    const hour = deriveTokenCostUsd(p, { cacheCreation1h: 1e6 });
    expect(five.costUsd).toBeCloseTo(2.5, 9);
    expect(hour.costUsd).toBeCloseTo(4, 9);
    expect(hour.complete).toBe(true);
    expect(deriveTokenCostUsd(p, { cacheCreation: 1e6, cacheCreation1h: 1e6 }).costUsd).toBeCloseTo(6.5, 9);
  });

  it("floors at the 5m rate and flags incomplete when no 1h rate exists", () => {
    const derived = deriveTokenCostUsd(
      { input_cost_per_token: 1e-6, cache_creation_input_token_cost: 1.25e-6 },
      { cacheCreation1h: 1e6 }
    );
    expect(derived.costUsd).toBeCloseTo(1.25, 9);
    expect(derived.complete).toBe(false);
  });

  it("canonicalTokenType accepts the UM-1592 names and legacy aliases", () => {
    expect(canonicalTokenType("cacheCreation")).toBe("cacheCreation");
    expect(canonicalTokenType("cacheCreation5m")).toBe("cacheCreation");
    expect(canonicalTokenType("cacheWrite5m")).toBe("cacheCreation");
    expect(canonicalTokenType("cacheCreation1h")).toBe("cacheCreation1h");
    expect(canonicalTokenType("cacheWrite1h")).toBe("cacheCreation1h");
    expect(canonicalTokenType("cacheWriteOneHour")).toBe("cacheCreation1h");
    expect(canonicalTokenType("cacheRead")).toBe("cacheRead");
    expect(canonicalTokenType("reasoning")).toBeNull();
    expect(canonicalTokenType(undefined)).toBeNull();
  });

  it("isOneHourCacheTtl recognizes metadata TTL spellings", () => {
    for (const v of ["1h", "1H", "60m", "3600", "3600s", 3600]) {
      expect(isOneHourCacheTtl(v)).toBe(true);
    }
    for (const v of ["5m", "300", 300, null, undefined, ""]) {
      expect(isOneHourCacheTtl(v)).toBe(false);
    }
  });
});

describe("other providers verified 2026-10-17", () => {
  it("MiniMax M3 is priced; M3.1 Flash Preview (plan-only) is unpriced", () => {
    const m3 = getModelPricing("MiniMax-M3")?.pricing;
    expect(m3?.input_cost_per_token! * 1e6).toBeCloseTo(0.3, 9);
    expect(m3?.output_cost_per_token! * 1e6).toBeCloseTo(1.2, 9);
    expect(m3?.cache_read_input_token_cost! * 1e6).toBeCloseTo(0.06, 9);
    expect(resolvePricingKey("MiniMax-M3.1-Flash-Preview")).toBeNull();
    expect(resolvePricingKey("MiniMax-M3.1-Flash-Preview-thinking")).toBeNull();
  });

  it("OpenAI GPT-6 family matches the published list", () => {
    const rates: Record<string, [number, number, number]> = {
      "gpt-5.5": [5, 30, 0.5],
      "gpt-5.6-luna": [0.2, 1.2, 0.02],
      "gpt-5.6-terra": [2, 12, 0.2],
      "gpt-5.6-sol": [4, 20, 0.4],
      "gpt-6-luna": [0.1, 0.5, 0.01],
      "gpt-6-sol": [2, 10, 0.2],
      "gpt-6-astra": [10, 50, 1],
      "gpt-6.1-sol": [2, 10, 0.1],
    };
    for (const [model, [i, o, r]] of Object.entries(rates)) {
      const p = getModelPricing(model)?.pricing;
      expect(p?.input_cost_per_token! * 1e6, model).toBeCloseTo(i, 9);
      expect(p?.output_cost_per_token! * 1e6, model).toBeCloseTo(o, 9);
      expect(p?.cache_read_input_token_cost! * 1e6, model).toBeCloseTo(r, 9);
    }
  });

  it("xAI Grok 4.5 / 4.6 / 4.7 match the published list", () => {
    const rates: Record<string, [number, number, number]> = {
      "grok-4.5": [2, 6, 0.3],
      "grok-4.6": [2, 6, 0.5],
      "grok-4.7": [2, 6, 0.5],
    };
    for (const [model, [i, o, r]] of Object.entries(rates)) {
      const p = getModelPricing(model)?.pricing;
      expect(p?.input_cost_per_token! * 1e6, model).toBeCloseTo(i, 9);
      expect(p?.output_cost_per_token! * 1e6, model).toBeCloseTo(o, 9);
      expect(p?.cache_read_input_token_cost! * 1e6, model).toBeCloseTo(r, 9);
    }
  });
});
