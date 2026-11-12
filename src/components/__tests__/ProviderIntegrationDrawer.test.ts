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
          keyPreview: "abcdef...9876",
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
    expect(html).toContain("Configured · abcdef...9876");
    expect(html).toContain("first six and last four characters");
    expect(html).toContain("accountId, r2BucketName");
    expect(html).toContain("apiToken");
    expect(html).toContain("cloudflare-subscriptions");
    expect(html).toContain("What this app reads");
    expect(html).toContain("What is shared back with the service");
    expect(html).toContain("Billing and subscription coverage");
    expect(html).toContain("single-resource D1/R2/KV/Queue metadata probes");
    expect(html).toContain(
      "do not affect billing, subscriptions, spend, usage, quotas, or PayGo eligibility"
    );
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

  it.each([
    ["generic", "manual-service"],
    ["push", "voyage"],
  ])("marks %s provider polling as not applicable", (providerType, providerName) => {
    const html = renderToStaticMarkup(
      createElement(ProviderIntegrationDrawer, {
        providerName,
        providerType,
        displayName: "Push/manual service",
        instanceState: {
          isActive: true,
          primaryCredentialConfigured: false,
          publicConfigFields: [],
          protectedConfigFields: [],
          externalBillingRecordCount: 0,
          externalBillingSources: [],
        },
        onClose: vi.fn(),
      })
    );

    expect(html).toContain("Manually only · no fetch");
    expect(html).not.toContain(">Active<");
  });

  it("shows individual Anthropic billing as skipped instead of broken polling", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderIntegrationDrawer, {
        providerName: "anthropic",
        providerType: "builtin",
        displayName: "Anthropic",
        instanceState: {
          isActive: true,
          primaryCredentialConfigured: true,
          keyPreview: "sk-ant...1234",
          anthropicAdminApiConfigured: false,
          publicConfigFields: [],
          protectedConfigFields: [],
          protectedConfigReadable: true,
          lastSnapshotAt: null,
          externalBillingRecordCount: 0,
          externalBillingSources: [],
        },
        onClose: vi.fn(),
      })
    );

    expect(html).toContain("Manually only · no fetch");
    expect(html).toContain("Legacy Messages credential");
    expect(html).toContain("not polled");
  });

  it("recognizes an organization Admin key stored in a legacy primary field", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderIntegrationDrawer, {
        providerName: "anthropic",
        providerType: "builtin",
        displayName: "Anthropic organization",
        instanceState: {
          isActive: true,
          primaryCredentialConfigured: true,
          keyPreview: "sk-ant...1234",
          anthropicAdminApiConfigured: true,
          publicConfigFields: [],
          protectedConfigFields: [],
          protectedConfigReadable: true,
          lastSnapshotAt: null,
          externalBillingRecordCount: 0,
          externalBillingSources: [],
        },
        onClose: vi.fn(),
      })
    );

    expect(html).toContain("Active");
    expect(html).not.toContain("Skipped · no organization Admin API");
  });

  it("shows an inactive individual Anthropic row as inactive", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderIntegrationDrawer, {
        providerName: "anthropic",
        providerType: "builtin",
        displayName: "Inactive Anthropic",
        instanceState: {
          isActive: false,
          primaryCredentialConfigured: false,
          anthropicAdminApiConfigured: false,
          publicConfigFields: [],
          protectedConfigFields: [],
          protectedConfigReadable: true,
          lastSnapshotAt: null,
          externalBillingRecordCount: 0,
          externalBillingSources: [],
        },
        onClose: vi.fn(),
      })
    );

    expect(html).toContain("Inactive");
    expect(html).not.toContain("Skipped · no organization Admin API");
  });

  it("explains that Gemini key validation is independent from billing", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderIntegrationDrawer, {
        providerName: "google-ai",
        providerType: "builtin",
        displayName: "Socratic Trade Gemini",
        instanceState: {
          isActive: true,
          primaryCredentialConfigured: true,
          keyPreview: "test-k...1234",
          publicConfigFields: ["billingDataset", "googleProjectId"],
          protectedConfigFields: ["serviceAccountJson"],
          protectedConfigReadable: true,
          lastSnapshotAt: "2026-07-14T23:00:00.000Z",
          externalBillingRecordCount: 1,
          externalBillingSources: ["google-cloud-billing-export"],
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
            projectId: "socratic-trade",
            errorCode: "HTTP_ERROR",
            httpStatus: 403,
            retryable: false,
            checkedAt: "2026-07-14T23:00:00.000Z",
          },
        },
        onClose: vi.fn(),
      })
    );

    expect(html).toContain("Gemini key validation");
    expect(html).toContain("Rejected by Gemini API · HTTP 403");
    expect(html).toContain("Generative Language API");
    expect(html).toContain("Google Cloud Billing sync");
    expect(html).toContain("Pending · export has not published priced rows yet");
    expect(html).toContain("Pending is not $0");
    expect(html).toContain("Google Cloud Monitoring sync");
    expect(html).toContain("Permission denied · HTTP 403");
    expect(html).toContain("Monitoring Viewer");
    expect(html).toContain("Billing export access is separate");
    expect(html).toContain("google-cloud-billing-export");
  });

  it.each([429, 503])(
    "explains that a Gemini HTTP %i check failure is temporary",
    (statusCode) => {
      const html = renderToStaticMarkup(
        createElement(ProviderIntegrationDrawer, {
          providerName: "google-ai",
          providerType: "builtin",
          displayName: "Congress Trade Gemini",
          instanceState: {
            isActive: true,
            primaryCredentialConfigured: true,
            publicConfigFields: [],
            protectedConfigFields: [],
            externalBillingRecordCount: 0,
            externalBillingSources: [],
            geminiKeyStatus: {
              state: "unavailable",
              httpStatus: statusCode,
              availableModelCount: null,
              checkedAt: "2026-07-14T23:00:00.000Z",
            },
            geminiBillingStatus: {
              state: "error",
              errorCode: "HTTP_ERROR",
              httpStatus: 503,
              retryable: true,
              checkedAt: "2026-07-14T23:00:00.000Z",
            },
          },
          onClose: vi.fn(),
        })
      );

      expect(html).toContain(`Check unavailable · HTTP ${statusCode}`);
      expect(html).toContain("transient, quota, or service error");
      expect(html).toContain("billing sync reports its own result");
      expect(html).toContain("Failed · HTTP 503 · HTTP_ERROR");
      expect(html).toContain("same billing configuration remains visible but incomplete");
      expect(html).toContain("prior configuration is excluded");
      expect(html).not.toContain("Enable the Generative Language API");
    }
  );

  it("distinguishes an unreadable stored Gemini key from a missing key", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderIntegrationDrawer, {
        providerName: "google-ai",
        providerType: "builtin",
        displayName: "Gemini",
        instanceState: {
          isActive: true,
          primaryCredentialConfigured: true,
          publicConfigFields: [],
          protectedConfigFields: [],
          externalBillingRecordCount: 0,
          externalBillingSources: [],
          geminiKeyStatus: {
            state: "unreadable",
            httpStatus: null,
            availableModelCount: null,
            checkedAt: null,
          },
        },
        onClose: vi.fn(),
      })
    );

    expect(html).toContain("Stored key cannot be decrypted");
    expect(html).toContain("save the Gemini key again");
    expect(html).not.toContain("Primary credential</dt><dd class=\"mt-1 font-medium text-gray-900\">Not configured");
  });

  it("shows a neutral label with no partial digits when no key preview is available (managed credential or short key)", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderIntegrationDrawer, {
        providerName: "cloudflare",
        providerType: "builtin",
        displayName: "Managed Cloudflare",
        instanceState: {
          isActive: true,
          primaryCredentialConfigured: true,
          keyPreview: null,
          publicConfigFields: ["accountId"],
          protectedConfigFields: ["apiToken"],
          protectedConfigReadable: true,
          lastSnapshotAt: null,
          externalBillingRecordCount: 0,
          externalBillingSources: [],
        },
        onClose: vi.fn(),
      })
    );

    expect(html).toContain("Configured");
    expect(html).not.toContain("••••");
    expect(html).not.toMatch(/Configured\s*·\s*[a-zA-Z0-9]/);
  });
});
