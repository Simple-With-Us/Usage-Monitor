import { describe, expect, it } from "vitest";
import {
  accountStatusLabel,
  deriveAccountStatus,
  spendAmountClass,
  statusBadgeClasses,
} from "@/lib/ui-status";

describe("deriveAccountStatus", () => {
  it("returns ok when under budget with no alerts", () => {
    expect(
      deriveAccountStatus({
        criticalCount: 0,
        warningCount: 0,
        incompleteCostCount: 0,
        totalSpentUsd: 40,
        totalBudgetUsd: 100,
      })
    ).toBe("ok");
  });

  it("returns warning at 80% spend", () => {
    expect(
      deriveAccountStatus({
        criticalCount: 0,
        warningCount: 0,
        incompleteCostCount: 0,
        totalSpentUsd: 80,
        totalBudgetUsd: 100,
      })
    ).toBe("warning");
  });

  it("returns exceeded at or over budget", () => {
    expect(
      deriveAccountStatus({
        criticalCount: 0,
        warningCount: 0,
        incompleteCostCount: 0,
        totalSpentUsd: 100,
        totalBudgetUsd: 100,
      })
    ).toBe("exceeded");
  });

  it("returns unconfigured when no budget", () => {
    expect(
      deriveAccountStatus({
        criticalCount: 0,
        warningCount: 0,
        incompleteCostCount: 0,
        totalSpentUsd: 12,
        totalBudgetUsd: null,
      })
    ).toBe("unconfigured");
  });

  it("escalates on critical alerts even under budget", () => {
    expect(
      deriveAccountStatus({
        criticalCount: 1,
        warningCount: 0,
        incompleteCostCount: 0,
        totalSpentUsd: 10,
        totalBudgetUsd: 100,
      })
    ).toBe("exceeded");
  });
});

describe("spendAmountClass", () => {
  it("uses neutral color when on track and complete", () => {
    expect(spendAmountClass("ok", false)).toContain("text-gray-900");
    expect(spendAmountClass("ok", false)).not.toContain("amber");
  });

  it("uses amber when coverage is incomplete", () => {
    expect(spendAmountClass("ok", true)).toContain("amber");
  });

  it("uses red when exceeded", () => {
    expect(spendAmountClass("exceeded", false)).toContain("red");
  });
});

describe("accountStatusLabel", () => {
  it("maps statuses to glance labels", () => {
    expect(accountStatusLabel("ok")).toBe("On track");
    expect(accountStatusLabel("warning")).toBe("Watch spend");
    expect(accountStatusLabel("exceeded")).toBe("Over budget");
    expect(accountStatusLabel("unconfigured")).toBe("No budget set");
  });
});

describe("statusBadgeClasses", () => {
  it("uses slate for incomplete (not brand orange)", () => {
    expect(statusBadgeClasses("incomplete")).toContain("slate");
    expect(statusBadgeClasses("incomplete")).not.toContain("orange");
  });
});
