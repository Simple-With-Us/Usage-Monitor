import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SentryUsageTable } from "@/components/SentryUsageCard";

describe("SentryUsageTable", () => {
  it("renders Title Case category labels and accepted / rate-limited columns", () => {
    const html = renderToStaticMarkup(
      createElement(SentryUsageTable, {
        rows: [
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
          {
            category: "transaction",
            label: "Transactions",
            family: "Transactions",
            unit: "events",
            accepted: 8,
            rateLimited: 0,
            filtered: 0,
            other: 0,
            total: 8,
          },
        ],
      })
    );

    expect(html).toContain("Sentry Usage by Category");
    expect(html).toContain("Errors");
    expect(html).toContain("Transactions");
    expect(html).toContain("Accepted");
    expect(html).toContain("Rate Limited");
    expect(html).not.toContain("Spans");
    expect(html).not.toContain("Balance");
    expect(html).not.toContain("Credits");
  });
});
