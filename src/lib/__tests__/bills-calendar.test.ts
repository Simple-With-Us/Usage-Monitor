import { describe, expect, it } from "vitest";
import { calendarSortFromExpense, calendarTitle, renderBillsCalendar } from "../bills-calendar";

describe("bills calendar", () => {
  it("renders Apple Calendar all-day events with the owner title format", () => {
    const ics = renderBillsCalendar(
      [{
        uid: "github-usage@usage.jays.services",
        date: "2026-08-21",
        summary: calendarTitle(200.01, "GitHub", "usage"),
        description: "Received 2026-08-21.  Period Jul 1-31 2026.",
      }],
      new Date("2026-08-22T12:00:00.000Z"),
    );
    expect(ics).toContain("SUMMARY:$200.01 - GitHub - usage");
    expect(ics).toContain("DTSTART;VALUE=DATE:20260821");
    expect(ics).toContain("DTEND;VALUE=DATE:20260822");
    expect(ics).toContain("X-WR-CALNAME:Bills");
  });

  it("maps domain and developer memberships to dev-expense", () => {
    expect(calendarSortFromExpense("one_time", "Namecheap order", "txadvocacy.com")).toBe("dev-expense");
    expect(calendarSortFromExpense("subscription", "Claude Max", "")).toBe("subscription");
  });
});
