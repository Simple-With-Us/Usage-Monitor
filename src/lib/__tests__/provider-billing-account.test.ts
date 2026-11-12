import { beforeEach, describe, expect, it } from "vitest";

import {
  authoritativeProviderBillingCredential,
  hashProviderBillingAccountId,
  projectProviderBillingAccountMatches,
} from "@/lib/provider-billing-account";

describe("provider billing account identity", () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = "11".repeat(32);
  });

  it("matches equal credentials without exposing a credential-derived digest", () => {
    const projected = projectProviderBillingAccountMatches([
      {
        id: "a",
        name: "openai",
        billingAccountIdentity: null,
        decryptedCredential: "sk-admin-shared",
      },
      {
        id: "b",
        name: "openai",
        billingAccountIdentity: null,
        decryptedCredential: "sk-admin-shared",
      },
    ]);

    expect(projected.get("a")).toEqual(projected.get("b"));
    expect(projected.get("a")).toEqual({
      matchKey: expect.stringMatching(
        /^billing-account-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      ),
      evidence: "shared_credential",
    });
    expect(JSON.stringify([...projected.values()])).not.toContain("sk-admin");
    expect(JSON.stringify([...projected.values()])).not.toMatch(/[0-9a-f]{64}/);
  });

  it("does not match different credentials", () => {
    const projected = projectProviderBillingAccountMatches([
      {
        id: "a",
        name: "openai",
        billingAccountIdentity: null,
        decryptedCredential: "sk-admin-a",
      },
      {
        id: "b",
        name: "openai",
        billingAccountIdentity: null,
        decryptedCredential: "sk-admin-b",
      },
    ]);
    expect(projected.get("a")?.matchKey).not.toBe(
      projected.get("b")?.matchKey
    );
  });

  it("matches independently keyed credentials only through the same explicit account identity", () => {
    const explicit = hashProviderBillingAccountId("openai", "org_exact_123");
    const projected = projectProviderBillingAccountMatches([
      {
        id: "a",
        name: "openai",
        billingAccountIdentity: explicit,
        decryptedCredential: "sk-admin-a",
      },
      {
        id: "b",
        name: "openai",
        billingAccountIdentity: explicit,
        decryptedCredential: "sk-admin-b",
      },
    ]);
    expect(projected.get("a")).toEqual(projected.get("b"));
    expect(projected.get("a")?.evidence).toBe("explicit_account");
    expect(explicit).not.toContain("org_exact_123");
  });

  it("does not expose a stable account pseudonym across projections", () => {
    const row = {
      id: "a",
      name: "openai",
      billingAccountIdentity: null,
      decryptedCredential: "sk-admin-shared",
    };
    const first = projectProviderBillingAccountMatches([row]).get("a");
    const second = projectProviderBillingAccountMatches([row]).get("a");
    expect(first?.matchKey).not.toBe(second?.matchKey);
  });

  it("fails unresolved for a malformed configured identity instead of falling back", () => {
    const projected = projectProviderBillingAccountMatches([
      {
        id: "a",
        name: "openai",
        billingAccountIdentity: "not-a-valid-keyed-identity",
        decryptedCredential: "sk-admin-shared",
      },
    ]);
    expect(projected.get("a")).toBeNull();
  });

  it("does not reuse an identity across provider families", () => {
    expect(hashProviderBillingAccountId("openai", "account-1")).not.toBe(
      hashProviderBillingAccountId("github", "account-1")
    );
  });

  it("uses the OpenAI Admin key that actually authorizes Costs over an operational key", () => {
    expect(
      authoritativeProviderBillingCredential({
        providerName: "openai",
        primaryCredential: "sk-project-app",
        serverConfig: { adminApiKey: "sk-admin-organization" },
      })
    ).toBe("sk-admin-organization");
    expect(
      authoritativeProviderBillingCredential({
        providerName: "github",
        primaryCredential: "github-token",
        serverConfig: { adminApiKey: "unrelated" },
      })
    ).toBe("github-token");
  });

  it("fails unresolved when OpenAI secret configuration is unreadable", () => {
    expect(
      authoritativeProviderBillingCredential({
        providerName: "openai",
        primaryCredential: "sk-project-app",
        serverConfig: null,
      })
    ).toBeNull();
  });
});
