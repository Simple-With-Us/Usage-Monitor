import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ProviderIntegrationDrawer from "@/components/ProviderIntegrationDrawer";

describe("ProviderIntegrationDrawer", () => {
  it("renders an accessible dialog with account boundaries and integration coverage", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderIntegrationDrawer, {
        providerName: "cloudflare",
        providerType: "builtin",
        displayName: "Cloudflare Production",
        instanceState: {
          isActive: true,
          primaryCredentialConfigured: true,
          keyPreview: "1234",
          publicConfigFields: ["accountId", "r2BucketName"],
          protectedConfigFields: ["apiToken"],
          protectedConfigReadable: true,
          lastSnapshotAt: "2026-07-11T12:00:00.000Z",
          externalBillingRecordCount: 2,
          externalBillingSources: ["cloudflare-subscriptions"],
        },
        onClose: vi.fn(),
      })
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("Cloudflare Production");
    expect(html).toContain("Account boundaries");
    expect(html).toContain("Current configured state");
    expect(html).toContain("•••• 1234");
    expect(html).toContain("accountId, r2BucketName");
    expect(html).toContain("apiToken");
    expect(html).toContain("cloudflare-subscriptions");
    expect(html).toContain("What this app reads");
    expect(html).toContain("What is shared back with the service");
    expect(html).toContain("Billing and subscription coverage");
    expect(html).toContain("Confidence and source date");
    expect(html).toContain("Close Cloudflare Production integration details");
  });

  it("uses custom/manual semantics for arbitrary provider slugs", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderIntegrationDrawer, {
        providerName: "internal-meter",
        providerType: "custom",
        displayName: "Internal meter",
        onClose: vi.fn(),
      })
    );

    expect(html).toContain("Custom endpoint");
    expect(html).toContain("arbitrary full response is not persisted");
    expect(html).toContain("SSRF-checked");
  });
});
