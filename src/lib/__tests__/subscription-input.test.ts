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

  it("rejects a non-object primitive", () => {
    expect(() => parseSubscriptionCreateInput({ ...baseBody, knobEnv: "nope" })).toThrowError(
      /knobEnv must be a JSON object/
    );
  });
});

describe("parseSubscriptionUpdateInput — status and knobEnv", () => {
  it("only sets status when present, and accepts 'considering'", () => {
    expect(parseSubscriptionUpdateInput({}).status).toBeUndefined();
    expect(parseSubscriptionUpdateInput({ status: "considering" }).status).toBe("considering");
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
