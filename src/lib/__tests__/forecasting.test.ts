import { describe, it, expect } from "vitest";
import {
  calculateEomForecast,
  calculateEomForecastFromSeries,
  forecastMonthlyUsageFromSeries,
  projectBudgetRunout,
} from "../forecasting";

describe("calculateEomForecast", () => {
  it("extrapolates spend based on the day of the month", () => {
    // January 15, noon UTC
    const now = new Date(Date.UTC(2025, 0, 15, 12, 0, 0));
    // 15.5 days into a 31 day month -> exactly half way
    // Usage is 100, fixed is 50. Total spent = 150.
    // Usage should double to 200, fixed remains 50. Total = 250.
    const forecasted = calculateEomForecast(150, 50, now);
    expect(forecasted).toBe(250);
  });

  it("handles the very beginning of the month safely", () => {
    // Jan 1, 00:00 UTC (start of month)
    const now = new Date(Date.UTC(2025, 0, 1, 0, 5, 0));
    // 5 minutes into the month, avoid dividing by near zero
    const forecasted = calculateEomForecast(50, 50, now);
    expect(forecasted).toBe(50);
  });

  it("handles when spentUsd is less than fixed cost (should not happen but safely bounds)", () => {
    const now = new Date(Date.UTC(2025, 0, 15, 12, 0, 0));
    const forecasted = calculateEomForecast(20, 50, now);
    // Usage is max(0, 20 - 50) = 0. Forecast = 50 + 0 = 50.
    expect(forecasted).toBe(50);
  });
});

describe("forecastMonthlyUsageFromSeries (non-linear)", () => {
  // Jan 21 00:00 UTC: 20 complete days elapsed in a 31-day month.
  const now = new Date(Date.UTC(2025, 0, 21, 0, 0, 0));

  it("beats naive linear on an accelerating (curved) series", () => {
    // Daily spend ramps 1,2,...,20 — a rising daily rate the flat-average
    // linear method cannot see.
    const dailyUsage = Array.from({ length: 20 }, (_, i) => i + 1);
    const usageSoFar = dailyUsage.reduce((s, v) => s + v, 0); // 210

    const linearTotal = calculateEomForecast(usageSoFar, 0, now); // flat-rate extrapolation
    const trendTotal = forecastMonthlyUsageFromSeries(dailyUsage, now);
    // Ground truth if the ramp continued (days 21..31 = 21+...+31 = 286).
    const trueTotal = usageSoFar + 286;

    expect(trendTotal).toBeGreaterThan(linearTotal);
    // The trend projection lands far closer to the true continuation.
    expect(Math.abs(trendTotal - trueTotal)).toBeLessThan(Math.abs(linearTotal - trueTotal));
  });

  it("degrades to ~linear on a flat series", () => {
    const dailyUsage = Array.from({ length: 20 }, () => 10);
    const usageSoFar = 200;
    const linearTotal = calculateEomForecast(usageSoFar, 0, now);
    const trendTotal = forecastMonthlyUsageFromSeries(dailyUsage, now);
    // Within a few percent of the linear projection (no spurious curvature).
    expect(Math.abs(trendTotal - linearTotal) / linearTotal).toBeLessThan(0.05);
  });

  it("falls back to exactly linear when history is too short", () => {
    const early = new Date(Date.UTC(2025, 0, 3, 0, 0, 0)); // day 3, only 3 points
    const dailyUsage = [5, 5, 5];
    const trendTotal = forecastMonthlyUsageFromSeries(dailyUsage, early);
    const linearTotal = calculateEomForecast(15, 0, early);
    expect(trendTotal).toBe(linearTotal);
  });

  it("never runs away: a steep slope is clamped to a multiple of linear", () => {
    // Extreme late-month explosion; the clamp caps projection at maxFactor×linear.
    const dailyUsage = Array.from({ length: 20 }, (_, i) => (i >= 18 ? 10_000 : 1));
    const usageSoFar = dailyUsage.reduce((s, v) => s + v, 0);
    const linearTotal = calculateEomForecast(usageSoFar, 0, now);
    const linearRemaining = linearTotal - usageSoFar;
    const trendTotal = forecastMonthlyUsageFromSeries(dailyUsage, now);
    expect(trendTotal - usageSoFar).toBeLessThanOrEqual(linearRemaining * 3 + 1e-6);
  });
});

describe("calculateEomForecastFromSeries (backward-compatible wrapper)", () => {
  const now = new Date(Date.UTC(2025, 0, 21, 0, 0, 0));

  it("reproduces the legacy linear forecast when no series is supplied", () => {
    expect(calculateEomForecastFromSeries(null, 50, now)).toBe(calculateEomForecast(50, 50, now));
    expect(calculateEomForecastFromSeries([], 50, now)).toBe(calculateEomForecast(50, 50, now));
  });

  it("adds the fixed accrued cost on top of the projected usage", () => {
    const dailyUsage = Array.from({ length: 20 }, (_, i) => i + 1);
    const withFixed = calculateEomForecastFromSeries(dailyUsage, 50, now);
    const usageOnly = forecastMonthlyUsageFromSeries(dailyUsage, now);
    expect(withFixed).toBeCloseTo(50 + usageOnly, 6);
  });
});

describe("projectBudgetRunout (S9)", () => {
  it("returns nulls when no budget is configured", () => {
    const now = new Date(Date.UTC(2026, 6, 16, 0, 0, 0));
    expect(
      projectBudgetRunout({ spentUsd: 50, projectedEomUsd: 200, monthlyBudgetUsd: null, now })
    ).toEqual({ runoutDate: null, daysUntilBudgetExhausted: null });
    expect(
      projectBudgetRunout({ spentUsd: 50, projectedEomUsd: 200, monthlyBudgetUsd: 0, now })
    ).toEqual({ runoutDate: null, daysUntilBudgetExhausted: null });
  });

  it("reports now/0 when the budget is already exhausted", () => {
    const now = new Date(Date.UTC(2026, 6, 16, 0, 0, 0));
    const result = projectBudgetRunout({
      spentUsd: 100,
      projectedEomUsd: 200,
      monthlyBudgetUsd: 100,
      now,
    });
    expect(result.runoutDate?.toISOString()).toBe(now.toISOString());
    expect(result.daysUntilBudgetExhausted).toBe(0);
  });

  it("computes the crossing day from the average projected burn", () => {
    // July 16 00:00 UTC (day 16.0 of 31). Spent $50 of $100; projection
    // $96.875 → burn (96.875-50)/15 = 3.125/day → crossing in exactly 16 days.
    const now = new Date(Date.UTC(2026, 6, 16, 0, 0, 0));
    const result = projectBudgetRunout({
      spentUsd: 50,
      projectedEomUsd: 96.875,
      monthlyBudgetUsd: 100,
      now,
    });
    expect(result.daysUntilBudgetExhausted).toBe(16);
    expect(result.runoutDate?.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  it("returns nulls when the projection never grows past current spend", () => {
    const now = new Date(Date.UTC(2026, 6, 16, 0, 0, 0));
    expect(
      projectBudgetRunout({ spentUsd: 50, projectedEomUsd: 50, monthlyBudgetUsd: 100, now })
    ).toEqual({ runoutDate: null, daysUntilBudgetExhausted: null });
    expect(
      projectBudgetRunout({ spentUsd: 50, projectedEomUsd: 40, monthlyBudgetUsd: 100, now })
    ).toEqual({ runoutDate: null, daysUntilBudgetExhausted: null });
  });

  it("can cross beyond month end when the burn rate is slow", () => {
    // July 30 00:00 UTC (1 day left). Budget nearly reached; $0.5/day
    // projected growth → the $1 gap closes 2 days out, next month.
    const now = new Date(Date.UTC(2026, 6, 30, 0, 0, 0));
    const result = projectBudgetRunout({
      spentUsd: 99,
      projectedEomUsd: 99.5,
      monthlyBudgetUsd: 100,
      now,
    });
    expect(result.runoutDate?.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(result.daysUntilBudgetExhausted).toBe(2);
  });
});
