import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encrypt } from "../crypto";
import { planCredentialGroup } from "../provider-grouping";

describe("provider credential grouping", () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = "44".repeat(32);
  });

  afterEach(() => {
    delete process.env.ENCRYPTION_KEY;
  });

  it("does not group distinct accounts merely because their provider names match", () => {
    expect(
      planCredentialGroup("openai", "new-key", [
        { id: "first", name: "OpenAI", groupId: null, apiKey: encrypt("other-key") },
      ])
    ).toBeNull();
  });

  it("reuses a group only for the same provider credential", () => {
    expect(
      planCredentialGroup("openai", "same-key", [
        { id: "first", name: "OpenAI", groupId: null, apiKey: encrypt("same-key") },
        { id: "other-service", name: "resend", groupId: null, apiKey: encrypt("same-key") },
      ])
    ).toEqual({
      groupId: "credential:first",
      providerIdsToBackfill: ["first"],
    });
  });
});
