import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { resolveUsageIngestCredential } from "../ingest-auth";

function req(token?: string, headerName = "x-usage-ingest-token"): NextRequest {
  const headers = new Headers();
  if (token) {
    headers.set(headerName, token);
  }
  return new NextRequest("https://usage.jays.services/api/ingest/usage", { headers });
}

describe("resolveUsageIngestCredential producer scoping", () => {
  const legacyToken = "shared-legacy-ingest-token";
  const producerTokens = "socratic-trade:tok-socratic, congress-trade:tok-congress, invalid_entry, :empty-prod, empty-tok:";

  beforeEach(() => {
    vi.stubEnv("USAGE_INGEST_TOKEN", legacyToken);
    vi.stubEnv("USAGE_INGEST_PRODUCER_TOKENS", producerTokens);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolves a producer-scoped token to its explicit producerId and allowedSourceApps", () => {
    const cred = resolveUsageIngestCredential(req("tok-socratic"));
    expect(cred).not.toBeNull();
    expect(cred?.credentialId).toBe("socratic-trade");
    expect(cred?.token).toBe("tok-socratic");
    expect(cred?.allowedSourceApps).toEqual(new Set(["socratic-trade"]));
  });

  it("resolves a second distinct producer-scoped token", () => {
    const cred = resolveUsageIngestCredential(req("tok-congress"));
    expect(cred).not.toBeNull();
    expect(cred?.credentialId).toBe("congress-trade");
    expect(cred?.allowedSourceApps).toEqual(new Set(["congress-trade"]));
  });

  it("returns null for an unknown producer token when no match occurs", () => {
    const cred = resolveUsageIngestCredential(req("tok-unknown"));
    expect(cred).toBeNull();
  });

  it("resolves legacy USAGE_INGEST_TOKEN to unscoped allowedSourceApps null by default", () => {
    const cred = resolveUsageIngestCredential(req(legacyToken));
    expect(cred).not.toBeNull();
    expect(cred?.credentialId).toBe("unscoped");
    expect(cred?.allowedSourceApps).toBeNull();
  });

  it("denies legacy USAGE_INGEST_TOKEN when USAGE_INGEST_REQUIRE_SCOPED_TOKENS is true", () => {
    vi.stubEnv("USAGE_INGEST_REQUIRE_SCOPED_TOKENS", "true");
    const cred = resolveUsageIngestCredential(req(legacyToken));
    expect(cred).toBeNull();
  });

  // The knob's value vocabulary is true/false/1/0/yes/no/on/off (see
  // parseBool in app-settings.ts): every "true" spelling must deny the
  // unscoped path, every "false" spelling must allow it.  Reverting the
  // getBool read to a strict === "true" must fail this suite.
  it.each(["1", "yes", "on", "TRUE", "Yes"])(
    "denies legacy USAGE_INGEST_TOKEN when USAGE_INGEST_REQUIRE_SCOPED_TOKENS is %s",
    (spelling) => {
      vi.stubEnv("USAGE_INGEST_REQUIRE_SCOPED_TOKENS", spelling);
      const cred = resolveUsageIngestCredential(req(legacyToken));
      expect(cred).toBeNull();
    }
  );

  it.each(["0", "no", "off", "FALSE"])(
    "allows legacy USAGE_INGEST_TOKEN when USAGE_INGEST_REQUIRE_SCOPED_TOKENS is %s",
    (spelling) => {
      vi.stubEnv("USAGE_INGEST_REQUIRE_SCOPED_TOKENS", spelling);
      const cred = resolveUsageIngestCredential(req(legacyToken));
      expect(cred).not.toBeNull();
      expect(cred?.credentialId).toBe("unscoped");
    }
  );

  it("safely handles malformed USAGE_INGEST_PRODUCER_TOKENS entries", () => {
    vi.stubEnv("USAGE_INGEST_PRODUCER_TOKENS", "nocolon, :emptyproducer, emptytoken:");
    const cred = resolveUsageIngestCredential(req(legacyToken));
    expect(cred).not.toBeNull();
    expect(cred?.credentialId).toBe("unscoped");
  });
});
