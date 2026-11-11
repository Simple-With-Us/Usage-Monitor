import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  resolveOtlpTracesCredential,
  resolveUsageIngestCredential,
} from "../ingest-auth";

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

describe("resolveOtlpTracesCredential trace-only scoping", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts a trace-only producer token without authorizing usage ingest", () => {
    vi.stubEnv("OTLP_TRACES_PRODUCER_TOKENS", "openrouter:trace-only-token");
    const request = req("trace-only-token");

    const traceCredential = resolveOtlpTracesCredential(request);
    expect(traceCredential?.credentialId).toBe("openrouter");
    expect(traceCredential?.allowedSourceApps).toEqual(new Set(["openrouter"]));
    expect(resolveUsageIngestCredential(request)).toBeNull();
  });
});

describe("resolveUsageIngestCredential producer aliases (UM-1599)", () => {
  beforeEach(() => {
    vi.stubEnv("USAGE_INGEST_TOKEN", "shared-legacy-ingest-token");
    vi.stubEnv("USAGE_INGEST_PRODUCER_TOKENS", "openai-codex:tok-codex, socratic-trade:tok-socratic");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("lets the openai-codex producer token also write harness codex", () => {
    const cred = resolveUsageIngestCredential(req("tok-codex"));
    expect(cred?.credentialId).toBe("openai-codex");
    expect(cred?.allowedSourceApps).toEqual(new Set(["openai-codex", "codex"]));
  });

  it("does not extend the alias to other producers or to wildcard names", () => {
    const cred = resolveUsageIngestCredential(req("tok-socratic"));
    expect(cred?.allowedSourceApps).toEqual(new Set(["socratic-trade"]));
    expect(cred?.allowedSourceApps?.has("codex")).toBe(false);
    expect(cred?.allowedSourceApps?.has("claude-code")).toBe(false);
  });

  it("keeps the alias when unscoped tokens are disabled", () => {
    vi.stubEnv("USAGE_INGEST_REQUIRE_SCOPED_TOKENS", "true");
    expect(resolveUsageIngestCredential(req("shared-legacy-ingest-token"))).toBeNull();
    const cred = resolveUsageIngestCredential(req("tok-codex"));
    expect(cred?.allowedSourceApps?.has("codex")).toBe(true);
  });
});
