import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ProviderCard from "@/components/ProviderCard";

describe("ProviderCard", () => {
  it("shows provider-reported cost as positive spend rather than a negative balance", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderCard, {
        id: "github",
        name: "github",
        displayName: "GitHub",
        type: "builtin",
        isActive: true,
        latestSnapshot: {
          balance: null,
          totalCost: 18.4,
          totalRequests: null,
          credits: null,
          fetchedAt: "2026-07-12T00:00:00.000Z",
        },
      })
    );

    expect(html).toContain("$18.40");
    expect(html).not.toContain("-$18.40");
  });

  it("renders an explicit zero when cost coverage is complete", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderCard, {
        id: "gemini",
        name: "google-ai",
        displayName: "Gemini",
        type: "builtin",
        isActive: true,
        spentUsd: 0,
        projectedEomUsd: 0,
        spendCoverage: "complete",
        latestSnapshot: null,
      })
    );

    expect(html).toContain("Tracked MTD / projected EOM");
    expect(html).toContain("$0.00");
    expect(html).not.toContain("Cost not reported");
  });

  it("does not turn usage without cost into authoritative zero spend", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderCard, {
        id: "gemini",
        name: "google-ai",
        displayName: "Gemini",
        type: "builtin",
        isActive: true,
        spentUsd: 0,
        projectedEomUsd: 0,
        spendCoverage: "unknown",
        pushedUnpricedEventCount: 2,
        latestSnapshot: null,
      })
    );

    expect(html).toContain("Cost not reported");
    expect(html).toContain("Projection unavailable");
    expect(html).toContain("2 usage events without cost");
    expect(html).not.toContain("$0.00");
  });

  it("labels partial spend as a known subtotal with unpriced event count", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderCard, {
        id: "openai",
        name: "openai",
        displayName: "OpenAI",
        type: "builtin",
        isActive: true,
        spentUsd: 12.5,
        projectedEomUsd: 20,
        spendCoverage: "partial",
        pushedUnpricedEventCount: 2,
        pushedUnclassifiedCostEventCount: 1,
        latestSnapshot: null,
      })
    );

    expect(html).toContain("Known MTD / known-cost projection");
    expect(html).toContain("$12.50");
    expect(html).toContain("from known costs");
    expect(html).toContain("3 unpriced events");
  });

  it("shows a cost coverage gap warning when the adapter flags one", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderCard, {
        id: "cloudflare",
        name: "cloudflare",
        displayName: "Cloudflare",
        type: "builtin",
        isActive: true,
        spentUsd: 5,
        projectedEomUsd: 5,
        spendCoverage: "complete",
        costCoverageCaveat: {
          code: "cloudflare_paygo_usage_unavailable",
          message: "Usage-based costs (D1, R2, Workers, Queues overage) are not visible for this account — only the fixed subscription fee is shown. Cost may be understated.",
        },
        latestSnapshot: {
          balance: null,
          totalCost: 5,
          totalRequests: null,
          credits: null,
          fetchedAt: "2026-07-17T00:00:00.000Z",
        },
      })
    );

    expect(html).toContain("Cost coverage gap:");
    expect(html).toContain("Usage-based costs (D1, R2, Workers, Queues overage) are not visible");
  });

  it("omits the cost coverage gap warning when the adapter did not flag one", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderCard, {
        id: "cloudflare",
        name: "cloudflare",
        displayName: "Cloudflare",
        type: "builtin",
        isActive: true,
        spentUsd: 5,
        projectedEomUsd: 5,
        spendCoverage: "complete",
        latestSnapshot: {
          balance: null,
          totalCost: 5,
          totalRequests: null,
          credits: null,
          fetchedAt: "2026-07-17T00:00:00.000Z",
        },
      })
    );

    expect(html).not.toContain("Cost coverage gap");
  });

  it("labels the usage stat with the default Requests heading for request-count providers", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderCard, {
        id: "openai",
        name: "openai",
        displayName: "OpenAI",
        type: "builtin",
        isActive: true,
        latestSnapshot: {
          balance: null,
          totalCost: null,
          totalRequests: 1200,
          credits: null,
          fetchedAt: "2026-07-17T00:00:00.000Z",
        },
      })
    );

    expect(html).toContain(">Requests<");
    expect(html).toContain("1,200");
  });

  it("relabels the usage stat to the provider's real unit (Render bandwidth in MB)", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderCard, {
        id: "render",
        name: "render",
        displayName: "Render",
        type: "builtin",
        isActive: true,
        latestSnapshot: {
          balance: null,
          totalCost: null,
          totalRequests: 3500,
          credits: null,
          fetchedAt: "2026-07-17T00:00:00.000Z",
        },
      })
    );

    // 3,500 means 3,500 MB of bandwidth, so it must not sit under "Requests".
    expect(html).toContain("Bandwidth (MB)");
    expect(html).toContain("3,500");
    expect(html).not.toContain(">Requests<");
  });

  it("relabels Langfuse totalRequests as billable units", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderCard, {
        id: "langfuse",
        name: "langfuse",
        displayName: "Langfuse",
        type: "builtin",
        isActive: true,
        latestSnapshot: {
          balance: null,
          totalCost: null,
          totalRequests: 42,
          credits: null,
          fetchedAt: "2026-07-17T00:00:00.000Z",
        },
      })
    );

    expect(html).toContain("Billable units");
    expect(html).not.toContain(">Requests<");
  });

  it("separates Gemini billing freshness from the latest connection update", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderCard, {
        id: "gemini",
        name: "google-ai",
        displayName: "Gemini",
        type: "builtin",
        isActive: true,
        spentUsd: 50,
        projectedEomUsd: 50,
        spendCoverage: "partial",
        snapshotCostFetchedAt: "2026-07-10T20:00:00.000Z",
        geminiBillingStatus: {
          state: "error",
          errorCode: "HTTP_ERROR",
          httpStatus: 503,
          retryable: true,
          checkedAt: "2026-07-14T23:00:00.000Z",
        },
        latestSnapshot: {
          balance: null,
          totalCost: null,
          totalRequests: null,
          credits: null,
          fetchedAt: "2026-07-14T23:00:00.000Z",
        },
      })
    );

    expect(html).toContain("Google billing failed");
    expect(html).toContain("Cost snapshot fetched");
    expect(html).toContain("Latest snapshot");
    expect(html).not.toContain("Last updated:");
  });
});
