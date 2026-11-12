import { describe, expect, it } from "vitest";
import { budgetViewSchema, formatBudgetMicros } from "../view";
import { BUDGET_VIEW } from "./view-fixture";
describe("budget display contract", () => {
  it("keeps null unknown while preserving zero and fractional cents", () => {
    expect(formatBudgetMicros(null)).toBe("Unknown");
    expect(formatBudgetMicros("0")).toBe("$0.00");
    expect(formatBudgetMicros("1")).toBe("$0.000001");
    expect(formatBudgetMicros("500000")).toBe("$0.50");
    expect(formatBudgetMicros("NaN")).toBe("Unknown");
    expect(formatBudgetMicros("9007199254740991")).toBe("$9,007,199,254.740991");
    expect(formatBudgetMicros("9007199254740992")).toBe("Unknown");
  });
  it("rejects missing/duplicate providers or unsafe monetary strings", () => {
    expect(budgetViewSchema.safeParse(BUDGET_VIEW).success).toBe(true);
    const snapshot = BUDGET_VIEW.snapshot;
    expect(budgetViewSchema.safeParse({ ...BUDGET_VIEW, snapshot: { ...snapshot, providerCosts: [snapshot.providerCosts[0], snapshot.providerCosts[0]] } }).success).toBe(false);
    expect(budgetViewSchema.safeParse({ ...BUDGET_VIEW, snapshot: { ...snapshot, reservedPolicyMicros: "-1" } }).success).toBe(false);
  });
  it("rejects unexpected fields at every response boundary", () => {
    const snapshot = BUDGET_VIEW.snapshot;
    expect(budgetViewSchema.safeParse({ ...BUDGET_VIEW, extra: true }).success).toBe(false);
    expect(budgetViewSchema.safeParse({ ...BUDGET_VIEW, snapshot: { ...snapshot, extra: true } }).success).toBe(false);
    expect(budgetViewSchema.safeParse({ ...BUDGET_VIEW, snapshot: { ...snapshot, providerCosts: [{ ...snapshot.providerCosts[0], extra: true }, snapshot.providerCosts[1]] } }).success).toBe(false);
  });
});
