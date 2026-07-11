import { describe, expect, it } from "vitest";
import { resolveStatusProviderId } from "../external-usage-events";

describe("status snapshot provider routing", () => {
  const duplicates = [
    { id: "openai-a", name: "openai", config: { statusKeyRef: "account-a" } },
    { id: "openai-b", name: "OpenAI", config: { statusKeyRef: "account-b" } },
  ];

  it("routes an unambiguous provider name without an account reference", () => {
    expect(
      resolveStatusProviderId(
        { provider: "anthropic", keyRef: undefined },
        [{ id: "anthropic", name: "Anthropic", config: null }]
      )
    ).toBe("anthropic");
  });

  it("does not attach status to an arbitrary duplicate provider", () => {
    expect(
      resolveStatusProviderId({ provider: "openai", keyRef: undefined }, duplicates)
    ).toBeNull();
    expect(
      resolveStatusProviderId({ provider: "openai", keyRef: "unknown" }, duplicates)
    ).toBeNull();
  });

  it("uses a unique configured status key reference for duplicate names", () => {
    expect(
      resolveStatusProviderId({ provider: "openai", keyRef: "account-b" }, duplicates)
    ).toBe("openai-b");
  });

  it("fails closed when duplicate rows reuse the same status reference", () => {
    expect(
      resolveStatusProviderId(
        { provider: "openai", keyRef: "shared" },
        duplicates.map((provider) => ({
          ...provider,
          config: { statusKeyRef: "shared" },
        }))
      )
    ).toBeNull();
  });
});
