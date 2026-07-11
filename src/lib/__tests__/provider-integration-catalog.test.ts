import { describe, expect, it } from "vitest";
import { BUILT_IN_PROVIDERS } from "@/lib/provider-definitions";
import {
  getProviderIntegrationProfile,
  PROVIDER_INTEGRATION_PROFILES,
} from "@/lib/provider-integration-catalog";

describe("provider integration catalog", () => {
  it("covers every Add Provider built-in plus system/custom/manual adapters exactly once", () => {
    const names = PROVIDER_INTEGRATION_PROFILES.map((profile) => profile.name);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(names)).toEqual(
      new Set([
        ...BUILT_IN_PROVIDERS.map((provider) => provider.name),
        "agent-sync-relay",
        "custom",
        "generic",
      ])
    );
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
      expect(profile.provenance.reviewedOn).toBe("2026-07-11");
      expect(profile.provenance.sources[0]).toMatch(/^src\//);
      expect(JSON.stringify(profile)).not.toMatch(/sk-(?:admin|ant|proj)-[A-Za-z0-9]/);
    }
  });

  it("resolves aliases and uses provider type for arbitrary custom/manual names", () => {
    expect(getProviderIntegrationProfile("google_ai").name).toBe("google-ai");
    expect(getProviderIntegrationProfile("agent_sync_relay").name).toBe("agent-sync-relay");
    expect(getProviderIntegrationProfile("private-service", "custom").name).toBe("custom");
    expect(getProviderIntegrationProfile("manual-service", "generic").name).toBe("generic");
    expect(getProviderIntegrationProfile("unknown").name).toBe("generic");
  });

  it("exposes required adapter config and does not solicit unused blind-adapter keys", () => {
    const byName = new Map(BUILT_IN_PROVIDERS.map((provider) => [provider.name, provider]));
    expect(byName.get("langfuse")?.needsConfig?.fields.map((field) => field.key)).toEqual([
      "publicKey",
      "secretKey",
      "host",
    ]);
    expect(byName.get("alpaca")?.needsConfig?.fields.map((field) => field.key)).toEqual([
      "apiSecret",
      "environment",
    ]);
    expect(byName.get("twilio")?.needsConfig?.fields.map((field) => field.key)).toContain("apiKeySid");
    expect(byName.get("llamaindex")?.needsConfig?.fields.map((field) => field.key)).toEqual([
      "projectId",
      "host",
    ]);

    for (const name of [
      "voyage",
      "fmp",
      "finnhub",
      "alphavantage",
      "marketstack",
      "tiingo",
      "fintech-studios",
      "massive",
      "fred",
      "robinhood",
    ]) {
      expect(byName.get(name)?.usesApiKey, name).toBe(false);
    }
    for (const name of ["voyage", "langfuse", "llamaindex"]) {
      expect(byName.get(name)?.creditBased, name).not.toBe(true);
    }
  });
});
