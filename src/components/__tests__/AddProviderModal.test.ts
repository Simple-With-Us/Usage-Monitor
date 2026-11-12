import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import AddProviderModal, {
  CLOUDFLARE_RESOURCE_PROBE_DISCLOSURE,
  actualUsageBillingPlan,
  type ProviderPlan,
  validateGoogleIntegrationSubmission,
  withoutGoogleBillingConfig,
} from "@/components/AddProviderModal";
import { isMustKeepFundedOptionVisible } from "@/lib/provider-funding-policy";

describe("AddProviderModal billing normalization", () => {
  const manualPlan: ProviderPlan = {
    billingMode: "manual",
    fixedMonthlyCostUsd: 25,
    monthlyBudgetUsd: 100,
    monthlyRequestLimit: 10_000,
    lowBalanceUsd: 5,
    lowCredits: null,
    renewalDate: "2026-08-01",
    billingInterval: "monthly",
    mustKeepFunded: true,
    notes: "Preserve non-charge settings",
  };

  it("preserves manual price and renewal facts until actual billing is reconciled", () => {
    expect(actualUsageBillingPlan(manualPlan)).toEqual({
      ...manualPlan,
      billingMode: "actual",
    });
    expect(manualPlan).toMatchObject({
      billingMode: "manual",
      fixedMonthlyCostUsd: 25,
      renewalDate: "2026-08-01",
    });
  });

  it("removes only Google billing connection fields", () => {
    const config = {
      billingDataset: "billing-project.billing_export",
      googleProjectId: "gemini-production",
      billingTable: "gcp_billing_export_v1_ABC",
      serviceAccountJson: "secret-json",
      statusKeyRef: "gemini-primary",
      unrelated: "keep-me",
    };

    expect(withoutGoogleBillingConfig(config)).toEqual({
      statusKeyRef: "gemini-primary",
      unrelated: "keep-me",
    });
    expect(config).toHaveProperty("serviceAccountJson", "secret-json");
  });

  it("accepts project plus service account for Monitoring without changing billing mode", () => {
    expect(
      validateGoogleIntegrationSubmission({
        config: {
          googleProjectId: "gemini-production",
          serviceAccountJson: "secret-json",
        },
        plan: manualPlan,
      })
    ).toEqual(manualPlan);
  });

  it("rejects a Monitoring project without a service account", () => {
    expect(() =>
      validateGoogleIntegrationSubmission({
        config: { googleProjectId: "gemini-production" },
        plan: manualPlan,
      })
    ).toThrow("Google service-account JSON is required for Cloud Monitoring");
  });

  it("rejects an invalid Gemini project identifier before submission", () => {
    expect(() =>
      validateGoogleIntegrationSubmission({
        config: {
          googleProjectId: "projects/gemini-production",
          serviceAccountJson: "secret-json",
        },
        plan: manualPlan,
      })
    ).toThrow("Exact Gemini project ID is not a valid Google Cloud project ID");
  });

  it("rejects a billing dataset without a service account", () => {
    expect(() =>
      validateGoogleIntegrationSubmission({
        config: { billingDataset: "billing-project.billing_export" },
        plan: manualPlan,
      })
    ).toThrow("Google service-account JSON is required for Cloud Billing");
  });

  it("accepts dataset plus service account and marks only billing as actual", () => {
    expect(
      validateGoogleIntegrationSubmission({
        config: {
          billingDataset: "billing-project.billing_export",
          serviceAccountJson: "secret-json",
        },
        plan: manualPlan,
      })
    ).toEqual({ ...manualPlan, billingMode: "actual" });
  });

  it("groups Cloudflare resource IDs as optional metadata probes with no money-path effect", () => {
    const html = renderToStaticMarkup(
      createElement(AddProviderModal, {
        open: true,
        onClose: () => undefined,
        onSave: async () => undefined,
        editProvider: {
          id: "cloudflare-provider",
          name: "cloudflare",
          displayName: "Cloudflare",
          type: "builtin",
          config: { accountId: "account-id", authMode: "api_token" },
        },
      })
    );

    // Wizard opens on Type step — credential probe fields are step-gated.
    expect(html).toContain('aria-label="Provider setup steps"');
    expect(html).toContain("Step 1/4");
    expect(html).toContain("Next");
    expect(CLOUDFLARE_RESOURCE_PROBE_DISCLOSURE).toMatch(/metadata/i);
    expect(CLOUDFLARE_RESOURCE_PROBE_DISCLOSURE).toMatch(/do not affect billing/i);
  });

  it("hides Must stay funded for LLM/AI names and keeps it for other builtins", () => {
    expect(isMustKeepFundedOptionVisible("openrouter")).toBe(false);
    expect(isMustKeepFundedOptionVisible("anthropic")).toBe(false);
    expect(isMustKeepFundedOptionVisible("twilio")).toBe(true);
    expect(isMustKeepFundedOptionVisible("cloudflare")).toBe(true);
  });
});
