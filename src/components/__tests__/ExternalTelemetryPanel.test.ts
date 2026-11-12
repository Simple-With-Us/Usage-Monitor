import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ExternalTelemetryPanel from "@/components/ExternalTelemetryPanel";

describe("ExternalTelemetryPanel", () => {
  it("renders authoritative zero values and zero-percent quota instead of treating them as missing", () => {
    const html = renderToStaticMarkup(
      createElement(ExternalTelemetryPanel, {
        usageSummary: {
          days: 30,
          totalCostUsd: 0,
          estimatedApiEquivalentUsd: 0,
          pricedEventCount: 1,
          unpricedEventCount: 0,
          unclassifiedCostEventCount: 0,
          costCoverage: "complete",
          totalRequests: 0,
          eventCount: 1,
          groups: [
            {
              sourceApp: "demo",
              environment: null,
              provider: "resend",
              canonicalProvider: "resend",
              service: "email",
              projectId: null,
              metricType: "usage",
              unit: "requests",
              eventCount: 1,
              pricedEventCount: 1,
              unpricedEventCount: 0,
              unclassifiedCostEventCount: 0,
              costCoverage: "complete",
              totalCostUsd: 0,
              estimatedApiEquivalentUsd: 0,
              totalRequests: 0,
              totalQuantity: 0,
              limit: 100,
              limitWindow: "day",
              latestAt: "2026-07-12T00:00:00.000Z",
            },
          ],
        },
      })
    );

    expect(html).toContain("$0.00");
    expect(html).toContain('role="progressbar"');
    expect(html).toContain("0.0% of");
  });

  it("uses request count consistently for the displayed usage and quota percent", () => {
    const html = renderToStaticMarkup(
      createElement(ExternalTelemetryPanel, {
        usageSummary: {
          days: 30,
          totalCostUsd: 0,
          estimatedApiEquivalentUsd: 0,
          pricedEventCount: 0,
          unpricedEventCount: 1,
          unclassifiedCostEventCount: 0,
          costCoverage: "unknown",
          totalRequests: 500,
          eventCount: 1,
          groups: [
            {
              sourceApp: "demo",
              environment: null,
              provider: "resend",
              canonicalProvider: "resend",
              service: "email",
              projectId: null,
              metricType: "usage",
              unit: "requests",
              eventCount: 1,
              pricedEventCount: 0,
              unpricedEventCount: 1,
              unclassifiedCostEventCount: 0,
              costCoverage: "unknown",
              totalCostUsd: 0,
              estimatedApiEquivalentUsd: 0,
              totalRequests: 500,
              totalQuantity: 0,
              limit: 1000,
              limitWindow: "day",
              latestAt: "2026-07-12T00:00:00.000Z",
            },
          ],
        },
      })
    );

    expect(html).toContain("500");
    expect(html).toContain("50.0% of");
  });

  it("uses quantity for a unit-specific quota even when request metadata is also present", () => {
    const html = renderToStaticMarkup(
      createElement(ExternalTelemetryPanel, {
        usageSummary: {
          days: 30,
          totalCostUsd: 0,
          estimatedApiEquivalentUsd: 0,
          pricedEventCount: 0,
          unpricedEventCount: 1,
          unclassifiedCostEventCount: 0,
          costCoverage: "unknown",
          totalRequests: 10,
          eventCount: 1,
          groups: [
            {
              sourceApp: "demo",
              environment: null,
              provider: "openai",
              canonicalProvider: "openai",
              service: "responses",
              projectId: null,
              metricType: "usage",
              unit: "tokens",
              eventCount: 1,
              pricedEventCount: 0,
              unpricedEventCount: 1,
              unclassifiedCostEventCount: 0,
              costCoverage: "unknown",
              totalCostUsd: 0,
              estimatedApiEquivalentUsd: 0,
              totalRequests: 10,
              totalQuantity: 10_000,
              limit: 20_000,
              limitWindow: "month",
              latestAt: "2026-07-12T00:00:00.000Z",
            },
          ],
        },
      })
    );

    expect(html).toContain("10,000");
    expect(html).toContain("50.0% of");
    expect(html).toContain("responses · tokens");
  });

  it("distinguishes unreported cost from an explicit zero and explains provider aliases", () => {
    const html = renderToStaticMarkup(
      createElement(ExternalTelemetryPanel, {
        usageSummary: {
          days: 30,
          totalCostUsd: 0,
          estimatedApiEquivalentUsd: 0,
          pricedEventCount: 0,
          unpricedEventCount: 4,
          unclassifiedCostEventCount: 0,
          costCoverage: "unknown",
          totalRequests: 4,
          eventCount: 4,
          groups: [
            {
              sourceApp: "socratic-trade",
              environment: "prod",
              provider: "gemini",
              canonicalProvider: "google-ai",
              matchedProvider: {
                id: "provider-google-ai",
                name: "google-ai",
                displayName: "Google AI",
              },
              service: "gemini-2.5-flash",
              projectId: null,
              metricType: "request",
              unit: "requests",
              eventCount: 4,
              pricedEventCount: 0,
              unpricedEventCount: 4,
              unclassifiedCostEventCount: 0,
              costCoverage: "unknown",
              totalCostUsd: 0,
              estimatedApiEquivalentUsd: 0,
              totalRequests: 4,
              totalQuantity: 4,
              limit: null,
              limitWindow: null,
              latestAt: "2026-07-13T00:00:00.000Z",
            },
          ],
        },
      })
    );

    expect(html).toContain("Cost not reported");
    expect(html).toContain("Matched to Google AI");
    expect(html).not.toContain("$0.00");
  });

  it("labels Claude API-equivalent telemetry as excluded from authoritative cash spend", () => {
    const html = renderToStaticMarkup(
      createElement(ExternalTelemetryPanel, {
        usageSummary: {
          days: 30,
          totalCostUsd: 65,
          estimatedApiEquivalentUsd: 9_000,
          pricedEventCount: 1,
          unpricedEventCount: 0,
          unclassifiedCostEventCount: 0,
          costCoverage: "complete",
          totalRequests: 0,
          eventCount: 2,
          groups: [
            {
              sourceApp: "claude-code",
              environment: null,
              provider: "anthropic",
              canonicalProvider: "anthropic",
              service: "claude-code",
              projectId: null,
              metricType: "cost",
              unit: "usd",
              eventCount: 1,
              pricedEventCount: 0,
              unpricedEventCount: 0,
              unclassifiedCostEventCount: 0,
              costCoverage: "unknown",
              totalCostUsd: 0,
              estimatedApiEquivalentUsd: 9_000,
              totalRequests: 0,
              totalQuantity: 0,
              limit: null,
              limitWindow: null,
              latestAt: "2026-07-14T00:00:00.000Z",
            },
          ],
        },
      })
    );

    expect(html).toContain("Tracked cash spend");
    expect(html).toContain("API-equivalent estimate: $9,000.00");
    expect(html).toContain(
      "Excluded from cash spend · verify provider billing"
    );
    expect(html).toContain(
      "API-equivalent estimate · excluded from cash spend"
    );
  });

  it("shows token quantity and derived dollars separately for token-only seats", () => {
    const html = renderToStaticMarkup(
      createElement(ExternalTelemetryPanel, {
        usageSummary: {
          days: 30,
          totalCostUsd: 0,
          estimatedApiEquivalentUsd: 3,
          pricedEventCount: 0,
          unpricedEventCount: 0,
          unclassifiedCostEventCount: 0,
          costCoverage: "unknown",
          totalRequests: 0,
          eventCount: 1,
          groups: [{
            sourceApp: "opencode",
            environment: null,
            provider: "anthropic",
            canonicalProvider: "anthropic",
            service: "opencode",
            projectId: null,
            metricType: "usage",
            unit: "token",
            eventCount: 1,
            pricedEventCount: 0,
            unpricedEventCount: 0,
            unclassifiedCostEventCount: 0,
            costCoverage: "unknown",
            totalCostUsd: 0,
            estimatedApiEquivalentUsd: 3,
            totalRequests: 0,
            totalQuantity: 1_000_000,
            limit: null,
            limitWindow: null,
            latestAt: "2026-07-14T00:00:00.000Z",
          }],
        },
      })
    );

    const usageCell = html.split('data-label="Usage"')[1]?.split('data-label="Quota"')[0];
    expect(usageCell).toContain(">1,000,000</p>");
    expect(usageCell).toContain("API-equivalent estimate: $3.00 · excluded from cash spend");
    expect(usageCell!.indexOf("1,000,000")).toBeLessThan(usageCell!.indexOf("$3.00"));
    expect(html).toContain("opencode · token");
  });
});
