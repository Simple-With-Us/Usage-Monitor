import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import SubscriptionsPanel from "@/components/SubscriptionsPanel";

describe("SubscriptionsPanel", () => {
  it("shows the effective expired state and known term end without changing stored status", () => {
    const html = renderToStaticMarkup(
      createElement(SubscriptionsPanel, {
        subscriptions: [
          {
            id: "ended",
            name: "Ended plan",
            description: null,
            costUsd: 10,
            currency: "USD",
            interval: "annual",
            intervalCount: 1,
            monthlyEquivalentUsd: 10 / 12,
            anchorDay: null,
            startDate: "2019-01-01T00:00:00.000Z",
            currentPeriodStart: "2019-01-01T00:00:00.000Z",
            nextRenewalAt: "2020-01-01T00:00:00.000Z",
            autoRenew: false,
            status: "active",
            effectiveStatus: "expired",
            notes: null,
            externalBillingSource: null,
            externalBillingId: null,
            knobEnv: null,
            freeTierKnobEnv: null,
            provider: { id: "provider", name: "demo", displayName: "Demo" },
            project: null,
          },
        ],
        onAdd: vi.fn(),
        onEdit: vi.fn(),
        onDelete: vi.fn(),
        deleteConfirm: null,
        setDeleteConfirm: vi.fn(),
        actionLoading: null,
      })
    );

    expect(html).toContain("expired");
    expect(html).toContain("ended");
  });
});

describe("SubscriptionsPanel load error vs genuine empty", () => {
  function renderEmptyPanel(extraProps: { loadError?: string | null; onRetryLoad?: () => void } = {}) {
    return renderToStaticMarkup(
      createElement(SubscriptionsPanel, {
        subscriptions: [],
        onAdd: vi.fn(),
        onEdit: vi.fn(),
        onDelete: vi.fn(),
        deleteConfirm: null,
        setDeleteConfirm: vi.fn(),
        actionLoading: null,
        ...extraProps,
      })
    );
  }

  it("renders the explicit failure panel with a Retry button when the load failed", () => {
    const html = renderEmptyPanel({
      loadError: "Failed to fetch subscriptions",
      onRetryLoad: vi.fn(),
    });

    expect(html).toContain('role="alert"');
    expect(html).toContain("Subscriptions couldn&#x27;t be loaded.");
    expect(html).toContain("Failed to fetch subscriptions");
    expect(html).toContain("Retry");
    // An outage must never masquerade as an empty account — no CTA to add a
    // (potentially duplicate) subscription.
    expect(html).not.toContain("No subscriptions tracked yet.");
    expect(html).not.toContain("Add your first subscription");
  });

  it("renders the empty-state CTA only when the load succeeded with zero subscriptions", () => {
    const html = renderEmptyPanel();

    expect(html).toContain("No subscriptions tracked yet.");
    expect(html).toContain("Add your first subscription");
    expect(html).not.toContain('role="alert"');
  });
});
