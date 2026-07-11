import { describe, expect, it } from "vitest";
import {
  buildProviderCredentialUpdate,
  credentialPathKey,
} from "../provider-credential-update";

describe("provider credential form payload", () => {
  it("keeps create payloads compatible with the create route", () => {
    expect(
      buildProviderCredentialUpdate({
        editing: false,
        apiKeyAction: "replace",
        apiKey: " new-key ",
        secretPaths: [],
        secretActions: {},
        secretValues: {},
      })
    ).toEqual({ apiKey: "new-key" });
  });

  it("emits explicit write-only preserve, replace, and clear operations", () => {
    const admin = ["adminApiKey"];
    const authorization = ["extraHeaders", "Authorization"];
    expect(
      buildProviderCredentialUpdate({
        editing: true,
        apiKeyAction: "clear",
        apiKey: "",
        secretPaths: [admin, authorization],
        secretActions: {
          [credentialPathKey(admin)]: "replace",
          [credentialPathKey(authorization)]: "clear",
        },
        secretValues: { [credentialPathKey(admin)]: " next-admin " },
      })
    ).toEqual({
      apiKeyAction: "clear",
      apiKey: undefined,
      secretConfigOperations: [
        { path: admin, action: "replace", value: "next-admin" },
        { path: authorization, action: "clear" },
      ],
    });
  });

  it("requires replacement values without ever accepting current secret values", () => {
    expect(() =>
      buildProviderCredentialUpdate({
        editing: true,
        apiKeyAction: "replace",
        apiKey: "",
        secretPaths: [],
        secretActions: {},
        secretValues: {},
      })
    ).toThrow(/replacement API key/);

    const path = ["secretKey"];
    expect(() =>
      buildProviderCredentialUpdate({
        editing: true,
        apiKeyAction: "preserve",
        apiKey: "",
        secretPaths: [path],
        secretActions: { [credentialPathKey(path)]: "replace" },
        secretValues: {},
      })
    ).toThrow(/replacement value for secretKey/);
  });
});
