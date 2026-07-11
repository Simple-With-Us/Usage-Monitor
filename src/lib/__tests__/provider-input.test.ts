import { describe, expect, it } from "vitest";
import {
  parseProviderCreateInput,
  parseProviderUpdateInput,
} from "../provider-input";

describe("provider allocation input", () => {
  const base = { name: "openai", displayName: "OpenAI" };

  it("rejects duplicate project allocations before the database unique constraint", () => {
    expect(() =>
      parseProviderCreateInput({
        ...base,
        allocations: [
          { projectId: "project-1", percentage: 25 },
          { projectId: "project-1", percentage: 25 },
        ],
      })
    ).toThrowError(/duplicate projectId project-1/);
  });

  it("accepts distinct allocations whose total is at most 100 percent", () => {
    expect(
      parseProviderCreateInput({
        ...base,
        allocations: [
          { projectId: "project-1", percentage: 25 },
          { projectId: "project-2", percentage: 75 },
        ],
      }).allocations
    ).toHaveLength(2);
  });
});

describe("provider credential lifecycle input", () => {
  it("preserves by default and supports explicit replace and clear", () => {
    expect(parseProviderUpdateInput({}).apiKeyOperation).toEqual({
      action: "preserve",
    });
    expect(
      parseProviderUpdateInput({ apiKeyAction: "replace", apiKey: " new-key " })
        .apiKeyOperation
    ).toEqual({ action: "replace", value: "new-key" });
    expect(parseProviderUpdateInput({ apiKeyAction: "clear" }).apiKeyOperation).toEqual({
      action: "clear",
    });
    // Backward-compatible edit payloads with a non-empty apiKey still replace.
    expect(parseProviderUpdateInput({ apiKey: "legacy-new-key" }).apiKeyOperation).toEqual({
      action: "replace",
      value: "legacy-new-key",
    });
  });

  it("rejects ambiguous or invalid primary-key operations", () => {
    expect(() =>
      parseProviderUpdateInput({ apiKeyAction: "replace" })
    ).toThrow(/apiKey is required/);
    expect(() =>
      parseProviderUpdateInput({ apiKeyAction: "clear", apiKey: "unexpected" })
    ).toThrow(/must be omitted/);
    expect(() => parseProviderUpdateInput({ apiKey: 123 })).toThrow(
      /apiKey must be a string/
    );
  });

  it("parses bounded per-field protected-config operations", () => {
    expect(
      parseProviderUpdateInput({
        secretConfigOperations: [
          { path: ["apiSecret"], action: "preserve" },
          { path: ["nested", "password"], action: "replace", value: "next" },
          { path: ["extraHeaders", "Authorization"], action: "clear" },
        ],
      }).secretConfigOperations
    ).toEqual([
      { path: ["apiSecret"], action: "preserve" },
      { path: ["nested", "password"], action: "replace", value: "next" },
      { path: ["extraHeaders", "Authorization"], action: "clear" },
    ]);
  });

  it("rejects unsafe, duplicate, public-only, or ambiguous protected-config operations", () => {
    expect(() =>
      parseProviderUpdateInput({
        secretConfigOperations: [{ path: ["__proto__"], action: "clear" }],
      })
    ).toThrow(/unsafe or invalid key/);
    expect(() =>
      parseProviderUpdateInput({
        secretConfigOperations: [{ path: ["region"], action: "clear" }],
      })
    ).toThrow(/protected config field/);
    expect(() =>
      parseProviderUpdateInput({
        secretConfigOperations: [
          { path: ["password", "nested"], action: "replace", value: "bad" },
        ],
      })
    ).toThrow(/cannot descend below/);
    expect(() =>
      parseProviderUpdateInput({
        secretConfigOperations: [
          { path: ["extraHeaders"], action: "replace", value: "bad" },
        ],
      })
    ).toThrow(/individual extraHeaders entry/);
    expect(() =>
      parseProviderUpdateInput({
        secretConfigOperations: [
          { path: ["apiSecret"], action: "clear" },
          { path: ["apiSecret"], action: "preserve" },
        ],
      })
    ).toThrow(/duplicate path/);
    expect(() =>
      parseProviderUpdateInput({
        config: null,
        secretConfigOperations: [{ path: ["apiSecret"], action: "clear" }],
      })
    ).toThrow(/cannot be combined/);
  });
});

describe("provider config bounds", () => {
  const base = { name: "custom", displayName: "Custom" };

  it("rejects prototype-pollution keys and unsupported arrays", () => {
    const polluted = JSON.parse('{"__proto__":{"polluted":true}}');
    expect(() => parseProviderCreateInput({ ...base, config: polluted })).toThrow(
      /unsafe or invalid key/
    );
    expect(() =>
      parseProviderCreateInput({ ...base, config: { constructor: "bad" } })
    ).toThrow(/unsafe or invalid key/);
    expect(() =>
      parseProviderCreateInput({ ...base, config: { regions: ["us"] } })
    ).toThrow(/arrays are not supported/);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("rejects excessive depth, entry count, and string length", () => {
    let deep: Record<string, unknown> = { leaf: "value" };
    for (let index = 0; index < 7; index += 1) deep = { nested: deep };
    expect(() => parseProviderCreateInput({ ...base, config: deep })).toThrow(
      /maximum depth/
    );
    expect(() =>
      parseProviderCreateInput({
        ...base,
        config: Object.fromEntries(
          Array.from({ length: 201 }, (_, index) => [`key${index}`, index])
        ),
      })
    ).toThrow(/200 entries or fewer/);
    expect(() =>
      parseProviderCreateInput({
        ...base,
        config: { endpoint: "x".repeat(4_097) },
      })
    ).toThrow(/4096 characters or fewer/);
  });
});
