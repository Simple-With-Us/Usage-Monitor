import { describe, expect, it } from "vitest";
import {
  advancePeriod,
  applyAnchorDay,
  effectiveSubscriptionStatus,
  isAmbiguousSubscriptionPeriodWindow,
  rescheduleCycle,
  initialCycle,
  normalizeMonthlyUsd,
  rollForwardRenewal,
} from "../subscriptions";

const iso = (d: Date) => d.toISOString();

describe("effectiveSubscriptionStatus", () => {
  it("expires only a stored-active non-renewing term after its end", () => {
    const now = new Date("2026-07-12T00:00:00.000Z");
    expect(
      effectiveSubscriptionStatus(
        {
          status: "active",
          autoRenew: false,
          nextRenewalAt: "2026-07-10T00:00:00.000Z",
        },
        now
      )
    ).toBe("expired");
    expect(
      effectiveSubscriptionStatus(
        {
          status: "active",
          autoRenew: true,
          nextRenewalAt: "2026-07-10T00:00:00.000Z",
        },
        now
      )
    ).toBe("active");
  });
});

describe("advancePeriod", () => {
  it("advances monthly, clamping to the shorter month", () => {
    // Jan 31 + 1 month -> Feb 28 (2026 is not a leap year).
    expect(iso(advancePeriod(new Date("2026-01-31T00:00:00Z"), "monthly", 1))).toBe(
      "2026-02-28T00:00:00.000Z"
    );
  });

  it("advances weekly by whole weeks", () => {
    expect(iso(advancePeriod(new Date("2026-01-01T00:00:00Z"), "weekly", 1))).toBe(
      "2026-01-08T00:00:00.000Z"
    );
    expect(iso(advancePeriod(new Date("2026-01-01T00:00:00Z"), "weekly", 2))).toBe(
      "2026-01-15T00:00:00.000Z"
    );
  });

  it("advances quarterly and annual", () => {
    expect(iso(advancePeriod(new Date("2026-01-15T00:00:00Z"), "quarterly", 1))).toBe(
      "2026-04-15T00:00:00.000Z"
    );
    expect(iso(advancePeriod(new Date("2026-01-15T00:00:00Z"), "annual", 1))).toBe(
      "2027-01-15T00:00:00.000Z"
    );
  });

  it("honors intervalCount for month-based cadences", () => {
    expect(iso(advancePeriod(new Date("2026-01-15T00:00:00Z"), "monthly", 3))).toBe(
      "2026-04-15T00:00:00.000Z"
    );
  });
});

describe("normalizeMonthlyUsd", () => {
  it("returns monthly-equivalent cost per cadence", () => {
    expect(normalizeMonthlyUsd(20, "monthly", 1)).toBeCloseTo(20);
    expect(normalizeMonthlyUsd(1200, "annual", 1)).toBeCloseTo(100);
    expect(normalizeMonthlyUsd(300, "quarterly", 1)).toBeCloseTo(100);
    expect(normalizeMonthlyUsd(10, "weekly", 1)).toBeCloseTo((10 * 52) / 12);
    // Every-3-months at $30 == $10/mo.
    expect(normalizeMonthlyUsd(30, "monthly", 3)).toBeCloseTo(10);
  });
});

describe("applyAnchorDay", () => {
  it("moves the day-of-month, clamping to the month length", () => {
    expect(iso(applyAnchorDay(new Date("2026-02-10T00:00:00Z"), 31))).toBe(
      "2026-02-28T00:00:00.000Z"
    );
    expect(iso(applyAnchorDay(new Date("2026-03-10T00:00:00Z"), 1))).toBe(
      "2026-03-01T00:00:00.000Z"
    );
  });
});

describe("initialCycle", () => {
  it("starts at startDate and renews one interval later", () => {
    const cycle = initialCycle({
      startDate: new Date("2026-01-15T00:00:00Z"),
      interval: "monthly",
      intervalCount: 1,
      anchorDay: null,
    });
    expect(iso(cycle.currentPeriodStart)).toBe("2026-01-15T00:00:00.000Z");
    expect(iso(cycle.nextRenewalAt)).toBe("2026-02-15T00:00:00.000Z");
  });

  it("applies an anchor day to the first period", () => {
    const cycle = initialCycle({
      startDate: new Date("2026-01-15T00:00:00Z"),
      interval: "monthly",
      intervalCount: 1,
      anchorDay: 1,
    });
    expect(iso(cycle.currentPeriodStart)).toBe("2026-01-01T00:00:00.000Z");
    expect(iso(cycle.nextRenewalAt)).toBe("2026-02-01T00:00:00.000Z");
  });
});

describe("rescheduleCycle", () => {
  it("starts at the anchor when nothing has been charged yet", () => {
    const cycle = rescheduleCycle({
      startDate: new Date("2026-01-01T00:00:00Z"),
      interval: "monthly",
      intervalCount: 1,
      anchorDay: null,
      paidThrough: null,
    });
    expect(iso(cycle.currentPeriodStart)).toBe("2026-01-01T00:00:00.000Z");
  });

  it("floors the new cycle at paidThrough so a later anchor never overlaps billed time", () => {
    // Charged the Jul-1 monthly period (paid through Aug 1); move anchor to the
    // 31st. The next period must not start before Aug 1 — it lands on Aug 31.
    const cycle = rescheduleCycle({
      startDate: new Date("2026-07-01T00:00:00Z"),
      interval: "monthly",
      intervalCount: 1,
      anchorDay: 31,
      paidThrough: new Date("2026-08-01T00:00:00Z"),
    });
    expect(iso(cycle.currentPeriodStart)).toBe("2026-08-31T00:00:00.000Z");
  });

  it("resumes a coarser cadence at or after paidThrough (no backfill)", () => {
    const cycle = rescheduleCycle({
      startDate: new Date("2026-07-01T00:00:00Z"),
      interval: "quarterly",
      intervalCount: 1,
      anchorDay: null,
      paidThrough: new Date("2026-08-01T00:00:00Z"),
    });
    expect(iso(cycle.currentPeriodStart)).toBe("2026-10-01T00:00:00.000Z");
  });
});

describe("rollForwardRenewal", () => {
  it("advances a past renewal to the next upcoming occurrence", () => {
    const next = rollForwardRenewal(
      new Date("2026-01-01T00:00:00Z"),
      "monthly",
      1,
      new Date("2026-03-15T00:00:00Z")
    );
    expect(iso(next)).toBe("2026-04-01T00:00:00.000Z");
  });

  it("leaves a future renewal untouched", () => {
    const future = new Date("2026-12-01T00:00:00Z");
    expect(iso(rollForwardRenewal(future, "monthly", 1, new Date("2026-03-15T00:00:00Z")))).toBe(
      iso(future)
    );
  });
});

describe("isAmbiguousSubscriptionPeriodWindow (Wave K / E13)", () => {
  it("accepts exact monthly cadence", () => {
    const start = new Date("2026-07-01T00:00:00.000Z");
    const end = advancePeriod(start, "monthly", 1);
    expect(isAmbiguousSubscriptionPeriodWindow(start, end, "monthly", 1)).toBe(
      false
    );
  });

  it("rejects UTC-midnight calendar renewal unless the CF exception is opted in", () => {
    const start = new Date("2026-07-16T14:22:00.000Z");
    // Expected end is ~Aug 16 14:22; midnight on Aug 16 is non-exact without opt-in.
    const end = new Date("2026-08-16T00:00:00.000Z");
    expect(isAmbiguousSubscriptionPeriodWindow(start, end, "monthly", 1)).toBe(
      true
    );
    expect(
      isAmbiguousSubscriptionPeriodWindow(start, end, "monthly", 1, {
        allowUtcMidnightCalendarException: true,
      })
    ).toBe(false);
  });

  it("flags a mid-period window that is not exact cadence", () => {
    const start = new Date("2026-07-01T00:00:00.000Z");
    const end = new Date("2026-07-10T00:00:00.000Z"); // 9 days — not monthly
    expect(isAmbiguousSubscriptionPeriodWindow(start, end, "monthly", 1)).toBe(
      true
    );
  });

  it("flags inverted or zero-length windows", () => {
    const start = new Date("2026-07-10T00:00:00.000Z");
    const end = new Date("2026-07-01T00:00:00.000Z");
    expect(isAmbiguousSubscriptionPeriodWindow(start, end, "monthly", 1)).toBe(
      true
    );
  });
});
