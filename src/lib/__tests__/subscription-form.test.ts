import { describe, expect, it } from "vitest";
import { startDateForStatusTransition, toDateInputValue } from "../subscription-form";

describe("subscription form activation dates", () => {
  it("formats the operator's local calendar date instead of UTC", () => {
    const lateEveningChicago = new Date("2026-07-12T02:30:00.000Z");
    expect(toDateInputValue(lateEveningChicago, 300)).toBe("2026-07-11");
  });

  it("resets an inactive plan to today's purchase date when activated", () => {
    expect(
      startDateForStatusTransition({
        currentStatus: "considering",
        nextStatus: "active",
        currentStartDate: "2026-01-01",
        now: new Date("2026-07-11T18:00:00.000Z"),
      })
    ).toBe("2026-07-11");
  });

  it("keeps the date for edits that are not an activation", () => {
    expect(
      startDateForStatusTransition({
        currentStatus: "active",
        nextStatus: "active",
        currentStartDate: "2026-01-01",
        now: new Date("2026-07-11T18:00:00.000Z"),
      })
    ).toBe("2026-01-01");
  });
});
