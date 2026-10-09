import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import PaidServicesPanel from "@/components/PaidServicesPanel";

describe("PaidServicesPanel", () => {
  it("renders linked paid service details, quota changes, renewal, and provenance", () => {
    const html = renderToStaticMarkup(
      createElement(PaidServicesPanel, {
        variant: "settings",
        showCoverage: true,
        providers: [
          {
            id: "cloudflare",
            name: "cloudflare",
            displayName: "Cloudflare",
            type: "builtin",
            refreshIntervalMin: 60,
            externalBilling: [
              {
                source: "cloudflare-subscriptions",
                externalId: "workers",
                kind: "subscription",
                planName: "Workers Paid",
                status: "active",
                amountUsd: 5,
                currency: "USD",
                billingInterval: "monthly",
                currentPeriodStart: "2026-07-01T00:00:00.000Z",
                currentPeriodEnd: "2026-08-01T00:00:00.000Z",
                nextRenewalAt: "2026-08-01T00:00:00.000Z",
                requestLimit: 10_000_000,
                requestLimitWindow: "month",
                spendLimitUsd: null,
                spendLimitWindow: null,
                syncedAt: new Date().toISOString(),
              },
            ],
          },
        ],
        subscriptions: [
          {
            id: "subscription",
            name: "Cloudflare Workers",
            description: null,
            costUsd: 5,
            currency: "USD",
            interval: "monthly",
            intervalCount: 1,
            monthlyEquivalentUsd: 5,
            nextRenewalAt: "2026-08-01T00:00:00.000Z",
            autoRenew: true,
            status: "active",
            externalBillingSource: "cloudflare-subscriptions",
            externalBillingId: "workers",
            knobEnv: { PROVIDER_QUOTA_WORKERS_REQUESTS: "10000000" },
            freeTierKnobEnv: { PROVIDER_QUOTA_WORKERS_REQUESTS: "100000" },
            provider: { id: "cloudflare", name: "cloudflare", displayName: "Cloudflare" },
            project: null,
          },
        ],
      })
    );

    expect(html).toContain("Paid Services, Plans &amp; Quotas");
    expect(html).toContain("Cloudflare Workers");
    expect(html).toContain("Workers Paid");
    expect(html).toContain("Verified + tracked");
    expect(html).toContain("10m limit");
    expect(html).toContain("paid-tier limit");
    expect(html).toContain("Provider billing coverage");
    expect(html).toContain("0 tracked");
    expect((html.match(/Cloudflare Workers/g) ?? [])).toHaveLength(1);
  });

  it("labels service components as non-additive and keeps the full quota visible", () => {
    const html = renderToStaticMarkup(
      createElement(PaidServicesPanel, {
        providers: [
          {
            id: "provider",
            name: "pushover",
            displayName: "Pushover",
            type: "builtin",
            externalBilling: [
              {
                source: "provider-billing",
                externalId: "total",
                kind: "billing_period",
                serviceName: "Provider total",
                planName: "Current month",
                status: "limit_reached",
                amountUsd: 10,
                currency: "USD",
                billingInterval: null,
                currentPeriodStart: "2026-07-01T00:00:00.000Z",
                currentPeriodEnd: "2026-07-12T00:00:00.000Z",
                nextRenewalAt: null,
                requestLimit: null,
                requestLimitWindow: null,
                spendLimitUsd: null,
                spendLimitWindow: null,
                rollupRole: "canonical",
                dateKind: "report_through",
                syncedAt: new Date().toISOString(),
              },
              {
                source: "provider-billing",
                externalId: "messages",
                kind: "billing_period",
                serviceName: "Messages",
                planName: "Service breakdown",
                status: "open",
                amountUsd: 4,
                currency: "USD",
                billingInterval: null,
                currentPeriodStart: "2026-07-01T00:00:00.000Z",
                currentPeriodEnd: "2026-07-12T00:00:00.000Z",
                nextRenewalAt: null,
                requestLimit: 10_000,
                requestLimitWindow: "month",
                spendLimitUsd: null,
                spendLimitWindow: null,
                usageQuantity: 2_500,
                remainingQuantity: 7_500,
                usageUnit: "messages",
                rollupRole: "component",
                dateKind: "report_through",
                syncedAt: new Date().toISOString(),
              },
            ],
          },
        ],
        subscriptions: [],
      })
    );

    expect(html).toContain("Breakdown");
    expect(html).toContain("Limit reached");
    expect(html).toContain("excluded from summaries");
    expect(html).toContain("10k / month limit");
    expect(html).toContain("reported through");
  });

  it("shows Firecrawl extras without inventing provider-reported usage", () => {
    const html = renderToStaticMarkup(
      createElement(PaidServicesPanel, {
        providers: [
          {
            id: "firecrawl",
            name: "firecrawl",
            displayName: "Firecrawl",
            type: "builtin",
            externalBilling: [
              {
                source: "firecrawl-team-credit-usage",
                externalId: "team-credit-plan",
                kind: "plan",
                serviceName: "Firecrawl API",
                planName: null,
                status: null,
                amountUsd: null,
                currency: null,
                billingInterval: null,
                currentPeriodStart: null,
                currentPeriodEnd: "2026-08-01T00:00:00.000Z",
                nextRenewalAt: null,
                requestLimit: 1_000,
                requestLimitWindow: "billing period",
                spendLimitUsd: null,
                spendLimitWindow: null,
                remainingQuantity: 1_250,
                usageUnit: "credits",
                rollupRole: "metadata",
                dateKind: "period_end",
                syncedAt: new Date().toISOString(),
              },
            ],
          },
        ],
        subscriptions: [],
      })
    );

    expect(html).toContain("1,250 remaining");
    expect(html).toContain("1,000 / billing period limit");
    expect(html).toContain("period ends");
    expect(html).not.toContain("credits used");
  });

  it("makes the USD-only recurring summary explicit when native-currency services exist", () => {
    const html = renderToStaticMarkup(
      createElement(PaidServicesPanel, {
        providers: [
          {
            id: "hetzner",
            name: "hetzner",
            displayName: "Hetzner Cloud",
            type: "builtin",
            externalBilling: [
              {
                source: "hetzner-pricing",
                externalId: "server-1",
                kind: "plan",
                serviceName: "cx22 server",
                planName: "cx22",
                status: "active",
                amountUsd: 4.5,
                currency: "EUR",
                billingInterval: "monthly",
                currentPeriodStart: "2026-07-01T00:00:00.000Z",
                currentPeriodEnd: "2026-08-01T00:00:00.000Z",
                nextRenewalAt: null,
                requestLimit: null,
                requestLimitWindow: null,
                spendLimitUsd: null,
                spendLimitWindow: null,
                rollupRole: "canonical",
                syncedAt: new Date().toISOString(),
              },
            ],
          },
        ],
        subscriptions: [],
      })
    );

    expect(html).toContain("€4.50");
    expect(html).toContain("USD only");
    expect(html).toContain("1 non-USD excluded");
  });

  it("uses provider-reported token units for token quota limits", () => {
    const html = renderToStaticMarkup(
      createElement(PaidServicesPanel, {
        providers: [
          {
            id: "gemini",
            name: "google-ai",
            displayName: "Gemini",
            type: "builtin",
            externalBilling: [
              {
                source: "google-cloud-monitoring-quota-limits",
                externalId: "token-limit",
                kind: "account",
                serviceName: "Gemini tokens per minute",
                planName: "Cloud Monitoring quota limit",
                status: "active",
                amountUsd: null,
                currency: null,
                billingInterval: null,
                currentPeriodStart: null,
                currentPeriodEnd: "2026-07-13T20:00:00.000Z",
                nextRenewalAt: null,
                requestLimit: 2_000_000,
                requestLimitWindow: "tokens per minute per project",
                spendLimitUsd: null,
                spendLimitWindow: null,
                usageUnit: "tokens",
                rollupRole: "metadata",
                dateKind: "report_through",
                syncedAt: new Date().toISOString(),
              },
            ],
          },
        ],
        subscriptions: [],
      })
    );

    expect(html).toContain("2m limit");
    expect(html).toContain("tokens / tokens per minute per project");
    expect(html).not.toContain("requests / tokens per minute per project");
  });
});
