import { afterEach, describe, expect, it } from "vitest";
import {
  budgetAutoControlsEnabled,
  budgetPollingPaused,
  decideBudgetControlAction,
  readBudgetControlConfig,
  type BudgetControlConfig,
  type BudgetControlObservation,
  type BudgetControlProviderState,
} from "@/lib/budget-controls";

// Pure, deterministic tests for the budget-control decision layer. No DB, no
// wall clock, no randomness — every case injects `now` and feeds the decider's
// own next-state back in to simulate consecutive scheduler observations. This
// is where the hysteresis / anti-flap / reversibility invariants are proven.

const PERIOD = new Date("2026-03-01T00:00:00.000Z");
const NOW = new Date("2026-03-10T00:00:00.000Z");

function config(overrides: Partial<BudgetControlConfig> = {}): BudgetControlConfig {
  return {
    masterEnabled: true,
    breachTicks: 3,
    breachMarginRatio: 1.0,
    resumeMarginRatio: 0.9,
    cooldownMs: 0,
    ...overrides,
  };
}

function state(
  overrides: Partial<BudgetControlProviderState> = {}
): BudgetControlProviderState {
  return {
    budgetControlsEnabled: true,
    budgetBreachState: "ok",
    budgetBreachStreak: 0,
    budgetControlPeriodStart: PERIOD,
    budgetPausedAt: null,
    budgetPauseReason: null,
    budgetPauseThresholdUsd: null,
    budgetPauseObservedSpendUsd: null,
    budgetControlLastActionAt: null,
    keyDisableRecommended: false,
    ...overrides,
  };
}

function obs(spentUsd: number, monthlyBudgetUsd: number | null = 50): BudgetControlObservation {
  return { spentUsd, monthlyBudgetUsd };
}

describe("decideBudgetControlAction — gating", () => {
  it("is a no-op when the master flag is off, even with spend over budget", () => {
    const decision = decideBudgetControlAction(
      state(),
      obs(100, 50),
      config({ masterEnabled: false }),
      NOW
    );
    expect(decision.changed).toBe(false);
    expect(decision.events).toHaveLength(0);
    expect(decision.next.budgetPausedAt).toBeNull();
  });

  it("is a no-op for a clean provider that has not opted in", () => {
    const decision = decideBudgetControlAction(
      state({ budgetControlsEnabled: false }),
      obs(100, 50),
      config(),
      NOW
    );
    expect(decision.changed).toBe(false);
    expect(decision.paused).toBe(false);
  });

  it("reverts a prior pause when the provider opts out (resume_controls_disabled)", () => {
    const decision = decideBudgetControlAction(
      state({
        budgetControlsEnabled: false,
        budgetBreachState: "paused",
        budgetPausedAt: new Date("2026-03-05T00:00:00.000Z"),
        keyDisableRecommended: true,
        budgetPauseThresholdUsd: 50,
      }),
      obs(100, 50),
      config(),
      NOW
    );
    expect(decision.changed).toBe(true);
    expect(decision.resumed).toBe(true);
    expect(decision.recommendationCleared).toBe(true);
    expect(decision.next.budgetPausedAt).toBeNull();
    expect(decision.next.budgetBreachState).toBe("ok");
    expect(decision.next.keyDisableRecommended).toBe(false);
    expect(decision.events.map((e) => e.action)).toEqual([
      "resume_controls_disabled",
    ]);
  });
});

describe("decideBudgetControlAction — hysteresis (advisory only)", () => {
  it("recommends key-disable on the Nth consecutive breach without auto-pausing", () => {
    const cfg = config({ breachTicks: 3 });
    let current = state();

    // Tick 1 — first breach: latched as "breached", NOT paused.
    let d = decideBudgetControlAction(current, obs(60, 50), cfg, NOW);
    expect(d.paused).toBe(false);
    expect(d.next.budgetBreachState).toBe("breached");
    expect(d.next.budgetBreachStreak).toBe(1);
    expect(d.events.map((e) => e.action)).toEqual(["breach_observed"]);
    current = d.next;

    // Tick 2 — still breached, still not paused, no duplicate breach_observed.
    d = decideBudgetControlAction(current, obs(60, 50), cfg, NOW);
    expect(d.paused).toBe(false);
    expect(d.next.budgetBreachStreak).toBe(2);
    expect(d.events).toHaveLength(0);
    current = d.next;

    // Tick 3 — sustained breach: RECOMMEND only (never auto-pause).
    d = decideBudgetControlAction(current, obs(60, 50), cfg, NOW);
    expect(d.paused).toBe(false);
    expect(d.next.budgetBreachState).toBe("breached");
    expect(d.next.budgetPausedAt).toBeNull();
    expect(d.recommendationRaised).toBe(true);
    expect(d.next.keyDisableRecommended).toBe(true);
    expect(d.events.map((e) => e.action)).toEqual(["recommend_key_disable"]);
  });

  it("records the threshold, observed spend, and raises the key-disable recommendation", () => {
    const cfg = config({ breachTicks: 1, breachMarginRatio: 1.0 });
    const d = decideBudgetControlAction(state(), obs(75, 50), cfg, NOW);
    expect(d.paused).toBe(false);
    expect(d.recommendationRaised).toBe(true);
    expect(d.next.budgetPauseThresholdUsd).toBe(50);
    expect(d.next.budgetPauseObservedSpendUsd).toBe(75);
    expect(d.next.keyDisableRecommended).toBe(true);
    const recommend = d.events.find((e) => e.action === "recommend_key_disable");
    expect(recommend?.reason).toContain("RECOMMENDATION ONLY");
    expect(recommend?.reason).toContain("No credential was modified");
    expect(recommend?.reason).toContain("NOT auto-paused");
  });

  it("respects a breach margin above the budget line before recommending", () => {
    // margin 1.2 => threshold = 60; spend 55 is over budget but under threshold.
    const cfg = config({ breachTicks: 1, breachMarginRatio: 1.2 });
    const d = decideBudgetControlAction(state(), obs(55, 50), cfg, NOW);
    expect(d.paused).toBe(false);
    expect(d.next.budgetBreachState).toBe("ok");
  });

  it("clears partial hysteresis progress if the breach resolves before recommendation", () => {
    const cfg = config({ breachTicks: 3 });
    const breached = state({ budgetBreachState: "breached", budgetBreachStreak: 2 });
    const d = decideBudgetControlAction(breached, obs(40, 50), cfg, NOW);
    expect(d.paused).toBe(false);
    expect(d.next.budgetBreachState).toBe("ok");
    expect(d.next.budgetBreachStreak).toBe(0);
    expect(d.events.map((e) => e.action)).toEqual(["breach_cleared"]);
  });
});

describe("decideBudgetControlAction — manual pause holds / period roll", () => {
  const paused = () =>
    state({
      budgetBreachState: "paused",
      budgetBreachStreak: 3,
      budgetPausedAt: new Date("2026-03-05T00:00:00.000Z"),
      budgetPauseThresholdUsd: 50,
      budgetPauseObservedSpendUsd: 60,
      keyDisableRecommended: true,
      budgetControlLastActionAt: new Date("2026-03-05T00:00:00.000Z"),
    });

  it("holds an owner-set pause until period roll or opt-out (no auto-resume on spend drop)", () => {
    const d = decideBudgetControlAction(paused(), obs(45, 50), config(), NOW);
    expect(d.resumed).toBe(false);
    expect(d.next.budgetPausedAt).not.toBeNull();
  });

  it("resumes on a UTC budget-period roll and restarts hysteresis for the new period", () => {
    const feb = new Date("2026-02-01T00:00:00.000Z");
    const pausedInFebruary = { ...paused(), budgetControlPeriodStart: feb };
    const stillOver = decideBudgetControlAction(
      pausedInFebruary,
      obs(60, 50),
      config({ breachTicks: 3 }),
      NOW
    );
    expect(stillOver.resumed).toBe(true);
    expect(stillOver.next.budgetPausedAt).toBeNull();
    expect(stillOver.paused).toBe(false);
    expect(stillOver.next.budgetBreachStreak).toBe(1);
    expect(stillOver.next.budgetControlPeriodStart?.getTime()).toBe(
      new Date("2026-03-01T00:00:00.000Z").getTime()
    );
    expect(stillOver.events.map((e) => e.action)).toContain("resume_period_roll");
  });
});

describe("decideBudgetControlAction — cooldown (anti-flap)", () => {
  it("blocks a re-recommendation within the cooldown after a recent action", () => {
    const cfg = config({ breachTicks: 1, cooldownMs: 60 * 60 * 1000 });
    const recentlyActed = state({
      budgetControlLastActionAt: new Date(NOW.getTime() - 1000), // 1s ago
    });
    const d = decideBudgetControlAction(recentlyActed, obs(100, 50), cfg, NOW);
    expect(d.paused).toBe(false);
    expect(d.recommendationRaised).toBe(false);
    expect(d.next.budgetBreachState).toBe("breached");
  });

  it("allows the recommendation once the cooldown has elapsed", () => {
    const cfg = config({ breachTicks: 1, cooldownMs: 60 * 60 * 1000 });
    const longAgo = state({
      budgetControlLastActionAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000), // 2h ago
    });
    const d = decideBudgetControlAction(longAgo, obs(100, 50), cfg, NOW);
    expect(d.paused).toBe(false);
    expect(d.recommendationRaised).toBe(true);
  });
});

describe("readBudgetControlConfig + budgetAutoControlsEnabled", () => {
  it("defaults are safe (off, sane hysteresis) when nothing is set", () => {
    const cfg = readBudgetControlConfig({});
    expect(cfg.masterEnabled).toBe(false);
    expect(cfg.breachTicks).toBe(3);
    expect(cfg.breachMarginRatio).toBe(1.0);
    expect(cfg.resumeMarginRatio).toBe(0.9);
    expect(cfg.cooldownMs).toBe(60 * 60 * 1000);
  });

  it("parses the master flag from true/1/yes and treats everything else as off", () => {
    expect(budgetAutoControlsEnabled({ BUDGET_AUTO_CONTROLS_ENABLED: "true" })).toBe(true);
    expect(budgetAutoControlsEnabled({ BUDGET_AUTO_CONTROLS_ENABLED: "1" })).toBe(true);
    expect(budgetAutoControlsEnabled({ BUDGET_AUTO_CONTROLS_ENABLED: "YES" })).toBe(true);
    expect(budgetAutoControlsEnabled({ BUDGET_AUTO_CONTROLS_ENABLED: "false" })).toBe(false);
    expect(budgetAutoControlsEnabled({ BUDGET_AUTO_CONTROLS_ENABLED: "" })).toBe(false);
    expect(budgetAutoControlsEnabled({})).toBe(false);
  });

  it("falls back to defaults on out-of-range / non-numeric knob values", () => {
    const cfg = readBudgetControlConfig({
      BUDGET_AUTO_CONTROLS_ENABLED: "true",
      BUDGET_CONTROL_BREACH_TICKS: "0", // below min => default
      BUDGET_CONTROL_BREACH_MARGIN_RATIO: "abc", // NaN => default
      BUDGET_CONTROL_RESUME_MARGIN_RATIO: "2", // above max => default
      BUDGET_CONTROL_COOLDOWN_MS: "-5", // below min => default
    });
    expect(cfg.masterEnabled).toBe(true);
    expect(cfg.breachTicks).toBe(3);
    expect(cfg.breachMarginRatio).toBe(1.0);
    expect(cfg.resumeMarginRatio).toBe(0.9);
    expect(cfg.cooldownMs).toBe(60 * 60 * 1000);
  });

  it("accepts valid overrides", () => {
    const cfg = readBudgetControlConfig({
      BUDGET_AUTO_CONTROLS_ENABLED: "true",
      BUDGET_CONTROL_BREACH_TICKS: "5",
      BUDGET_CONTROL_BREACH_MARGIN_RATIO: "1.1",
      BUDGET_CONTROL_RESUME_MARGIN_RATIO: "0.75",
      BUDGET_CONTROL_COOLDOWN_MS: "120000",
    });
    expect(cfg).toEqual({
      masterEnabled: true,
      breachTicks: 5,
      breachMarginRatio: 1.1,
      resumeMarginRatio: 0.75,
      cooldownMs: 120000,
    });
  });
});

describe("budgetPollingPaused (scheduler gate)", () => {
  const on = { BUDGET_AUTO_CONTROLS_ENABLED: "true" };
  const off = {};

  it("returns false whenever the master flag is off, even for a paused opted-in provider", () => {
    expect(
      budgetPollingPaused(
        { budgetControlsEnabled: true, budgetPausedAt: new Date() },
        off
      )
    ).toBe(false);
  });

  it("pauses polling only for an opted-in, paused provider when the flag is on", () => {
    expect(
      budgetPollingPaused(
        { budgetControlsEnabled: true, budgetPausedAt: new Date() },
        on
      )
    ).toBe(true);
    expect(
      budgetPollingPaused(
        { budgetControlsEnabled: false, budgetPausedAt: new Date() },
        on
      )
    ).toBe(false);
    expect(
      budgetPollingPaused(
        { budgetControlsEnabled: true, budgetPausedAt: null },
        on
      )
    ).toBe(false);
  });
});
