import { describe, it, expect } from "vitest";
import {
  buildLlmBurnReport,
  DEFAULT_WINDOW_HOURS,
  MAX_WINDOW_HOURS,
  MIN_ACTIVE_MINUTES,
  monthStartUtc,
  tokenTypeFromLabel,
} from "../llm-burn";

// Fixed mid-month clock: 2026-07-16T12:00Z. July has 31 days, so the elapsed
// month fraction is exactly 15.5/31 = 0.5 — pace expectations halve budgets.
const NOW = new Date("2026-07-16T12:00:00Z");
const HOURS_MS = 3_600_000;

const baseInput = {
  now: NOW,
  windowTokenGroups: [],
  windowCostGroups: [],
  windowActivity: [],
  mtdTokenGroups: [],
  mtdCostGroups: [],
  budgets: [],
};

describe("monthStartUtc / tokenTypeFromLabel", () => {
  it("uses UTC month boundaries (budget-status convention)", () => {
    expect(monthStartUtc(NOW).toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(monthStartUtc(new Date("2026-01-31T23:59:00Z")).toISOString()).toBe(
      "2026-01-01T00:00:00.000Z"
    );
  });

  it("extracts claude-code token types and buckets everything else unknown", () => {
    expect(tokenTypeFromLabel("token:input")).toBe("input");
    expect(tokenTypeFromLabel("token:cacheRead")).toBe("cacheRead");
    expect(tokenTypeFromLabel("chat-completion")).toBe("unknown");
    expect(tokenTypeFromLabel(null)).toBe("unknown");
  });
});

describe("buildLlmBurnReport window burn", () => {
  it("derives window cost from typed tokens for any priced platform", () => {
    const report = buildLlmBurnReport({
      ...baseInput,
      windowTokenGroups: [
        { provider: "anthropic", model: "claude-sonnet-4-5", tokenType: "input", quantity: 1_000_000 },
        { provider: "anthropic", model: "claude-sonnet-4-5", tokenType: "output", quantity: 100_000 },
        { provider: "openai", model: "openai/gpt-4o", tokenType: "input", quantity: 2_000_000 },
        { provider: "openai", model: "openai/gpt-4o", tokenType: "output", quantity: 200_000 },
      ],
    });
    const anthropic = report.providers.find((p) => p.provider === "anthropic")!;
    const openai = report.providers.find((p) => p.provider === "openai")!;
    // anthropic: $3 (1M input) + $1.50 (100k output)
    expect(anthropic.window.derivedCostUsd).toBeCloseTo(4.5, 6);
    // openai: $5 (2M input) + $2 (200k output) — provider prefix stripped
    expect(openai.window.derivedCostUsd).toBeCloseTo(7, 6);
    expect(openai.window.derivationComplete).toBe(true);
    expect(anthropic.window.tokens.total).toBe(1_100_000);
  });

  it("estimate is max(reported, derived) — recorded wins, never double-counted", () => {
    const report = buildLlmBurnReport({
      ...baseInput,
      windowTokenGroups: [
        { provider: "anthropic", model: "claude-sonnet-4-5", tokenType: "input", quantity: 1_000_000 },
        { provider: "openai", model: "gpt-4o", tokenType: "input", quantity: 40_000 },
      ],
      windowCostGroups: [
        { provider: "anthropic", costUsd: 10 }, // reported > derived ($3)
        { provider: "openai", costUsd: 0.05 }, // derived ($0.10) > reported
      ],
    });
    const anthropic = report.providers.find((p) => p.provider === "anthropic")!;
    const openai = report.providers.find((p) => p.provider === "openai")!;
    expect(anthropic.window.estimateUsd).toBeCloseTo(10, 6);
    expect(openai.window.estimateUsd).toBeCloseTo(0.1, 6);
  });

  it("computes burn rate from elapsed activity, clamped to the window", () => {
    const report = buildLlmBurnReport({
      ...baseInput,
      windowTokenGroups: [
        { provider: "anthropic", model: "claude-sonnet-4-5", tokenType: "input", quantity: 600_000 },
      ],
      windowCostGroups: [{ provider: "anthropic", costUsd: 6 }],
      windowActivity: [
        {
          provider: "anthropic",
          firstOccurredAt: new Date(NOW.getTime() - 2 * HOURS_MS),
          lastOccurredAt: new Date(NOW.getTime() - 10 * 60_000),
          eventCount: 42,
        },
      ],
    });
    const provider = report.providers[0];
    expect(provider.window.activeMinutes).toBe(120);
    expect(provider.window.eventCount).toBe(42);
    expect(provider.window.usdPerHour).toBeCloseTo(3, 6); // $6 over 2h
    expect(provider.window.tokensPerHour).toBeCloseTo(300_000, 6);
  });

  it("clamps a single fresh event to MIN_ACTIVE_MINUTES so rates stay sane", () => {
    const report = buildLlmBurnReport({
      ...baseInput,
      windowCostGroups: [{ provider: "openai", costUsd: 1 }],
      windowActivity: [
        {
          provider: "openai",
          firstOccurredAt: new Date(NOW.getTime() - 2 * 60_000),
          lastOccurredAt: new Date(NOW.getTime() - 2 * 60_000),
          eventCount: 1,
        },
      ],
    });
    expect(report.providers[0].window.activeMinutes).toBe(MIN_ACTIVE_MINUTES);
    expect(report.providers[0].window.usdPerHour).toBeCloseTo(4, 6); // $1 per 15min
  });

  it("prices unknown token types at the input-rate floor and flags incomplete", () => {
    const report = buildLlmBurnReport({
      ...baseInput,
      windowTokenGroups: [
        { provider: "deepseek", model: "deepseek-chat", tokenType: "unknown", quantity: 1_000_000 },
      ],
    });
    const provider = report.providers[0];
    // floor = 1M x $0.28/M input rate; output rate is higher, so never over
    expect(provider.window.derivedCostUsd).toBeCloseTo(0.28, 6);
    expect(provider.window.derivationComplete).toBe(false);
    expect(provider.window.tokens.unknown).toBe(1_000_000);
  });

  it("counts tokens for unpriced models but derives zero and flags incomplete", () => {
    const report = buildLlmBurnReport({
      ...baseInput,
      windowTokenGroups: [
        { provider: "newlab", model: "brand-new-model-x", tokenType: "input", quantity: 5000 },
      ],
    });
    const provider = report.providers[0];
    expect(provider.window.tokens.total).toBe(5000);
    expect(provider.window.derivedCostUsd).toBe(0);
    expect(provider.window.derivationComplete).toBe(false);
  });

  it("clamps the window hours parameter to [1, MAX_WINDOW_HOURS]", () => {
    const tooBig = buildLlmBurnReport({ ...baseInput, windowHours: 99 });
    expect(tooBig.windowHours).toBe(MAX_WINDOW_HOURS);
    const tooSmall = buildLlmBurnReport({ ...baseInput, windowHours: 0 });
    expect(tooSmall.windowHours).toBe(1);
    const defaulted = buildLlmBurnReport(baseInput);
    expect(defaulted.windowHours).toBe(DEFAULT_WINDOW_HOURS);
  });
});

describe("buildLlmBurnReport budget pace", () => {
  const mtdInput = {
    ...baseInput,
    mtdTokenGroups: [
      { provider: "anthropic", model: "claude-sonnet-4-5", tokenType: "input", quantity: 10_000_000 },
    ],
    mtdCostGroups: [{ provider: "anthropic", costUsd: 40 }], // estimate = max(40, 30) = 40
  };

  it("matches budgets case-insensitively and prorates to elapsed month", () => {
    const report = buildLlmBurnReport({
      ...mtdInput,
      budgets: [{ providerName: "Anthropic", monthlyBudgetUsd: 100 }],
    });
    const provider = report.quietProviders[0];
    expect(provider.monthToDate.estimateUsd).toBeCloseTo(40, 6);
    // fraction elapsed is exactly 0.5 with the fixed clock
    expect(report.monthElapsedFraction).toBeCloseTo(0.5, 6);
    expect(provider.budget.expectedByNowUsd).toBeCloseTo(50, 6);
    expect(provider.budget.paceRatio).toBeCloseTo(0.8, 6);
    expect(provider.budget.status).toBe("on-pace");
    expect(provider.budget.projectedMonthEndUsd).toBeCloseTo(80, 6);
  });

  it("flags over-pace and watch bands", () => {
    const report = buildLlmBurnReport({
      ...mtdInput,
      mtdCostGroups: [{ provider: "anthropic", costUsd: 60 }],
      budgets: [{ providerName: "anthropic", monthlyBudgetUsd: 100 }],
    });
    expect(report.quietProviders[0].budget.status).toBe("over-pace"); // 60/50 = 1.2
    const watch = buildLlmBurnReport({
      ...mtdInput,
      mtdCostGroups: [{ provider: "anthropic", costUsd: 52 }],
      budgets: [{ providerName: "anthropic", monthlyBudgetUsd: 100 }],
    });
    expect(watch.quietProviders[0].budget.status).toBe("watch"); // 52/50 = 1.04
  });

  it("reports no-budget status and null pace fields without a budget row", () => {
    const report = buildLlmBurnReport(mtdInput);
    const provider = report.quietProviders[0];
    expect(provider.budget.status).toBe("no-budget");
    expect(provider.budget.paceRatio).toBeNull();
    expect(provider.budget.projectedMonthEndUsd).toBeNull();
    expect(provider.budget.expectedByNowUsd).toBeNull();
  });

  it("withholds the linear projection in the first days of a month", () => {
    const early = new Date("2026-07-01T06:00:00Z"); // ~0.8% elapsed
    const report = buildLlmBurnReport({
      ...mtdInput,
      now: early,
      budgets: [{ providerName: "anthropic", monthlyBudgetUsd: 100 }],
    });
    const provider = report.quietProviders[0];
    expect(provider.budget.projectedMonthEndUsd).toBeNull();
    expect(provider.budget.paceRatio).not.toBeNull(); // pace still computable
  });
});

describe("buildLlmBurnReport provider partitioning", () => {
  it("splits active vs quiet providers and sorts active by window pressure", () => {
    const report = buildLlmBurnReport({
      ...baseInput,
      windowTokenGroups: [
        { provider: "openai", model: "gpt-4o", tokenType: "input", quantity: 2_000_000 }, // $5
      ],
      windowCostGroups: [{ provider: "anthropic", costUsd: 12 }],
      windowActivity: [
        {
          provider: "anthropic",
          firstOccurredAt: new Date(NOW.getTime() - HOURS_MS),
          lastOccurredAt: NOW,
          eventCount: 3,
        },
        {
          provider: "openai",
          firstOccurredAt: new Date(NOW.getTime() - HOURS_MS),
          lastOccurredAt: NOW,
          eventCount: 9,
        },
      ],
      mtdCostGroups: [
        { provider: "anthropic", costUsd: 12 },
        { provider: "openai", costUsd: 20 },
        { provider: "xai", costUsd: 7 }, // MTD only — quiet
      ],
    });
    expect(report.providers.map((p) => p.provider)).toEqual(["anthropic", "openai"]);
    expect(report.quietProviders.map((p) => p.provider)).toEqual(["xai"]);
    expect(report.quietProviders[0].window.eventCount).toBe(0);
    expect(report.quietProviders[0].window.usdPerHour).toBe(0);
  });

  it("skips non-positive quantities and zero costs defensively", () => {
    const report = buildLlmBurnReport({
      ...baseInput,
      windowTokenGroups: [
        { provider: "openai", model: "gpt-4o", tokenType: "input", quantity: -5 },
        { provider: "openai", model: "gpt-4o", tokenType: "input", quantity: Number.NaN },
      ],
      windowCostGroups: [{ provider: "openai", costUsd: 0 }],
    });
    expect(report.providers).toHaveLength(0);
    expect(report.quietProviders).toHaveLength(0);
  });
});
