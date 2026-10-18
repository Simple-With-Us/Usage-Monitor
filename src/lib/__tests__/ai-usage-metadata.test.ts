import { describe, expect, it } from "vitest";

import {
  AI_METADATA_KEYS,
  aiBlockMetadata,
  aiRequestFromUsageEvent,
  canonicalAiMetadata,
  hasCanonicalAiMetadata,
  legacyAiTokens,
  readCanonicalAiModel,
  readCanonicalAiTokens,
  withoutCanonicalAiMetadata,
} from "../ai-usage-metadata";

describe("aiBlockMetadata", () => {
  it("projects every ai block field onto the reserved keys", () => {
    expect(aiBlockMetadata({
      model: { requested: "sonnet", served: "claude-sonnet-4-5" },
      harness: "botfleet",
      seat: "CLAUDE",
      tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite5m: 4, cacheWrite1h: 5, reasoning: 1 },
      durationMs: 900,
      ttftMs: 120,
      billingMode: "subscription",
      costSource: "estimated",
    })).toEqual({
      _aiModelRequested: "sonnet",
      _aiModelServed: "claude-sonnet-4-5",
      _aiHarness: "botfleet",
      _aiSeat: "CLAUDE",
      _aiTokensInput: 1,
      _aiTokensOutput: 2,
      _aiTokensCacheRead: 3,
      _aiTokensCacheWrite5m: 4,
      _aiTokensCacheWrite1h: 5,
      _aiTokensReasoning: 1,
      _aiDurationMs: 900,
      _aiTtftMs: 120,
      _aiBillingMode: "subscription",
      _aiCostSource: "estimated",
      _aiSource: "block",
    });
  });
});

describe("legacyAiTokens", () => {
  it("maps Socratic-Trade promptTokens/completionTokens", () => {
    expect(legacyAiTokens({ metadata: { promptTokens: 100, completionTokens: 20 } }))
      .toEqual({ input: 100, output: 20 });
  });

  it("maps Congress.Trade keys, removing cache subsets from promptTokens", () => {
    expect(legacyAiTokens({
      metadata: {
        promptTokens: 1000,
        completionTokens: 50,
        cachedTokens: 600,
        cacheWriteTokens: 100,
        cacheWriteOneHourTokens: 200,
      },
    })).toEqual({ input: 100, output: 50, cacheRead: 600, cacheWrite5m: 100, cacheWrite1h: 200 });
  });

  it("maps BotFleet turn keys when there is no slice", () => {
    expect(legacyAiTokens({ metadata: { inputTokens: 500, outputTokens: 40, cachedInputTokens: 300 } }))
      .toEqual({ input: 200, output: 40, cacheRead: 300 });
  });

  it("uses only the slice quantity on a BotFleet tokenType slice", () => {
    const metadata = { inputTokens: 500, outputTokens: 40, cachedInputTokens: 300, tokenType: "cacheRead" };
    expect(legacyAiTokens({ unit: "token", quantity: 300, metadata })).toEqual({ cacheRead: 300 });
  });

  it("maps collector and OTLP slices by tokenType or token:<type> label", () => {
    expect(legacyAiTokens({ unit: "token", quantity: 7, metadata: { tokenType: "output" } }))
      .toEqual({ output: 7 });
    expect(legacyAiTokens({ unit: "token", quantity: 9, label: "token:cacheCreation" }))
      .toEqual({ cacheWrite5m: 9 });
  });

  it("routes 1-hour cache-write slices to cacheWrite1h", () => {
    expect(legacyAiTokens({ unit: "token", quantity: 4, metadata: { tokenType: "cacheWrite1h" } }))
      .toEqual({ cacheWrite1h: 4 });
    expect(legacyAiTokens({ unit: "token", quantity: 4, metadata: { tokenType: "cacheCreation", cacheTtl: "1h" } }))
      .toEqual({ cacheWrite1h: 4 });
  });

  it("ignores unknown or empty slices and events without token data", () => {
    expect(legacyAiTokens({ unit: "token", quantity: 0, metadata: { tokenType: "unknown" } })).toBeNull();
    expect(legacyAiTokens({ unit: "token", quantity: 0, metadata: { tokenType: "input" } })).toBeNull();
    expect(legacyAiTokens({ unit: "request", quantity: 5, metadata: { tokenType: "input" } })).toBeNull();
    expect(legacyAiTokens({ metadata: { model: "gpt-4o" } })).toBeNull();
    expect(legacyAiTokens({})).toBeNull();
  });

  it("never produces negative input", () => {
    expect(legacyAiTokens({ metadata: { promptTokens: 10, cachedTokens: 50 } })?.input).toBe(0);
  });
});

describe("canonicalAiMetadata", () => {
  it("lets the typed block win over legacy keys", () => {
    const out = canonicalAiMetadata({
      metadata: { promptTokens: 999 },
      ai: { tokens: { input: 1 } },
    });
    expect(out).toEqual({ _aiTokensInput: 1, _aiSource: "block" });
  });

  it("carries the legacy model and latency with legacy tokens", () => {
    expect(canonicalAiMetadata({
      metadata: { promptTokens: 10, completionTokens: 5, model: "gpt-4o", latencyMs: 250 },
    })).toEqual({
      _aiTokensInput: 10,
      _aiTokensOutput: 5,
      _aiModelServed: "gpt-4o",
      _aiDurationMs: 250,
      _aiSource: "legacy",
    });
  });

  it("carries collector context keys and the output slice's reasoning share", () => {
    expect(canonicalAiMetadata({
      unit: "token",
      quantity: 80,
      label: "token:output",
      metadata: {
        tokenType: "output",
        reasoningTokens: 30,
        harness: "clutch",
        billingMode: "subscription",
        durationMs: 1200,
        model: "deepseek-v4",
      },
    })).toEqual({
      _aiTokensOutput: 80,
      _aiTokensReasoning: 30,
      _aiModelServed: "deepseek-v4",
      _aiDurationMs: 1200,
      _aiHarness: "clutch",
      _aiBillingMode: "subscription",
      _aiSource: "legacy",
    });
    expect(canonicalAiMetadata({ metadata: { promptTokens: 1, billingMode: "estimated" } }))
      .toEqual({ _aiTokensInput: 1, _aiSource: "legacy" });
  });

  it("returns null for non-AI events", () => {
    expect(canonicalAiMetadata({ metadata: { model: "gpt-4o", latencyMs: 5 } })).toBeNull();
  });
});

describe("reading persisted canonical metadata", () => {
  it("reads tokens and the pricing model back", () => {
    const metadata = { _aiTokensInput: 5, _aiTokensCacheWrite1h: 2, _aiModelRequested: "a", other: 1 };
    expect(readCanonicalAiTokens(metadata)).toEqual({ input: 5, cacheWrite1h: 2 });
    expect(readCanonicalAiModel(metadata)).toBe("a");
    expect(readCanonicalAiModel({ ...metadata, _aiModelServed: "b" })).toBe("b");
    expect(readCanonicalAiTokens({ other: 1 })).toBeNull();
    expect(readCanonicalAiTokens(undefined)).toBeNull();
  });

  it("detects and strips the projection", () => {
    expect(hasCanonicalAiMetadata({ [AI_METADATA_KEYS.source]: "legacy" })).toBe(true);
    expect(hasCanonicalAiMetadata({ promptTokens: 1 })).toBe(false);
    expect(hasCanonicalAiMetadata(null)).toBe(false);
    expect(withoutCanonicalAiMetadata({ promptTokens: 1, _aiTokensInput: 1, _aiSource: "legacy" }))
      .toEqual({ promptTokens: 1 });
    expect(withoutCanonicalAiMetadata({ _aiSource: "legacy" })).toBeNull();
  });
});

describe("aiRequestFromUsageEvent", () => {
  const occurredAt = new Date("2026-10-17T00:00:00.000Z");

  it("builds a per-request row from block metadata", () => {
    expect(aiRequestFromUsageEvent({
      idempotencyKey: "k1",
      sourceApp: "socratic-trade",
      project: "st",
      costUsd: 0.5,
      occurredAt,
      metadata: { _aiSource: "block", _aiTokensInput: 3, _aiTokensCacheWrite1h: 2, _aiTtftMs: 10.6 },
    })).toMatchObject({
      dedupeKey: "ingest:k1",
      source: "ingest",
      harness: "socratic-trade",
      project: "st",
      inputTokens: 3,
      cacheWriteTokens: 2,
      cacheWrite1hTokens: 2,
      ttftMs: 11,
      costUsd: 0.5,
      occurredAt,
    });
  });

  it("skips run and window summaries", () => {
    const block = { _aiSource: "block", _aiTokensInput: 1 };
    const base = { idempotencyKey: "k4", sourceApp: "x", occurredAt, metadata: block };
    expect(aiRequestFromUsageEvent({ ...base, requests: 1 })).not.toBeNull();
    expect(aiRequestFromUsageEvent({ ...base, requests: 0 })).toBeNull();
    expect(aiRequestFromUsageEvent({ ...base, requests: 12 })).toBeNull();
    expect(aiRequestFromUsageEvent({ ...base, windowStart: occurredAt })).toBeNull();
    expect(aiRequestFromUsageEvent({ ...base, windowEnd: occurredAt })).toBeNull();
  });

  it("skips legacy-mapped and non-AI events", () => {
    expect(aiRequestFromUsageEvent({
      idempotencyKey: "k2", sourceApp: "x", occurredAt, metadata: { _aiSource: "legacy", _aiTokensInput: 1 },
    })).toBeNull();
    expect(aiRequestFromUsageEvent({ idempotencyKey: "k3", sourceApp: "x", occurredAt })).toBeNull();
  });
});
