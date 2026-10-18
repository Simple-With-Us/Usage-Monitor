import { describe, expect, it } from "vitest";
import { classifyAiRequestCost, type AiRequestCostInput } from "@/lib/ai-request-cost";

// UM-1610: PAYG-equivalent estimate for AiRequest rows with tokens but no
// harness-reported cost.  Pure, no clock, no database.

const row = (over: Partial<AiRequestCostInput>): AiRequestCostInput => ({
  servedModel: null,
  requestedModel: null,
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  cacheWrite5mTokens: null,
  cacheWrite1hTokens: null,
  costUsd: null,
  ...over,
});

describe("classifyAiRequestCost", () => {
  it("never estimates a row whose cost the harness reported", () => {
    const result = classifyAiRequestCost(
      row({ servedModel: "claude-sonnet-5", inputTokens: 1_000_000, outputTokens: 1_000_000, costUsd: 0.0421 })
    );
    expect(result).toEqual({ source: "reported", costUsd: 0.0421 });
  });

  it("keeps a reported zero as reported", () => {
    expect(classifyAiRequestCost(row({ servedModel: "claude-sonnet-5", inputTokens: 5, costUsd: 0 })).source).toBe(
      "reported"
    );
  });

  it("prices every bucket at its own rate (claude-sonnet-5: 2 / 10 / 0.2 / 2.5 / 4 per 1M)", () => {
    const result = classifyAiRequestCost(
      row({
        servedModel: "claude-sonnet-5",
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 2_000_000,
        cacheWrite5mTokens: 1_000_000,
        cacheWrite1hTokens: 1_000_000,
      })
    );
    expect(result.source).toBe("derived");
    expect(result.pricingKey).toBe("claude-sonnet-5");
    expect(result.incomplete).toBe(false);
    // 2 + 10 + 0.2 + 2.5 + 4
    expect(result.costUsd).toBeCloseTo(18.7, 9);
  });

  it("prices an unsplit cache-write total at the 5m rate", () => {
    const result = classifyAiRequestCost(
      row({ servedModel: "claude-sonnet-5", cacheWriteTokens: 1_000_000 })
    );
    expect(result.costUsd).toBeCloseTo(2.5, 9);
  });

  it("prices only the part of the write total the split does not cover at the 5m rate", () => {
    const result = classifyAiRequestCost(
      row({ servedModel: "claude-sonnet-5", cacheWriteTokens: 3_000_000, cacheWrite1hTokens: 1_000_000 })
    );
    // 2M unsplit at 5m ($2.50) + 1M at 1h ($4)
    expect(result.costUsd).toBeCloseTo(9, 9);
  });

  it("does not price reasoning tokens a second time (they are inside output)", () => {
    const base = row({ servedModel: "gpt-6-luna", inputTokens: 1000, outputTokens: 1000 });
    const withReasoning = { ...base, reasoningTokens: 800 } as AiRequestCostInput;
    expect(classifyAiRequestCost(withReasoning).costUsd).toBe(classifyAiRequestCost(base).costUsd);
  });

  it("estimates the Codex rows from prod (gpt-6-luna, uncached input + cache read)", () => {
    const result = classifyAiRequestCost(
      row({ servedModel: "gpt-6-luna", inputTokens: 20_000, outputTokens: 500, cacheReadTokens: 60_000 })
    );
    // 20k * 1e-7 + 500 * 5e-7 + 60k * 1e-8
    expect(result.source).toBe("derived");
    expect(result.costUsd).toBeCloseTo(0.002 + 0.00025 + 0.0006, 9);
  });

  it("flags a floor when a used token type has no catalog rate", () => {
    // gpt-5.6-luna has no cache-write rate.
    const result = classifyAiRequestCost(
      row({ servedModel: "gpt-5.6-luna", inputTokens: 1000, cacheWriteTokens: 1000 })
    );
    expect(result.source).toBe("derived");
    expect(result.incomplete).toBe(true);
    expect(result.costUsd).toBeCloseTo(1000 * 2e-7, 12);
  });

  it("prices claude-sonnet-5[1m] (Claude Code's 1M marker) as Sonnet 5", () => {
    const result = classifyAiRequestCost(
      row({ servedModel: "claude-sonnet-5[1m]", inputTokens: 1_000_000, outputTokens: 100_000 })
    );
    expect(result.pricingKey).toBe("claude-sonnet-5");
    expect(result.costUsd).toBeCloseTo(2 + 1, 9);
  });

  it("falls back to the requested model when the served id is not in the catalog", () => {
    const result = classifyAiRequestCost(
      row({ servedModel: "totally-unknown-model", requestedModel: "claude-haiku-5-5", inputTokens: 1000 })
    );
    expect(result.source).toBe("derived");
    expect(result.pricingKey).toBe("claude-haiku-5-5");
  });

  it("applies the long-prompt tier when the request's own prompt crosses the threshold", () => {
    // claude-haiku-5-5: prompts over 100k pay 5x.  Input $0.10 -> $0.50 per 1M.
    const short = classifyAiRequestCost(row({ servedModel: "claude-haiku-5-5", inputTokens: 90_000 }));
    const long = classifyAiRequestCost(
      row({ servedModel: "claude-haiku-5-5", inputTokens: 10_000, cacheReadTokens: 100_000 })
    );
    expect(short.costUsd).toBeCloseTo(90_000 * 1e-7, 12);
    // 10k * 5e-7 + 100k * 5e-8 (long-prompt rates)
    expect(long.costUsd).toBeCloseTo(0.005 + 0.005, 9);
  });

  it("reports unpriced for tokens on a model the catalog lacks, and none without tokens", () => {
    expect(classifyAiRequestCost(row({ servedModel: "mystery-model-9", inputTokens: 10 }))).toEqual({
      source: "unpriced",
      costUsd: null,
    });
    expect(classifyAiRequestCost(row({ servedModel: "claude-sonnet-5" }))).toEqual({
      source: "none",
      costUsd: null,
    });
    expect(classifyAiRequestCost(row({ servedModel: null, inputTokens: 10 })).source).toBe("unpriced");
  });
});
