import { describe, expect, it } from "vitest";
import {
  aggregateSentryByCategory,
  parseSentryCategoriesFromRawData,
  sentryCategoryFamily,
  sentryCategoryLabel,
  sentryOutcomeLabel,
  sentryStatsBillingCost,
  sentryUsageServiceName,
} from "@/lib/sentry-usage-categories";

describe("sentry usage categories", () => {
  it("uses Title Case family labels and never invents Spans or Logs", () => {
    expect(sentryCategoryLabel("error")).toBe("Errors");
    expect(sentryCategoryLabel("transaction")).toBe("Transactions");
    expect(sentryCategoryLabel("replay")).toBe("Replays");
    expect(sentryCategoryLabel("attachment")).toBe("Attachments");
    expect(sentryCategoryLabel("profile")).toBe("Profiles");
    expect(sentryCategoryLabel("monitor")).toBe("Monitors");
    expect(sentryCategoryLabel("span")).toBe("Other");
    expect(sentryCategoryLabel("spans")).toBe("Other");
    expect(sentryCategoryLabel("log")).toBe("Other");
    expect(sentryCategoryFamily("transaction")).toBe("Transactions");
    expect(sentryCategoryFamily("span")).toBe("Other");
    expect(sentryOutcomeLabel("rate_limited")).toBe("Rate Limited");
    expect(sentryUsageServiceName("101", "error", "accepted")).toBe(
      "Project 101: Errors (Accepted)"
    );
  });

  it("aggregates accepted and rate_limited totals without mixing units", () => {
    const totals = aggregateSentryByCategory([
      {
        project: "1",
        category: "error",
        outcome: "accepted",
        quantity: 10,
        unit: "events",
      },
      {
        project: "2",
        category: "error",
        outcome: "rate_limited",
        quantity: 4,
        unit: "events",
      },
      {
        project: "1",
        category: "attachment",
        outcome: "accepted",
        quantity: 100,
        unit: "bytes",
      },
    ]);
    expect(totals).toEqual([
      expect.objectContaining({
        label: "Errors",
        accepted: 10,
        rateLimited: 4,
        total: 14,
        unit: "events",
      }),
      expect.objectContaining({
        label: "Attachments",
        accepted: 100,
        rateLimited: 0,
        unit: "bytes",
      }),
    ]);
  });

  it("parses persisted categories and keeps billingCost false", () => {
    const rawData = {
      categories: {
        byCategory: [
          {
            category: "error",
            label: "Errors",
            family: "Errors",
            unit: "events",
            accepted: 12,
            rateLimited: 3,
            filtered: 0,
            other: 0,
            total: 15,
          },
        ],
      },
      stats: {
        capabilities: { billingCost: false },
      },
    };
    expect(parseSentryCategoriesFromRawData(rawData)?.byCategory[0]).toMatchObject({
      label: "Errors",
      accepted: 12,
      rateLimited: 3,
    });
    expect(sentryStatsBillingCost(rawData)).toBe(false);
  });
});
