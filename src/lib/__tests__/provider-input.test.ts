import { describe, expect, it } from "vitest";
import {
  parseProviderCreateInput,
  parseProviderUpdateInput,
} from "@/lib/provider-input";

describe("provider secret config operations", () => {
  it("accepts an explicit service-account clear on provider updates", () => {
    expect(
      parseProviderUpdateInput({
        config: { unrelated: "preserved" },
        secretConfigOperations: [
          { path: ["serviceAccountJson"], action: "clear" },
        ],
      })
    ).toMatchObject({
      config: { unrelated: "preserved" },
      secretConfigOperations: [
        { path: ["serviceAccountJson"], action: "clear" },
      ],
    });
  });

  it("rejects attempts to clear prototype pollution paths", () => {
    expect(() =>
      parseProviderUpdateInput({
        secretConfigOperations: [
          { path: ["__proto__"], action: "clear" },
        ],
      })
    ).toThrow(/unsafe or invalid path segment/);
  });

  it("rejects ambiguous combinations and create-route operations", () => {
    expect(() =>
      parseProviderUpdateInput({
        config: null,
        secretConfigOperations: [
          { path: ["serviceAccountJson"], action: "clear" },
        ],
      })
    ).toThrow(/cannot be combined with config: null/);

    expect(() =>
      parseProviderCreateInput({
        name: "google-ai",
        displayName: "Google AI",
        type: "builtin",
        secretConfigOperations: [
          { path: ["serviceAccountJson"], action: "clear" },
        ],
      })
    ).toThrow(/only supported when updating/);
  });
});

describe("provider billing account identity input", () => {
  it("accepts a trimmed optional identifier on create and explicit clear on update", () => {
    expect(
      parseProviderCreateInput({
        name: "openai",
        displayName: "OpenAI",
        billingAccountId: "  org_exact_123  ",
      }).billingAccountId
    ).toBe("org_exact_123");
    expect(
      parseProviderUpdateInput({ billingAccountId: null }).billingAccountId
    ).toBeNull();
    expect(
      parseProviderUpdateInput({ billingAccountId: "   " }).billingAccountId
    ).toBeNull();
  });

  it("rejects oversized or control-bearing identifiers without echoing them", () => {
    expect(() =>
      parseProviderCreateInput({
        name: "openai",
        displayName: "OpenAI",
        billingAccountId: "x".repeat(257),
      })
    ).toThrow("billingAccountId must be at most 256 characters");
    expect(() =>
      parseProviderUpdateInput({ billingAccountId: "org\u0000secret" })
    ).toThrow("billingAccountId cannot contain control characters");
  });
});

describe("self-burning probe refresh floors (E20)", () => {
  it("rejects sub-hour refresh for Twelve Data and Unusual Whales", () => {
    expect(() =>
      parseProviderCreateInput({
        name: "twelvedata",
        displayName: "Twelve Data",
        refreshIntervalMin: 5,
      })
    ).toThrow(/at least 60 minutes/);
    expect(() =>
      parseProviderUpdateInput({ refreshIntervalMin: 15 }, "unusualwhales")
    ).toThrow(/at least 60 minutes/);
    // Catalog name is hyphenated; floor keys must still match after normalize.
    expect(() =>
      parseProviderCreateInput({
        name: "unusual-whales",
        displayName: "Unusual Whales",
        refreshIntervalMin: 5,
      })
    ).toThrow(/at least 60 minutes/);
    expect(() =>
      parseProviderUpdateInput({ refreshIntervalMin: 15 }, "unusual-whales")
    ).toThrow(/at least 60 minutes/);
  });

  it("allows hourly-or-slower refresh for self-burning probes", () => {
    expect(
      parseProviderCreateInput({
        name: "twelvedata",
        displayName: "Twelve Data",
        refreshIntervalMin: 60,
      }).refreshIntervalMin
    ).toBe(60);
    expect(
      parseProviderCreateInput({
        name: "unusual-whales",
        displayName: "Unusual Whales",
        refreshIntervalMin: 1440,
      }).refreshIntervalMin
    ).toBe(1440);
  });
});
