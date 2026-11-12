import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ExternalBillingDetails, {
  isExternalBillingStale,
} from "@/components/ExternalBillingDetails";

describe("isExternalBillingStale", () => {
  it("honors the caller-provided freshness threshold", () => {
    const now = Date.parse("2026-07-12T12:00:00.000Z");
    const record = { syncedAt: "2026-07-12T10:00:00.000Z" };

    expect(isExternalBillingStale(record, 60 * 60 * 1_000, now)).toBe(true);
    expect(isExternalBillingStale(record, 3 * 60 * 60 * 1_000, now)).toBe(false);
  });
});

describe("ExternalBillingDetails", () => {
  it("uses Title Case labels for Sentry usage records", () => {
    const html = renderToStaticMarkup(
      createElement(ExternalBillingDetails, {
        records: [
          {
            source: "sentry-stats-v2",
            externalId: "mtd:2026-09-01:101:error:accepted",
            kind: "billing_period",
            serviceName: "Project 101: Errors (Accepted)",
            planName: null,
            status: "usage_reported",
            amountUsd: null,
            currency: null,
            billingInterval: null,
            currentPeriodStart: "2026-09-01T00:00:00.000Z",
            currentPeriodEnd: "2026-09-04T12:00:00.000Z",
            nextRenewalAt: null,
            requestLimit: null,
            requestLimitWindow: null,
            spendLimitUsd: null,
            spendLimitWindow: null,
            usageQuantity: 12,
            remainingQuantity: null,
            usageUnit: "events",
            rollupRole: "metadata",
            dateKind: "report_through",
            syncedAt: "2026-09-04T12:00:00.000Z",
          },
        ],
      })
    );

    expect(html).toContain("Provider-Reported Billing");
    expect(html).toContain("Project 101: Errors (Accepted)");
    expect(html).toContain("Usage reported");
    expect(html).toContain("Reported Amount");
    expect(html).toContain("Tracked Usage");
    expect(html).toContain("Current Period");
  });
});
