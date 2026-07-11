import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encrypt } from "@/lib/crypto";
import { providerApiKeyState } from "@/lib/provider-api-key-state";

describe("providerApiKeyState", () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = "11".repeat(32);
  });

  afterEach(() => {
    delete process.env.ENCRYPTION_KEY;
  });

  it("returns only a last-four preview for readable configured keys", () => {
    expect(providerApiKeyState(encrypt("secret-provider-key-1234"))).toEqual({
      apiKeyConfigured: true,
      apiKeyReadable: true,
      keyPreview: "••••1234",
    });
  });

  it("does not expose a short key as a last-four preview", () => {
    expect(providerApiKeyState(encrypt("abc"))).toEqual({
      apiKeyConfigured: true,
      apiKeyReadable: true,
      keyPreview: null,
    });
  });

  it("distinguishes absent and unreadable keys", () => {
    expect(providerApiKeyState(null)).toEqual({
      apiKeyConfigured: false,
      apiKeyReadable: true,
      keyPreview: null,
    });
    expect(providerApiKeyState("not-an-encrypted-key")).toEqual({
      apiKeyConfigured: true,
      apiKeyReadable: false,
      keyPreview: null,
    });
  });
});
