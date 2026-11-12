import { describe, expect, it } from "vitest";
import { parseSubscriptionCreateInput, parseSubscriptionUpdateInput } from "../subscription-input";

const baseBody = {
  providerId: "provider-1",
  name: "Test plan",
  costUsd: 20,
};

describe("parseSubscriptionCreateInput — status", () => {
  it("defaults to active when status is omitted", () => {
    const input = parseSubscriptionCreateInput(baseBody);
    expect(input.status).toBe("active");
  });

  it("accepts every valid status, including the new 'considering'", () => {
    for (const status of ["active", "paused", "canceled", "considering"]) {
      const input = parseSubscriptionCreateInput({ ...baseBody, status });
      expect(input.status).toBe(status);
    }
  });

  it("rejects an invalid status with a message listing 'considering'", () => {
    expect(() => parseSubscriptionCreateInput({ ...baseBody, status: "bogus" })).toThrowError(
      /active, paused, canceled, or considering/
    );
  });
});

describe("subscription currency normalization", () => {
  it("defaults to USD and accepts case-insensitive USD", () => {
    expect(parseSubscriptionCreateInput(baseBody).currency).toBe("USD");
    expect(parseSubscriptionCreateInput({ ...baseBody, currency: "usd" }).currency).toBe("USD");
  });

  it("rejects non-USD create and update values because costUsd is not FX-converted", () => {
    expect(() => parseSubscriptionCreateInput({ ...baseBody, currency: "EUR" })).toThrowError(
      /currency must be USD/
    );
    expect(() => parseSubscriptionUpdateInput({ currency: "GBP" })).toThrowError(
      /currency must be USD/
    );
  });
});

describe("parseSubscriptionCreateInput — knobEnv", () => {
  it("defaults to null when knobEnv is omitted", () => {
    const input = parseSubscriptionCreateInput(baseBody);
    expect(input.knobEnv).toBeNull();
  });

  it("accepts an empty object as an explicit 'no extra knobs' override", () => {
    const input = parseSubscriptionCreateInput({ ...baseBody, knobEnv: {} });
    expect(input.knobEnv).toEqual({});
  });

  it("accepts a flat string->string map", () => {
    const input = parseSubscriptionCreateInput({
      ...baseBody,
      knobEnv: { PROVIDER_QUOTA_TIINGO_PER_HOUR: "10000", TIINGO_DROP_NEWS: "false" },
    });
    expect(input.knobEnv).toEqual({ PROVIDER_QUOTA_TIINGO_PER_HOUR: "10000", TIINGO_DROP_NEWS: "false" });
  });

  it("rejects a non-string value", () => {
    expect(() =>
      parseSubscriptionCreateInput({ ...baseBody, knobEnv: { SOME_KNOB: 100 } })
    ).toThrowError(/knobEnv\.SOME_KNOB must be a string value/);
  });

  it("rejects an array", () => {
    expect(() => parseSubscriptionCreateInput({ ...baseBody, knobEnv: ["not", "an", "object"] })).toThrowError(
      /knobEnv must be a JSON object/
    );
  });

  it("rejects prototype-pollution and non-env-safe knob names (CodeQL #1)", () => {
    // Object-literal `__proto__` does not create an enumerable own key; use JSON.
    expect(() =>
      parseSubscriptionCreateInput({
        ...baseBody,
        knobEnv: JSON.parse('{"__proto__":"x"}') as Record<string, string>,
      })
    ).toThrowError(/safe env-var name/);
    expect(() =>
      parseSubscriptionCreateInput({ ...baseBody, knobEnv: { "evil-key": "x" } })
    ).toThrowError(/safe env-var name/);
  });

  it("rejects a non-object primitive", () => {
    expect(() => parseSubscriptionCreateInput({ ...baseBody, knobEnv: "nope" })).toThrowError(
      /knobEnv must be a JSON object/
    );
  });
});

describe("autoRenew — strict boolean validation", () => {
  it("defaults autoRenew to true when omitted on create", () => {
    expect(parseSubscriptionCreateInput(baseBody).autoRenew).toBe(true);
  });

  it("accepts explicit true/false booleans on create", () => {
    expect(parseSubscriptionCreateInput({ ...baseBody, autoRenew: true }).autoRenew).toBe(true);
    expect(parseSubscriptionCreateInput({ ...baseBody, autoRenew: false }).autoRenew).toBe(false);
  });

  it("rejects the truthy string 'false' instead of silently coercing it to true", () => {
    expect(() => parseSubscriptionCreateInput({ ...baseBody, autoRenew: "false" })).toThrowError(
      /autoRenew must be a boolean/
    );
  });

  it("rejects other truthy non-boolean values on create (number, object, array)", () => {
    expect(() => parseSubscriptionCreateInput({ ...baseBody, autoRenew: 1 })).toThrowError(
      /autoRenew must be a boolean/
    );
    expect(() => parseSubscriptionCreateInput({ ...baseBody, autoRenew: {} })).toThrowError(
      /autoRenew must be a boolean/
    );
    expect(() => parseSubscriptionCreateInput({ ...baseBody, autoRenew: [] })).toThrowError(
      /autoRenew must be a boolean/
    );
  });

  it("only sets autoRenew on update when present, and requires a real boolean", () => {
    expect(parseSubscriptionUpdateInput({}).autoRenew).toBeUndefined();
    expect(parseSubscriptionUpdateInput({ autoRenew: true }).autoRenew).toBe(true);
    expect(parseSubscriptionUpdateInput({ autoRenew: false }).autoRenew).toBe(false);
    expect(() => parseSubscriptionUpdateInput({ autoRenew: "false" })).toThrowError(
      /autoRenew must be a boolean/
    );
    expect(() => parseSubscriptionUpdateInput({ autoRenew: 0 })).toThrowError(
      /autoRenew must be a boolean/
    );
  });
});

describe("parseSubscriptionUpdateInput — status and knobEnv", () => {
  it("only sets status when present, and accepts 'considering'", () => {
    expect(parseSubscriptionUpdateInput({}).status).toBeUndefined();
    expect(parseSubscriptionUpdateInput({ status: "considering" }).status).toBe("considering");
  });

  it("validates explicit activation behavior", () => {
    expect(parseSubscriptionUpdateInput({ activationMode: "resume" }).activationMode).toBe("resume");
    expect(parseSubscriptionUpdateInput({ activationMode: "repurchase" }).activationMode).toBe("repurchase");
    expect(() => parseSubscriptionUpdateInput({ activationMode: "guess" })).toThrowError(
      /activationMode must be repurchase or resume/
    );
  });

  it("requires both halves of an external billing identity link", () => {
    const linked = parseSubscriptionUpdateInput({
      externalBillingSource: "stripe-subscriptions",
      externalBillingId: "sub_123",
    });
    expect(linked).toMatchObject({
      externalBillingSource: "stripe-subscriptions",
      externalBillingId: "sub_123",
    });
    expect(() =>
      parseSubscriptionUpdateInput({ externalBillingSource: "stripe-subscriptions" })
    ).toThrowError(/must both be set/);
  });

  it("only sets knobEnv when the field is present in the body", () => {
    expect(parseSubscriptionUpdateInput({}).knobEnv).toBeUndefined();
    expect(parseSubscriptionUpdateInput({ knobEnv: null }).knobEnv).toBeNull();
    expect(parseSubscriptionUpdateInput({ knobEnv: { A: "1" } }).knobEnv).toEqual({ A: "1" });
  });

  it("accepts a provider change and rejects an empty provider id", () => {
    expect(parseSubscriptionUpdateInput({ providerId: "provider-2" }).providerId).toBe("provider-2");
    expect(() => parseSubscriptionUpdateInput({ providerId: "" })).toThrowError(/providerId is required/);
  });
});
