import { describe, it, expect } from "vitest";
import { buildApiEquivalentCost, buildClaudeCostCheck } from "../claude-cost-check";

describe("buildClaudeCostCheck", () => {
  it("derives cost from tokens and compares against the reported estimate", () => {
    const report = buildClaudeCostCheck(
      [
        { model: "claude-sonnet-4-5", tokenType: "input", quantity: 1_000_000 },
        { model: "claude-sonnet-4-5", tokenType: "output", quantity: 100_000 },
      ],
      [{ model: "claude-sonnet-4-5", costUsd: 4.0 }]
    );
    const model = report.models[0];
    // derived = $3 (1M input) + $1.50 (100k output) = $4.50
    expect(model.derivedCostUsd).toBeCloseTo(4.5, 6);
    expect(model.reportedCostUsd).toBeCloseTo(4.0, 6);
    expect(model.deltaUsd).toBeCloseTo(0.5, 6);
    expect(model.deltaPct).toBeCloseTo(0.5 / 4.5, 6);
    expect(model.derivationComplete).toBe(true);
    expect(model.pricingKey).toBe("claude-sonnet-4-5");
  });

  it("marks unpriced models as incomplete and counts them in totals", () => {
    const report = buildClaudeCostCheck(
      [{ model: "brand-new-unpriced-model", tokenType: "input", quantity: 5000 }],
      []
    );
    expect(report.models[0].derivationComplete).toBe(false);
    expect(report.models[0].derivedCostUsd).toBe(0);
    expect(report.totals.unpricedModelCount).toBe(1);
  });

  it("counts a catalog model with an unavailable token-type rate as incomplete", () => {
    const report = buildClaudeCostCheck(
      [{ model: "gpt-5.6-luna", tokenType: "cacheCreation", quantity: 5000 }],
      []
    );
    expect(report.models[0].pricingKey).toBe("gpt-5.6-luna");
    expect(report.models[0].derivationComplete).toBe(false);
    expect(report.totals.unpricedModelCount).toBe(1);
  });

  it("prices claude-sonnet-5 cacheCreation after the 5m cache-write override landed", () => {
    const report = buildClaudeCostCheck(
      [{ model: "claude-sonnet-5", tokenType: "cacheCreation", quantity: 1_000_000 }],
      []
    );
    expect(report.models[0].pricingKey).toBe("claude-sonnet-5");
    expect(report.models[0].derivationComplete).toBe(true);
    expect(report.models[0].derivedCostUsd).toBeCloseTo(2.5, 6);
  });

  it("buckets unrecognized token types as unknown and incomplete", () => {
    const report = buildClaudeCostCheck(
      [{ model: "claude-sonnet-4-5", tokenType: "mystery", quantity: 100 }],
      []
    );
    expect(report.models[0].tokens.unknown).toBe(100);
    expect(report.models[0].derivationComplete).toBe(false);
  });

  it("handles cost-only models (tokens reported nowhere) with a null deltaPct basis", () => {
    const report = buildClaudeCostCheck(
      [],
      [{ model: "claude-opus-4-1", costUsd: 2.5 }]
    );
    expect(report.models[0].reportedCostUsd).toBeCloseTo(2.5, 6);
    expect(report.models[0].derivedCostUsd).toBe(0);
    expect(report.models[0].deltaUsd).toBeCloseTo(-2.5, 6);
    expect(report.models[0].deltaPct).toBeCloseTo(-1, 6);
  });

  it("ignores non-positive quantities and costs entirely", () => {
    const report = buildClaudeCostCheck(
      [
        { model: "claude-sonnet-4-5", tokenType: "input", quantity: 0 },
        { model: "claude-sonnet-4-5", tokenType: "input", quantity: -10 },
      ],
      [{ model: "claude-sonnet-4-5", costUsd: -1 }]
    );
    expect(report.models).toHaveLength(0);
    expect(report.totals.derivedCostUsd).toBe(0);
    expect(report.totals.reportedCostUsd).toBe(0);
    expect(report.totals.deltaPct).toBeNull();
  });

  it("groups null models under a stable label", () => {
    const report = buildClaudeCostCheck(
      [{ model: null, tokenType: "input", quantity: 1000 }],
      [{ model: null, costUsd: 0.01 }]
    );
    expect(report.models[0].model).toBe("(no model)");
  });

  it("sorts models by largest cost surface first", () => {
    const report = buildClaudeCostCheck(
      [
        { model: "claude-sonnet-4-5", tokenType: "input", quantity: 1_000_000 },
        { model: "claude-haiku-4-5", tokenType: "input", quantity: 1_000_000 },
      ],
      []
    );
    expect(report.models[0].model).toBe("claude-sonnet-4-5");
  });
});

describe("buildApiEquivalentCost", () => {
  it("groups seats and uses catalog estimate when the producer posted no dollars", () => {
    const report = buildApiEquivalentCost(
      [
        {
          provider: "openai",
          sourceApp: "openai-codex",
          model: "gpt-5.6-sol",
          tokenType: "input",
          quantity: 1_000_000,
        },
        {
          provider: "anthropic",
          sourceApp: "claude-code",
          model: "claude-sonnet-4-5",
          tokenType: "input",
          quantity: 1_000_000,
        },
        {
          provider: "github-copilot",
          sourceApp: "github-copilot",
          model: "gpt-4o",
          tokenType: "output",
          quantity: 1_000_000,
        },
      ],
      [
        {
          provider: "anthropic",
          sourceApp: "claude-code",
          model: "claude-sonnet-4-5",
          costUsd: 3,
        },
      ]
    );
    expect(report.providers).toHaveLength(3);
    const claude = report.providers.find((p) => p.sourceApp === "claude-code");
    const codex = report.providers.find((p) => p.sourceApp === "openai-codex");
    const copilot = report.providers.find((p) => p.sourceApp === "github-copilot");
    expect(claude?.totals.reportedCostUsd).toBeCloseTo(3, 6);
    expect(claude?.totals.derivedCostUsd).toBeCloseTo(3, 6);
    expect(codex?.totals.reportedCostUsd).toBe(0);
    expect(codex?.estimateUsd).toBeGreaterThan(0);
    expect(copilot?.totals.reportedCostUsd).toBe(0);
    expect(copilot?.estimateUsd).toBeGreaterThan(0);
    expect(report.totals.estimateUsd).toBeGreaterThan(3);
  });
});

describe("UM-1591 pricing resolution in the cost check", () => {
  it("prices claude-opus-5-5[1m] at Opus 5.5 rates, not Opus 5 (was +69%)", () => {
    const report = buildClaudeCostCheck(
      [
        { model: "claude-opus-5-5[1m]", tokenType: "input", quantity: 1_000_000 },
        { model: "claude-opus-5-5[1m]", tokenType: "output", quantity: 1_000_000 },
      ],
      [{ model: "claude-opus-5-5[1m]", costUsd: 24 }]
    );
    expect(report.models[0].pricingKey).toBe("claude-opus-5-5");
    expect(report.models[0].pricingStatus).toBe("priced");
    expect(report.models[0].derivedCostUsd).toBeCloseTo(24, 6);
    expect(report.models[0].deltaUsd).toBeCloseTo(0, 6);
  });

  it("reports an unknown version as unpriced instead of borrowing a shorter key's rates", () => {
    const report = buildClaudeCostCheck(
      [{ model: "claude-opus-5-9", tokenType: "input", quantity: 1_000_000 }],
      []
    );
    expect(report.models[0].pricingKey).toBeNull();
    expect(report.models[0].pricingStatus).toBe("unpriced");
    expect(report.models[0].derivedCostUsd).toBe(0);
    expect(report.totals.unpricedModelCount).toBe(1);
  });

  it("prices claude-fable-5-1 and claude-haiku-5-5 (were fuzzy-matched / unpriced)", () => {
    const report = buildClaudeCostCheck(
      [
        { model: "claude-fable-5-1", tokenType: "cacheRead", quantity: 1_000_000 },
        { model: "claude-haiku-5-5", tokenType: "output", quantity: 1_000_000 },
      ],
      []
    );
    const byModel = Object.fromEntries(report.models.map((m) => [m.model, m]));
    expect(byModel["claude-fable-5-1"].pricingKey).toBe("claude-fable-5-1");
    expect(byModel["claude-fable-5-1"].derivedCostUsd).toBeCloseTo(0.25, 6);
    expect(byModel["claude-haiku-5-5"].derivedCostUsd).toBeCloseTo(0.5, 6);
  });

  it("prices 1h cache writes at the 1h rate and brackets untyped writes between 5m and 1h", () => {
    const report = buildClaudeCostCheck(
      [
        { model: "claude-sonnet-5-5", tokenType: "cacheCreation", quantity: 1_000_000 },
        { model: "claude-sonnet-5-5", tokenType: "cacheCreation1h", quantity: 1_000_000 },
      ],
      []
    );
    const m = report.models[0];
    expect(m.tokens.cacheCreation).toBe(1_000_000);
    expect(m.tokens.cacheCreation1h).toBe(1_000_000);
    expect(m.derivedCostUsd).toBeCloseTo(2.5 + 4, 6);
    // Upper bound prices BOTH buckets at 1h.
    expect(m.derivedCostUpperBoundUsd).toBeCloseTo(8, 6);
    expect(m.derivationComplete).toBe(true);
  });

  it("untyped cache writes: reported cost above the 5m derivation sits inside the 5m..1h band", () => {
    const report = buildClaudeCostCheck(
      [{ model: "claude-opus-5-5", tokenType: "cacheCreation", quantity: 1_000_000 }],
      [{ model: "claude-opus-5-5", costUsd: 6.5 }]
    );
    const m = report.models[0];
    expect(m.derivedCostUsd).toBeCloseTo(5, 6);
    expect(m.derivedCostUpperBoundUsd).toBeCloseTo(8, 6);
    expect(m.reportedCostUsd).toBeGreaterThan(m.derivedCostUsd);
    expect(m.reportedCostUsd).toBeLessThan(m.derivedCostUpperBoundUsd);
  });

  it("applies Haiku 5.5's long-prompt tier only when the per-row prompt clears 100k", () => {
    const short = buildClaudeCostCheck(
      [
        { model: "claude-haiku-5-5", tokenType: "input", quantity: 1_000_000, rows: 100 },
        { model: "claude-haiku-5-5", tokenType: "output", quantity: 1_000_000, rows: 100 },
      ],
      []
    ).models[0];
    expect(short.longPromptTier).toBe(false);
    expect(short.derivedCostUsd).toBeCloseTo(0.1 + 0.5, 6);

    const long = buildClaudeCostCheck(
      [
        { model: "claude-haiku-5-5", tokenType: "input", quantity: 1_000_000, rows: 2 },
        { model: "claude-haiku-5-5", tokenType: "output", quantity: 1_000_000, rows: 2 },
      ],
      []
    ).models[0];
    expect(long.longPromptTier).toBe(true);
    expect(long.derivedCostUsd).toBeCloseTo(0.5 + 2.5, 6);
  });

  it("never applies a long-prompt tier to models that have none", () => {
    const m = buildClaudeCostCheck(
      [{ model: "claude-opus-5-5[1m]", tokenType: "cacheRead", quantity: 900_000_000, rows: 1 }],
      []
    ).models[0];
    expect(m.longPromptTier).toBe(false);
    expect(m.derivedCostUsd).toBeCloseTo(180, 6);
  });
});
