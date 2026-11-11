import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { isBillingReceiptIngestAuthorized, resolveUsageIngestCredential } from "../ingest-auth";

const request = (token: string) => new NextRequest("https://example.test/api/ingest/usage", {
  headers: { authorization: `Bearer ${token}` },
});

describe("bounded usage token rotation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-30T20:00:00Z"));
    vi.stubEnv("USAGE_INGEST_TOKEN", "replacement");
    vi.stubEnv("USAGE_INGEST_PREVIOUS_TOKEN", "previous");
    vi.stubEnv("USAGE_INGEST_PREVIOUS_TOKEN_VALID_FROM", "2026-10-30T19:30:00Z");
    vi.stubEnv("USAGE_INGEST_PREVIOUS_TOKEN_VALID_UNTIL", "2026-10-30T20:30:00Z");
    vi.stubEnv("USAGE_INGEST_REQUIRE_SCOPED_TOKENS", "false");
    vi.stubEnv("USAGE_INGEST_PRODUCER_TOKENS", "claude-code:scoped");
    vi.stubEnv("BILLING_RECEIPT_INGEST_TOKEN", "receipt-only");
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

  it("accepts both usage tokens only within the fixed window", () => {
    expect(resolveUsageIngestCredential(request("replacement"))).not.toBeNull();
    expect(resolveUsageIngestCredential(request("previous"))).not.toBeNull();
    vi.setSystemTime(new Date("2026-10-30T20:30:00Z"));
    expect(resolveUsageIngestCredential(request("previous"))).toBeNull();
    expect(resolveUsageIngestCredential(request("replacement"))).not.toBeNull();
  });
  it.each(["", "not-a-date", "2026-10-30", "2026-10-30T21:00:01Z", "2026-10-30T19:29:59Z"])(
    "rejects missing, invalid, oversized, or reversed expiry %s", (until) => {
      vi.stubEnv("USAGE_INGEST_PREVIOUS_TOKEN_VALID_UNTIL", until);
      expect(resolveUsageIngestCredential(request("previous"))).toBeNull();
    });
  it("rejects a not-yet-started window and a removed previous token", () => {
    vi.setSystemTime(new Date("2026-10-30T19:29:59Z"));
    expect(resolveUsageIngestCredential(request("previous"))).toBeNull();
    vi.setSystemTime(new Date("2026-10-30T20:00:00Z"));
    vi.stubEnv("USAGE_INGEST_PREVIOUS_TOKEN", "");
    expect(resolveUsageIngestCredential(request("previous"))).toBeNull();
  });
  it("preserves required scoping, scoped precedence, and receipt separation", () => {
    expect(isBillingReceiptIngestAuthorized(request("previous"))).toBe(false);
    vi.stubEnv("USAGE_INGEST_PRODUCER_TOKENS", "claude-code:previous");
    expect(resolveUsageIngestCredential(request("previous"))?.allowedSourceApps).toEqual(new Set(["claude-code"]));
    vi.stubEnv("USAGE_INGEST_PRODUCER_TOKENS", "claude-code:scoped");
    vi.stubEnv("USAGE_INGEST_REQUIRE_SCOPED_TOKENS", "true");
    expect(resolveUsageIngestCredential(request("previous"))).toBeNull();
    expect(resolveUsageIngestCredential(request("replacement"))).toBeNull();
    expect(resolveUsageIngestCredential(request("scoped"))).not.toBeNull();
  });
  it("rejects an accidentally aliased billing receipt token", () => {
    vi.stubEnv("USAGE_INGEST_PREVIOUS_TOKEN", "receipt-only");
    expect(resolveUsageIngestCredential(request("receipt-only"))).toBeNull();
    expect(isBillingReceiptIngestAuthorized(request("receipt-only"))).toBe(true);
  });
});
