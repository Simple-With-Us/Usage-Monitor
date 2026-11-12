import { describe, expect, it } from "vitest";
import { BUILT_IN_PROVIDERS } from "@/lib/provider-definitions";
import {
  getProviderIntegrationProfile,
  PROVIDER_INTEGRATION_PROFILES,
} from "@/lib/provider-integration-catalog";

describe("provider integration catalog", () => {
  it("covers every addable built-in plus system/custom/manual adapters exactly once", () => {
    const names = PROVIDER_INTEGRATION_PROFILES.map((profile) => profile.name);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(names)).toEqual(
      new Set([
        ...BUILT_IN_PROVIDERS.filter((provider) => provider.lifecycle == null).map((provider) => provider.name),
        "ag***-s**c-relay",
        "custom",
        "generic",
      ])
    );
  });

  it("keeps retired profiles resolvable for historical records without listing them in the connection catalog", () => {
    const listed = new Set<string>(
      PROVIDER_INTEGRATION_PROFILES.map((profile) => profile.name)
    );
    for (const name of ["tradier", "intrinio", "alpaca", "robinhood", "vercel", "firecrawl", "deno"]) {
      expect(listed.has(name), name).toBe(false);
      expect(getProviderIntegrationProfile(name, "builtin").name).toBe(name);
    }
  });

  it("keeps every profile complete, dated, and free of secret values", () => {
    for (const profile of PROVIDER_INTEGRATION_PROFILES) {
      expect(profile.summary.length).toBeGreaterThan(20);
      expect(profile.reads.length).toBeGreaterThan(0);
      expect(profile.stores.length).toBeGreaterThan(0);
      expect(profile.shares.length).toBeGreaterThan(0);
      expect(profile.credentialInputs.length).toBeGreaterThan(0);
      expect(profile.canAdd.length).toBeGreaterThan(0);
      expect(profile.cannotAdd.length).toBeGreaterThan(0);
      expect(profile.limitations.length).toBeGreaterThan(0);
      expect(profile.provenance.reviewedOn).toBe("2026-07-13");
      expect(profile.provenance.sources[0]).toMatch(/^src\//);
      expect(JSON.stringify(profile)).not.toMatch(/sk-(?:admin|ant|proj)-[A-Za-z0-9]/);
    }
  });

  it("resolves aliases and uses provider type for arbitrary custom/manual names", () => {
    expect(getProviderIntegrationProfile("google_ai").name).toBe("google-ai");
    for (const alias of [
      "gemini",
      "gemini-api",
      "gemini.api",
      "generative-language",
      "google-ai-studio",
      "Google Gemini",
      "googlegemini",
    ]) {
      expect(getProviderIntegrationProfile(alias, "builtin").name, alias).toBe("google-ai");
    }
    expect(getProviderIntegrationProfile("ag***_s**c_relay").name).toBe("ag***-s**c-relay");
    expect(getProviderIntegrationProfile("private-service", "custom").name).toBe("custom");
    expect(getProviderIntegrationProfile("manual-service", "generic").name).toBe("generic");
    expect(getProviderIntegrationProfile("google-gemini", "push").name).toBe("generic");
    expect(getProviderIntegrationProfile("unknown").name).toBe("generic");
  });

  it("documents Cloudflare Billing Read auth and restricted PayGo behavior", () => {
    const cloudflare = getProviderIntegrationProfile("cloudflare");

    expect(cloudflare.billing.visibility).toBe("actual");
    expect(cloudflare.credentialInputs.join(" ")).toMatch(/Account ID/i);
    expect(cloudflare.credentialInputs.join(" ")).toMatch(/scoped API token/i);
    expect(cloudflare.cannotAdd.join(" ")).toMatch(/error 10000/i);
    expect(cloudflare.limitations.join(" ")).toMatch(/Global API key/i);
    expect(cloudflare.credentialInputs.join(" ")).toMatch(
      /single-resource metadata\/readability probes only/i
    );
    expect(cloudflare.limitations.join(" ")).toMatch(
      /do not affect billing, subscriptions, spend, usage, quotas, or PayGo eligibility/i
    );
  });

  it("documents the Anthropic individual-account billing boundary and fallback", () => {
    const anthropic = getProviderIntegrationProfile("anthropic");

    expect(anthropic.mode).toBe("partial");
    expect(anthropic.billing.visibility).toBe("partial");
    expect(anthropic.summary).toMatch(/Individual accounts rely on.*pushed/i);
    expect(anthropic.cannotAdd.join(" ")).toMatch(
      /does not offer the Admin or Usage & Cost APIs to individual accounts/i
    );
    expect(anthropic.shares.join(" ")).toMatch(
      /standard Messages API key is not sent/i
    );
  });

  it("labels ChatGPT/Codex, SuperGrok, and Antigravity subscriptions as not fetchable", () => {
    const openai = getProviderIntegrationProfile("openai");
    const xai = getProviderIntegrationProfile("xai");
    const google = getProviderIntegrationProfile("google-ai");
    expect(openai.cannotAdd.join(" ")).toMatch(/MANUALLY ONLY/i);
    expect(xai.cannotAdd.join(" ")).toMatch(/SuperGrok/i);
    expect(google.cannotAdd.join(" ")).toMatch(/Antigravity/i);
  });

  it("says Deno Deploy is retired and Coolify is the Congress.Trade host", () => {
    const deno = getProviderIntegrationProfile("deno", "builtin");

    expect(deno.summary).toMatch(/retired/i);
    expect(deno.summary).toMatch(/Coolify/i);
    expect(deno.summary).toMatch(/Congress\.Trade/i);
    expect(deno.billing.summary).toMatch(/not a live production host/i);
    expect(deno.limitations.join(" ")).toMatch(/do not host on Deno Deploy/i);
    expect(deno.canAdd.join(" ")).not.toMatch(/when Deno Deploy publishes/i);
  });

  it("documents Firecrawl history as private, non-money metadata", () => {
    const firecrawl = getProviderIntegrationProfile("firecrawl");

    expect(firecrawl.billing.visibility).toBe("metadata");
    expect(firecrawl.reads.join(" ")).toMatch(/byApiKey explicitly disabled/i);
    expect(firecrawl.stores.join(" ")).toMatch(/non-money metadata/i);
    expect(firecrawl.stores.join(" ")).toMatch(/no .*API-key identifier/i);
    expect(firecrawl.limitations.join(" ")).toMatch(/not pruned/i);
    expect(firecrawl.cannotAdd.join(" ")).toMatch(/cannot be converted to USD/i);
  });

  it("exposes required adapter config and does not solicit unused blind-adapter keys", () => {
    const byName = new Map(BUILT_IN_PROVIDERS.map((provider) => [provider.name, provider]));
    expect(byName.get("langfuse")?.needsConfig?.fields.map((field) => field.key)).toEqual([
      "publicKey",
      "secretKey",
      "host",
    ]);
    expect(byName.get("alpaca")?.needsConfig).toBeUndefined();
    expect(byName.get("twilio")?.needsConfig?.fields.map((field) => field.key)).toContain("apiKeySid");
    expect(byName.get("llamaindex")?.needsConfig?.fields.map((field) => field.key)).toEqual([
      "projectId",
      "host",
    ]);
    expect(byName.get("google-ai")?.needsConfig?.fields.map((field) => field.key)).toEqual([
      "billingDataset",
      "serviceAccountJson",
      "googleProjectId",
      "billingTable",
    ]);
    expect(
      byName.get("google-ai")?.needsConfig?.fields.find((field) => field.key === "serviceAccountJson")?.type
    ).toBe("textarea");

    for (const name of [
      "voyage",
      "fmp",
      "finnhub",
      "alphavantage",
      "marketstack",
      "tiingo",
      "massive",
      "fred",
      "quiver-quant",
      "robinhood",
    ]) {
      expect(byName.get(name)?.usesApiKey, name).toBe(false);
    }
    expect(byName.get("fintech-studios")?.usesApiKey).not.toBe(false);
    expect(byName.get("render")?.needsConfig).toBeUndefined();
    expect(byName.get("langfuse")?.defaultRefreshIntervalMin).toBe(360);
    for (const name of ["voyage", "langfuse", "llamaindex"]) {
      expect(byName.get(name)?.creditBased, name).not.toBe(true);
    }
  });
});
