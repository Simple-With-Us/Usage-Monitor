import { describe, expect, it } from "vitest";
import {
  formatBudgetRunout,
  formatCompactNumber,
  formatCurrency,
  formatDate,
  formatNumber,
  formatShortDate,
  NOT_REPORTED,
  NULL_DISPLAY,
  projectedStatusLabel,
} from "@/lib/format";

describe("formatCurrency", () => {
  it("formats USD with at most 2 fraction digits", () => {
    expect(formatCurrency(1234.567)).toBe("$1,234.57");
    expect(formatCurrency(5)).toBe("$5.00");
    expect(formatCurrency(0)).toBe("$0.00");
  });

  it("uses the shared compact null state by default", () => {
    expect(formatCurrency(null)).toBe(NULL_DISPLAY);
    expect(formatCurrency(undefined)).toBe(NULL_DISPLAY);
    expect(formatCurrency(Number.NaN)).toBe(NULL_DISPLAY);
  });

  it("supports the prose null state for billing contexts", () => {
    expect(formatCurrency(null, { nullState: NOT_REPORTED })).toBe(NOT_REPORTED);
  });

  it("formats non-USD currencies and lower-case codes", () => {
    expect(formatCurrency(12.5, { currency: "eur" })).toContain("12.50");
  });

  it("falls back to a raw amount for unknown currency codes", () => {
    expect(formatCurrency(3, { currency: "not-a-code" })).toBe("3.00 NOT-A-CODE");
    expect(formatCurrency(3, { currency: "  " })).toBe("3.00 UNKNOWN");
  });

  it("honors an explicit fraction-digit cap below 2", () => {
    expect(formatCurrency(1234.5, { maximumFractionDigits: 0 })).toBe("$1,235");
  });
});

describe("formatNumber", () => {
  it("formats counts with grouping and at most 2 fraction digits", () => {
    expect(formatNumber(1234567)).toBe("1,234,567");
    expect(formatNumber(1.23456)).toBe("1.23");
  });

  it("uses the shared null state", () => {
    expect(formatNumber(null)).toBe(NULL_DISPLAY);
    expect(formatNumber(undefined)).toBe(NULL_DISPLAY);
  });

  it("allows a custom null state and fraction cap", () => {
    expect(formatNumber(null, { nullState: NOT_REPORTED })).toBe(NOT_REPORTED);
    expect(formatNumber(1.5, { maximumFractionDigits: 1 })).toBe("1.5");
    expect(formatNumber(1.55, { maximumFractionDigits: 1 })).toBe("1.6");
  });
});

describe("formatCompactNumber", () => {
  it("uses compact notation with 1 fraction digit", () => {
    expect(formatCompactNumber(10_000_000)).toBe("10m");
    expect(formatCompactNumber(1_234)).toBe("1.2k");
  });
});

describe("formatDate", () => {
  it("formats a UTC calendar date", () => {
    const expected = new Date("2026-08-22T10:00:00.000Z").toLocaleDateString(
      undefined,
      { timeZone: "UTC" }
    );
    expect(formatDate("2026-08-22T10:00:00.000Z")).toBe(expected);
  });

  it("uses null and invalid states distinctly when asked", () => {
    expect(formatDate(null)).toBe(NULL_DISPLAY);
    expect(formatDate("not-a-date")).toBe(NULL_DISPLAY);
    expect(formatDate(null, { nullState: NOT_REPORTED })).toBe(NOT_REPORTED);
    expect(
      formatDate("not-a-date", { nullState: NOT_REPORTED, invalidState: "Invalid date" })
    ).toBe("Invalid date");
  });
});

describe("formatShortDate", () => {
  const NOW = Date.parse("2026-07-29T00:00:00.000Z");

  it("omits the year for same-year dates and includes it otherwise", () => {
    expect(formatShortDate("2026-08-22T00:00:00.000Z", NOW)).toMatch(/Aug 22/);
    expect(formatShortDate("2026-08-22T00:00:00.000Z", NOW)).not.toMatch(/2026/);
    expect(formatShortDate("2027-01-05T00:00:00.000Z", NOW)).toMatch(/2027/);
  });

  it("never collapses to a relative phrase and tolerates garbage", () => {
    expect(formatShortDate("garbage", NOW)).toBe(NULL_DISPLAY);
  });
});

describe("formatBudgetRunout", () => {
  const NOW = Date.parse("2026-07-29T00:00:00.000Z");

  it("returns null when the DTO carries no runout signal", () => {
    expect(formatBudgetRunout({}, NOW)).toBeNull();
    expect(
      formatBudgetRunout(
        { projectedRunoutDate: null, daysUntilBudgetExhausted: null },
        NOW
      )
    ).toBeNull();
  });

  it("renders the runout date at current burn", () => {
    expect(
      formatBudgetRunout(
        {
          projectedRunoutDate: "2026-08-22T00:00:00.000Z",
          daysUntilBudgetExhausted: 24,
        },
        NOW
      )
    ).toBe("Budget exhausts ~Aug 22 at current burn");
  });

  it("reports an already-exhausted budget without a date", () => {
    expect(
      formatBudgetRunout(
        {
          projectedRunoutDate: "2026-07-29T00:00:00.000Z",
          daysUntilBudgetExhausted: 0,
        },
        NOW
      )
    ).toBe("Budget exhausted at current burn");
  });

  it("tolerates an unparseable runout date", () => {
    expect(
      formatBudgetRunout(
        { projectedRunoutDate: "junk", daysUntilBudgetExhausted: 3 },
        NOW
      )
    ).toBeNull();
  });
});

describe("projectedStatusLabel", () => {
  it("labels only worse-than-ok projected statuses", () => {
    expect(projectedStatusLabel("exceeded")).toBe("On pace to exceed budget");
    expect(projectedStatusLabel("warning")).toBe("On pace for budget warning");
    expect(projectedStatusLabel("ok")).toBeNull();
    expect(projectedStatusLabel("unconfigured")).toBeNull();
    expect(projectedStatusLabel(null)).toBeNull();
    expect(projectedStatusLabel(undefined)).toBeNull();
  });
});
