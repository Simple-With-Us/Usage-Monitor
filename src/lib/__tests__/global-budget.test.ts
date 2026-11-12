import { describe, expect, it } from "vitest";
import {
  parseGlobalBudgetBody,
  resolveGlobalBudget,
} from "@/lib/global-budget";

describe("resolveGlobalBudget", () => {
  it("uses override when set", () => {
    const snap = resolveGlobalBudget({
      overrideUsd: 500,
      projectBudgets: [100, 200],
    });
    expect(snap.globalBudgetSource).toBe("override");
    expect(snap.effectiveGlobalBudgetUsd).toBe(500);
    expect(snap.suggestedGlobalBudgetUsd).toBe(300);
    expect(snap.projectBudgetCount).toBe(2);
  });

  it("falls back to sum of project budgets", () => {
    const snap = resolveGlobalBudget({
      overrideUsd: null,
      projectBudgets: [10, null, 40.5],
    });
    expect(snap.globalBudgetSource).toBe("suggested");
    expect(snap.effectiveGlobalBudgetUsd).toBe(50.5);
    expect(snap.globalMonthlyBudgetUsd).toBeNull();
  });

  it("returns none when empty", () => {
    const snap = resolveGlobalBudget({
      overrideUsd: null,
      projectBudgets: [0, null, -1],
    });
    expect(snap.globalBudgetSource).toBe("none");
    expect(snap.effectiveGlobalBudgetUsd).toBeNull();
  });
});

describe("parseGlobalBudgetBody", () => {
  it("accepts null clear", () => {
    expect(parseGlobalBudgetBody({ globalMonthlyBudgetUsd: null })).toEqual({
      ok: true,
      value: null,
    });
  });

  it("accepts positive numbers", () => {
    expect(parseGlobalBudgetBody({ globalMonthlyBudgetUsd: "99.5" })).toEqual({
      ok: true,
      value: 99.5,
    });
  });

  it("rejects negatives", () => {
    expect(parseGlobalBudgetBody({ globalMonthlyBudgetUsd: -1 }).ok).toBe(false);
  });
});
