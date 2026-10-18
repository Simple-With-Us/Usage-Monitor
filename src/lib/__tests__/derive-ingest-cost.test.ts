import { afterEach, describe, expect, it } from "vitest";
import {
  applyIngestCostDerivation,
  deriveEventCostEstimate,
  ingestCostDerivationEnabled,
  type CostDerivationEvent,
} from "../pricing/derive-ingest-cost";
import { PRICING_SNAPSHOT_META } from "../pricing/model-pricing";

const FLAG = "INGEST_COST_DERIVATION_ENABLED";

afterEach(() => {
  delete process.env[FLAG];
});

describe("ingestCostDerivationEnabled", () => {
  it("is default-off", () => {
    expect(ingestCostDerivationEnabled()).toBe(false);
  });

  it("accepts common truthy spellings and rejects others", () => {
    for (const value of ["true", "1", "yes", "TRUE", " Yes "]) {
      process.env[FLAG] = value;
      expect(ingestCostDerivationEnabled()).toBe(true);
    }
    for (const value of ["false", "0", "no", "on", ""]) {
      process.env[FLAG] = value;
      expect(ingestCostDerivationEnabled()).toBe(false);
    }
  });
});

describe("deriveEventCostEstimate", () => {
  it("derives from the matching token-type rate when tokenType is supplied", () => {
    const estimate = deriveEventCostEstimate({
      metricType: "usage",
      unit: "token",
      quantity: 1_000_000,
      keyRef: "claude-sonnet-4-5",
      metadata: { tokenType: "output" },
    });
    // Sonnet output: $15 / 1M.
    expect(estimate?.costUsd).toBeCloseTo(15, 6);
    expect(estimate?.pricingKey).toBe("claude-sonnet-4-5");
    expect(estimate?.incomplete).toBe(false);
  });

  it("falls back to the input-rate floor and flags incomplete when tokenType is absent", () => {
    const estimate = deriveEventCostEstimate({
      metricType: "usage",
      unit: "token",
      quantity: 1_000_000,
      keyRef: "claude-sonnet-4-5",
    });
    expect(estimate?.costUsd).toBeCloseTo(3, 6);
    expect(estimate?.incomplete).toBe(true);
  });

  it("resolves provider-prefixed keyRefs", () => {
    const estimate = deriveEventCostEstimate({
      metricType: "usage",
      unit: "token",
      quantity: 1_000_000,
      keyRef: "openrouter/anthropic/claude-sonnet-4-5",
      metadata: { tokenType: "input" },
    });
    expect(estimate?.pricingKey).toBe("claude-sonnet-4-5");
    expect(estimate?.incomplete).toBe(false);
  });

  it("returns null when the event already carries a producer cost", () => {
    expect(
      deriveEventCostEstimate({
        metricType: "usage",
        unit: "token",
        quantity: 100,
        costUsd: 0.01,
        keyRef: "gpt-4o",
      })
    ).toBeNull();
  });

  it("returns null for non-token or non-usage events", () => {
    expect(
      deriveEventCostEstimate({ metricType: "usage", unit: "request", quantity: 10, keyRef: "gpt-4o" })
    ).toBeNull();
    expect(
      deriveEventCostEstimate({ metricType: "cost", unit: "token", quantity: 10, keyRef: "gpt-4o" })
    ).toBeNull();
    expect(
      deriveEventCostEstimate({ metricType: "usage", unit: "token", quantity: 10 })
    ).toBeNull();
  });

  it("returns null for unknown models instead of inventing a price", () => {
    expect(
      deriveEventCostEstimate({
        metricType: "usage",
        unit: "token",
        quantity: 1000,
        keyRef: "not-a-real-model-zzz",
      })
    ).toBeNull();
  });

  it("returns null for non-positive quantities", () => {
    expect(
      deriveEventCostEstimate({ metricType: "usage", unit: "token", quantity: 0, keyRef: "gpt-4o" })
    ).toBeNull();
  });
});

describe("applyIngestCostDerivation", () => {
  it("is a no-op when the flag is disabled", () => {
    const events: CostDerivationEvent[] = [
      { metricType: "usage", unit: "token", quantity: 1_000_000, keyRef: "gpt-4o" },
    ];
    expect(applyIngestCostDerivation(events)).toBe(0);
    expect(events[0].metadata).toBeUndefined();
  });

  it("stamps metadata with cost, pricing key, snapshot provenance, and completeness", () => {
    process.env[FLAG] = "true";
    const events: CostDerivationEvent[] = [
      {
        metricType: "usage",
        unit: "token",
        quantity: 1_000_000,
        keyRef: "claude-sonnet-4-5",
        metadata: { tokenType: "input", existing: "kept" },
      },
      { metricType: "usage", unit: "token", quantity: 1_000_000, keyRef: "gpt-4o" },
      { metricType: "usage", unit: "request", quantity: 5, keyRef: "gpt-4o" },
    ];
    expect(applyIngestCostDerivation(events)).toBe(2);

    expect(events[0].metadata?._derivedCostUsd).toBeCloseTo(3, 6);
    expect(events[0].metadata?._derivedCostPricingKey).toBe("claude-sonnet-4-5");
    expect(events[0].metadata?._derivedCostSnapshot).toBe(PRICING_SNAPSHOT_META.fetchedAt);
    expect(events[0].metadata?._derivedCostIncomplete).toBeUndefined();
    expect(events[0].metadata?.existing).toBe("kept");

    // No tokenType -> input-rate floor, flagged incomplete.
    expect(events[1].metadata?._derivedCostIncomplete).toBe(true);

    // Non-token event untouched.
    expect(events[2].metadata).toBeUndefined();
  });
});

describe("deriveEventCostEstimate with canonical AI tokens (UM-1592)", () => {
  it("prices every canonical bucket, 1-hour cache writes included", () => {
    const estimate = deriveEventCostEstimate({
      metricType: "usage",
      unit: "token",
      quantity: 5_000_000,
      keyRef: "configured-key-not-a-model",
      metadata: {
        _aiModelServed: "claude-sonnet-4-5",
        _aiTokensInput: 1_000_000,
        _aiTokensOutput: 1_000_000,
        _aiTokensCacheRead: 1_000_000,
        _aiTokensCacheWrite5m: 1_000_000,
        _aiTokensCacheWrite1h: 1_000_000,
        _aiTokensReasoning: 900_000,
      },
    });
    // Sonnet 4.5: $3 in + $15 out + $0.30 cache read + $3.75 5m write + $6 1h write.
    // Reasoning is inside output and is not priced again.
    expect(estimate?.costUsd).toBeCloseTo(28.05, 6);
    expect(estimate?.pricingKey).toBe("claude-sonnet-4-5");
    expect(estimate?.incomplete).toBe(false);
  });

  it("falls back to the requested model, then keyRef", () => {
    expect(deriveEventCostEstimate({
      metricType: "usage",
      metadata: { _aiModelRequested: "claude-sonnet-4-5", _aiTokensOutput: 1_000_000 },
    })?.costUsd).toBeCloseTo(15, 6);
    expect(deriveEventCostEstimate({
      metricType: "usage",
      keyRef: "claude-sonnet-4-5",
      metadata: { _aiTokensInput: 1_000_000 },
    })?.costUsd).toBeCloseTo(3, 6);
  });

  it("does not require unit token once canonical tokens exist", () => {
    expect(deriveEventCostEstimate({
      metricType: "usage",
      unit: "request",
      quantity: 1,
      metadata: { _aiModelServed: "claude-sonnet-4-5", _aiTokensInput: 1_000_000 },
    })?.costUsd).toBeCloseTo(3, 6);
  });

  it("flags incomplete when the catalog lacks the 1-hour rate", () => {
    const estimate = deriveEventCostEstimate({
      metricType: "usage",
      metadata: { _aiModelServed: "gpt-4o", _aiTokensInput: 1_000_000, _aiTokensCacheWrite1h: 1_000 },
    });
    expect(estimate?.incomplete).toBe(true);
  });

  it("still skips producer-priced, non-usage, unknown-model and empty events", () => {
    const metadata = { _aiModelServed: "claude-sonnet-4-5", _aiTokensInput: 10 };
    expect(deriveEventCostEstimate({ metricType: "usage", costUsd: 1, metadata })).toBeNull();
    expect(deriveEventCostEstimate({ metricType: "cost", metadata })).toBeNull();
    expect(deriveEventCostEstimate({
      metricType: "usage",
      metadata: { _aiModelServed: "no-such-model-xyz", _aiTokensInput: 10 },
    })).toBeNull();
    expect(deriveEventCostEstimate({
      metricType: "usage",
      metadata: { _aiModelServed: "claude-sonnet-4-5", _aiTokensInput: 0, _aiTokensReasoning: 50 },
    })).toBeNull();
  });
});
