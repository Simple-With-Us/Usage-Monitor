import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptJson, encryptJson } from "@/lib/crypto";
import {
  mergeProviderConfig,
  providerConfigForClient,
  providerConfigForServerOrNull,
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
        apiKey: "sk-should-be-secret",
        apiSecret: "alpaca-secret",
        apiToken: "future-secret",
        apiKeySid: "SK123",
        serviceAccountJson: "{\"private_key\":\"hidden\"}",
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
        apiKey: "sk-should-be-secret",
        apiSecret: "alpaca-secret",
        apiToken: "future-secret",
        apiKeySid: "SK123",
        serviceAccountJson: "{\"private_key\":\"hidden\"}",
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

  it("never exposes Infisical ownership field names or values", () => {
    const result = providerConfigForClient(
      { projectId: "safe-project" },
      encryptJson({
        infisicalCredential: {
          scope: "st-primary",
          sequence: 99,
          fingerprint: "a".repeat(64),
          secretName: "GEMINI_API_KEY",
        },
        serviceAccountJson: "still-redacted",
      })
    );

    expect(result.config).toEqual({ projectId: "safe-project" });
    expect(result.secretConfigMeta.fields).toEqual(["serviceAccountJson"]);
    expect(JSON.stringify(result)).not.toContain("GEMINI_API_KEY");
    expect(JSON.stringify(result)).not.toContain("fingerprint");
  });

  it("never returns a Google service-account document to the browser", () => {
    const credential = JSON.stringify({
      type: "service_account",
      client_email: "usage@example.iam.gserviceaccount.com",
      private_key: "must-not-leak",
    });
    const result = providerConfigForClient(
      { billingDataset: "billing-project.billing_export" },
      encryptJson({ serviceAccountJson: credential })
    );

    expect(result.config).toEqual({
      billingDataset: "billing-project.billing_export",
    });
    expect(result.secretConfigMeta.fields).toContain("serviceAccountJson");
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
    expect(JSON.stringify(result)).not.toContain("usage@example");
  });

  it("redacts legacy browser-sync session and storage payloads as opaque secrets", () => {
    const result = providerConfigForClient(
      {
        accountId: "safe-account",
        sessionCookie: "session=must-not-leak",
        localStorage: {
          harmlessLookingName: "secret-value",
          access_token: "nested-token",
        },
        nested: {
          sessionStorage: { workspace: "private-session-state" },
        },
      },
      null
    );

    expect(result.config).toEqual({ accountId: "safe-account" });
    expect(result.secretConfigMeta).toMatchObject({
      configured: true,
      fields: ["localStorage", "nested.sessionStorage", "sessionCookie"],
    });
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
    expect(JSON.stringify(result)).not.toContain("harmlessLookingName");
    expect(JSON.stringify(result)).not.toContain("private-session-state");
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

  it("providerConfigForServerOrNull returns merged config and fails closed to null", () => {
    expect(
      providerConfigForServerOrNull(
        { host: "https://example.com", apiKey: "legacy-secret" },
        encryptJson({ apiSecret: "encrypted-secret" })
      )
    ).toEqual({
      host: "https://example.com",
      apiKey: "legacy-secret",
      apiSecret: "encrypted-secret",
    });

    // Corrupt/un-decryptable secretConfig must not throw on read paths.
    expect(
      providerConfigForServerOrNull({ host: "https://example.com" }, "not-an-envelope")
    ).toBeNull();
  });
});
