import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ProviderTable from "@/components/ProviderTable";
import type { Provider } from "@/app/settings/page";

function provider(overrides: Partial<Provider>): Provider {
  return {
    id: "provider-1",
    name: "openai",
    displayName: "OpenAI",
    type: "builtin",
    isActive: true,
    refreshIntervalMin: 60,
    groupId: null,
    label: null,
    plan: null,
    allocations: [],
    alerts: [],
    estimatedMonthlyCostUsd: 0,
    spentUsd: 0,
    projectedEomUsd: 0,
    spendCoverage: "complete",
    pushedCostCoverage: "complete",
    pushedPricedEventCount: 1,
    pushedUnpricedEventCount: 0,
    pushedUnclassifiedCostEventCount: 0,
    billingMode: "actual",
    createdAt: "2026-07-13T00:00:00.000Z",
    latestSnapshot: null,
    ...overrides,
  };
}

function renderTable(providers: Provider[]) {
  const noop = vi.fn();
  return renderToStaticMarkup(
    createElement(ProviderTable, {
      providers,
      actionLoading: null,
      deleteConfirm: null,
      onEdit: noop,
      onDeleteConfirmStart: noop,
      onDeleteConfirmCancel: noop,
      onDelete: noop,
      onAddProvider: noop,
      onToggleActive: noop,
      onFetchNow: noop,
    })
  );
}

describe("ProviderTable cost coverage", () => {
  it("distinguishes partial known spend from unknown cost", () => {
    const html = renderTable([
      provider({
        id: "partial",
        spentUsd: 12.5,
        projectedEomUsd: 20,
        spendCoverage: "partial",
        pushedUnpricedEventCount: 2,
      }),
      provider({
        id: "unknown",
        displayName: "Gemini",
        name: "google-ai",
        spendCoverage: "unknown",
        pushedCostCoverage: "unknown",
        pushedPricedEventCount: 0,
        pushedUnpricedEventCount: 1,
      }),
    ]);

    expect(html).toContain("Known group spend");
    expect(html).toContain("2 incomplete");
    expect(html).toContain("$12.50 known MTD");
    expect(html).toContain("2 unpriced events");
    expect(html).toContain("Cost not reported");
    expect(html).toContain("Projection unavailable");
  });

  it("keeps a complete explicit zero as zero", () => {
    const html = renderTable([provider({ spentUsd: 0, spendCoverage: "complete" })]);

    expect(html).toContain("$0.00 MTD");
    expect(html).not.toContain("Cost not reported");
  });

  it("hides Fetch Now when Anthropic has no organization Admin key", () => {
    const individualHtml = renderTable([
      provider({ name: "anthropic", displayName: "Anthropic individual" }),
    ]);
    const organizationHtml = renderTable([
      provider({
        name: "anthropic",
        displayName: "Anthropic organization",
        anthropicAdminApiConfigured: true,
        secretConfigMeta: {
          configured: true,
          fields: ["adminApiKey"],
          readable: true,
        },
      }),
    ]);

    expect(individualHtml).not.toContain("Fetch Now");
    expect(individualHtml).toContain("Push / manual");
    expect(organizationHtml).toContain("Fetch Now");
    expect(organizationHtml).toContain("Active");
  });

  it("hides Fetch Now for generic and push-only providers", () => {
    const manualHtml = renderTable([
      provider({
        id: "manual",
        name: "manual-service",
        displayName: "Manual service",
        type: "generic",
      }),
    ]);
    const pushHtml = renderTable([
      provider({
        id: "push",
        name: "voyage",
        displayName: "Voyage push",
        type: "push",
      }),
    ]);
    const customHtml = renderTable([
      provider({
        id: "custom",
        name: "custom",
        displayName: "Custom endpoint",
        type: "custom",
      }),
    ]);
    const manualProviderHtml = renderTable([
      provider({
        id: "manual_provider",
        name: "openai",
        displayName: "OpenAI",
        type: "manual_provider",
      }),
    ]);

    expect(manualHtml).not.toContain("Fetch Now");
    expect(manualHtml).toContain("Push / manual");
    expect(pushHtml).not.toContain("Fetch Now");
    expect(pushHtml).toContain("Push / manual");
    expect(customHtml).toContain("Fetch Now");
    expect(customHtml).toContain(">Active<");
    expect(manualProviderHtml).not.toContain("Fetch Now");
    expect(manualProviderHtml).toContain("Push / manual");
  });

  it("shows Gemini key health separately from billing availability", () => {
    const rejectedHtml = renderTable([
      provider({
        name: "google-ai",
        displayName: "Google AI",
        geminiKeyStatus: {
          state: "invalid",
          httpStatus: 403,
          availableModelCount: null,
          checkedAt: "2026-07-14T23:00:00.000Z",
        },
        geminiBillingStatus: {
          state: "pending",
          errorCode: null,
          httpStatus: null,
          retryable: false,
          checkedAt: "2026-07-14T23:00:00.000Z",
        },
        geminiMonitoringStatus: {
          state: "permission_denied",
          projectId: "gemini-production",
          errorCode: "HTTP_ERROR",
          httpStatus: 403,
          retryable: false,
          checkedAt: "2026-07-14T23:00:00.000Z",
        },
        snapshotCostFetchedAt: "2026-07-10T20:00:00.000Z",
      }),
    ]);

    expect(rejectedHtml).toContain("Key rejected");
    expect(rejectedHtml).toContain("Verify &amp; fetch");
    expect(rejectedHtml).toContain("Billing pending");
    expect(rejectedHtml).toContain("Usage permission denied");
    expect(rejectedHtml).toContain("Cost snapshot fetched");
    expect(rejectedHtml).toContain(">Active<");
  });

  it("shows a transient Gemini check as unavailable instead of rejected", () => {
    const unavailableHtml = renderTable([
      provider({
        name: "google-ai",
        displayName: "Google AI",
        geminiKeyStatus: {
          state: "unavailable",
          httpStatus: 503,
          availableModelCount: null,
          checkedAt: "2026-07-14T23:00:00.000Z",
        },
      }),
    ]);

    expect(unavailableHtml).toContain("Check unavailable");
    expect(unavailableHtml).toContain("Verify &amp; fetch");
    expect(unavailableHtml).not.toContain("Key rejected");
    expect(unavailableHtml).toContain(">Active<");
  });

  it("requires a fresh Monitoring check after the Google project identity changes", () => {
    const html = renderTable([
      provider({
        name: "google-ai",
        displayName: "Google AI",
        geminiMonitoringStatus: {
          state: "configuration_changed",
          projectId: "gemini-production",
          errorCode: null,
          httpStatus: null,
          retryable: false,
          checkedAt: null,
        },
      }),
    ]);

    expect(html).toContain("Usage configuration changed");
  });

  it("shows a cost coverage gap warning when the adapter flags one", () => {
    const html = renderTable([
      provider({
        id: "cloudflare",
        name: "cloudflare",
        displayName: "Cloudflare",
        spentUsd: 5,
        spendCoverage: "complete",
        costCoverageCaveat: {
          code: "cloudflare_paygo_usage_unavailable",
          message: "Usage-based costs (D1, R2, Workers, Queues overage) are not visible for this account — only the fixed subscription fee is shown. Cost may be understated.",
        },
      }),
    ]);

    // Default density is compact: short label plus a touch/keyboard disclosure.
    expect(html).toContain("Coverage gap");
    expect(html).toContain("Billing detail");
    expect(html).toContain("<details");
    expect(html).toContain(
      "Usage-based costs (D1, R2, Workers, Queues overage) are not visible"
    );
  });

  it("omits the cost coverage gap warning when the adapter did not flag one", () => {
    const html = renderTable([
      provider({
        id: "cloudflare",
        name: "cloudflare",
        displayName: "Cloudflare",
        spentUsd: 5,
        spendCoverage: "complete",
      }),
    ]);

    expect(html).not.toContain("Coverage gap");
    expect(html).not.toContain("Cost coverage gap");
  });
});
