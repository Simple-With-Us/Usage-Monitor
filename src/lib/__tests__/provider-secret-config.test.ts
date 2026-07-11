import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptJson, encryptJson } from "@/lib/crypto";
import {
  mergeProviderConfig,
  providerConfigForClient,
  splitProviderConfig,
} from "@/lib/provider-secret-config";

describe("provider secret config", () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = "11".repeat(32);
  });

  afterEach(() => {
    delete process.env.ENCRYPTION_KEY;
  });

  it("splits current and credential-shaped fields recursively", () => {
    expect(
      splitProviderConfig({
        accountId: "acct",
        publicKey: "pk",
        apiSecret: "alpaca-secret",
        apiToken: "future-secret",
        apiKeySid: "SK123",
        authUsername: "restricted-user",
        nested: { region: "us", password: "pw" },
        extraHeaders: { Authorization: "Bearer hidden" },
      })
    ).toEqual({
      publicConfig: {
        accountId: "acct",
        publicKey: "pk",
        nested: { region: "us" },
      },
      secretConfig: {
        apiSecret: "alpaca-secret",
        apiToken: "future-secret",
        apiKeySid: "SK123",
        authUsername: "restricted-user",
        nested: { password: "pw" },
        extraHeaders: { Authorization: "Bearer hidden" },
      },
    });
  });

  it("round-trips a versioned encrypted JSON envelope", () => {
    const encrypted = encryptJson({ secretKey: "hidden", nested: { token: "t" } });
    expect(encrypted).toMatch(/^v1:/);
    expect(encrypted).not.toContain("hidden");
    expect(decryptJson(encrypted)).toEqual({
      secretKey: "hidden",
      nested: { token: "t" },
    });
  });

  it("returns only public config and configured field names to clients", () => {
    const result = providerConfigForClient(
      { host: "https://example.com", secretKey: "legacy" },
      encryptJson({ apiSecret: "encrypted" })
    );

    expect(result).toEqual({
      config: { host: "https://example.com" },
      secretConfigMeta: {
        configured: true,
        fields: ["apiSecret", "secretKey"],
        readable: true,
      },
    });
    expect(JSON.stringify(result)).not.toContain("legacy");
    expect(JSON.stringify(result)).not.toContain("encrypted");
  });

  it("deep-merges public and encrypted values only for server execution", () => {
    expect(
      mergeProviderConfig(
        { nested: { region: "us" }, host: "https://example.com" },
        { nested: { token: "secret" } }
      )
    ).toEqual({
      nested: { region: "us", token: "secret" },
      host: "https://example.com",
    });
  });
});
