import { describe, expect, it } from "vitest";
import {
  buildProviderAlertState,
  type ProviderAlertInput,
} from "../provider-alerts";

const NOW = new Date("2026-07-11T17:00:00.000Z");

function input(
  snapshot: Partial<NonNullable<ProviderAlertInput["latestSnapshot"]>> = {}
): ProviderAlertInput {
  return {
    isActive: true,
    refreshIntervalMin: 60,
    plan: {
      billingMode: "actual",
      fixedMonthlyCostUsd: null,
      monthlyBudgetUsd: null,
      monthlyRequestLimit: 1_000,
      lowBalanceUsd: null,
      lowCredits: null,
      renewalDate: null,
      billingInterval: "monthly",
      mustKeepFunded: false,
    },
    latestSnapshot: {
      balance: null,
      totalCost: null,
      totalRequests: 900,
      requestUnit: "requests",
      requestWindow: "calendar_month_to_date",
      requestWindowStart: "2026-07-01T00:00:00.000Z",
      requestWindowEnd: NOW,
      credits: null,
      fetchedAt: NOW,
      ...snapshot,
    },
  };
}

describe("monthly request-limit window compatibility", () => {
  it("emits threshold alerts for current calendar-month-to-date counts", () => {
    const warning = buildProviderAlertState(input(), NOW);
    expect(warning.alerts).toContainEqual(
      expect.objectContaining({
        code: "request_limit_warning",
        severity: "warning",
        message: expect.stringContaining("900 requests"),
      })
    );

    const critical = buildProviderAlertState(
      input({ totalRequests: 1_050 }),
      NOW
    );
    expect(critical.alerts).toContainEqual(
      expect.objectContaining({ code: "request_limit", severity: "critical" })
    );
  });

  it("accepts a current monthly billing-cycle-to-date count", () => {
    const state = buildProviderAlertState(
      input({
        totalRequests: 1_050,
        requestUnit: "messages",
        requestWindow: "billing_cycle_to_date",
        requestWindowStart: "2026-06-15T05:00:00.000Z",
        requestWindowEnd: NOW,
      }),
      NOW
    );

    expect(state.alerts).toContainEqual(
      expect.objectContaining({ code: "request_limit", severity: "critical" })
    );
    expect(state.alerts.map((alert) => alert.code)).not.toContain(
      "request_limit_incompatible"
    );
  });

  it.each([
    ["calendar_day_to_date", "2026-07-11T00:00:00.000Z", "current UTC day-to-date"],
    ["rolling_30_days", "2026-06-11T17:00:00.000Z", "rolling 30 days"],
    ["minute", "2026-07-11T16:59:00.000Z", "per-minute"],
    ["provider_defined", null, "provider-defined"],
    [null, null, "unknown window"],
  ])(
    "suppresses monthly thresholds for %s counts",
    (requestWindow, requestWindowStart, expectedReason) => {
      const state = buildProviderAlertState(
        input({
          totalRequests: 5_000,
          requestWindow,
          requestWindowStart,
        }),
        NOW
      );

      expect(state.alerts).not.toContainEqual(
        expect.objectContaining({ code: "request_limit" })
      );
      expect(state.alerts).not.toContainEqual(
        expect.objectContaining({ code: "request_limit_warning" })
      );
      expect(state.alerts).toContainEqual(
        expect.objectContaining({
          code: "request_limit_incompatible",
          severity: "info",
          message: expect.stringContaining(expectedReason),
        })
      );
    }
  );

  it("suppresses a calendar-month count from a previous month", () => {
    const state = buildProviderAlertState(
      input({
        totalRequests: 5_000,
        requestWindowStart: "2026-06-01T00:00:00.000Z",
        requestWindowEnd: "2026-06-30T23:59:59.000Z",
      }),
      NOW
    );

    expect(state.alerts).toContainEqual(
      expect.objectContaining({
        code: "request_limit_incompatible",
        severity: "info",
        message: expect.stringContaining("does not cover the current UTC calendar month"),
      })
    );
    expect(state.alerts.map((alert) => alert.code)).not.toContain("request_limit");
  });

  it("suppresses a monthly count whose unit is unknown", () => {
    const state = buildProviderAlertState(
      input({ totalRequests: 5_000, requestUnit: null }),
      NOW
    );

    expect(state.alerts).toContainEqual(
      expect.objectContaining({
        code: "request_limit_incompatible",
        severity: "info",
        message: expect.stringContaining("unit is unknown"),
      })
    );
  });
});
