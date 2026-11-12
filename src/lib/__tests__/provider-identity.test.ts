import { describe, expect, it } from "vitest";
import {
  canonicalProjectKey,
  canonicalProviderKey,
  resolveProviderIdentity,
} from "../provider-identity";

describe("provider identity", () => {
  it.each([
    ["gemini", "google-ai"],
    ["Google AI", "google-ai"],
    ["google", "google-ai"],
    ["google_ai_studio", "google-ai"],
    ["LlamaParse", "llamaindex"],
    ["Polygon.io", "massive"],
    ["Alpha-Vantage", "alphavantage"],
    ["Twelve Data", "twelvedata"],
    ["Voyage AI", "voyage"],
    ["fintechstudios", "fintech-studios"],
    ["quiver", "quiver-quant"],
    ["QuiverQuant", "quiver-quant"],
    ["Quiver Quantitative", "quiver-quant"],
    ["OpenRouter", "openrouter"],
    ["open-router", "openrouter"],
    ["OpenRouter.ai", "openrouter"],
    ["Render.com", "render"],
    ["render", "render"],
  ])("maps %s to %s", (input, expected) => {
    expect(canonicalProviderKey(input)).toBe(expected);
  });

  it("keeps unknown providers distinct without rewriting persisted input", () => {
    expect(canonicalProviderKey("Unusual Whales")).toBe("unusual-whales");
    expect(canonicalProviderKey("Quiver Quant")).toBe("quiver-quant");
  });

  it("prefers an exact configured name before falling back through aliases", () => {
    const candidates = [
      { id: "builtin", name: "google-ai" },
      { id: "custom", name: "gemini" },
      { id: "legacy", name: "google" },
    ];

    expect(resolveProviderIdentity("gemini", candidates)?.id).toBe("custom");
    expect(resolveProviderIdentity("Google AI Studio", candidates)?.id).toBe("builtin");
    expect(resolveProviderIdentity("gemini", [candidates[2]])?.id).toBe("legacy");
  });

  it("returns consistent results across repeated calls over the same candidates array", () => {
    // E3: per-candidates-array key caching must be observationally equivalent
    // to recomputing keys on every call — repeat resolutions over one shared
    // array, then confirm a distinct array resolves independently.
    const candidates = [
      { id: "a-builtin", name: "google-ai", identityPriority: 1 },
      { id: "b-custom", name: "Gemini", identityPriority: 5 },
      { id: "c-legacy", name: "google" },
      { id: "d-other", name: "voyage" },
    ];

    for (let i = 0; i < 5; i += 1) {
      expect(resolveProviderIdentity("gemini", candidates)?.id).toBe("b-custom");
      expect(resolveProviderIdentity("Google AI Studio", candidates)?.id).toBe(
        "a-builtin"
      );
      expect(resolveProviderIdentity("Voyage AI", candidates)?.id).toBe("d-other");
      expect(resolveProviderIdentity("unknown-provider", candidates)).toBeNull();
    }

    const other = [{ id: "z-only", name: "gemini" }];
    expect(resolveProviderIdentity("gemini", other)?.id).toBe("z-only");
    // ...and the original array's cache is unaffected by the other array.
    expect(resolveProviderIdentity("gemini", candidates)?.id).toBe("b-custom");
  });

  it("honors identityPriority and the id tie-break on the alias fallback", () => {
    const candidates = [
      { id: "b-low", name: "Google AI", identityPriority: 1 },
      { id: "a-high", name: "google-ai", identityPriority: 1 },
      { id: "c-prio", name: "Google", identityPriority: 9 },
    ];

    // Canonical-slug exact names ("google-ai") outrank higher-priority aliases.
    expect(resolveProviderIdentity("Google AI Studio", candidates)?.id).toBe("a-high");
    // Between two identical canonical-slug rows, priority then id decides.
    expect(resolveProviderIdentity("gemini", candidates)?.id).toBe("a-high");
  });

  it.each([
    ["socratic-trade", "SocraticTrade.com"],
    ["congress-trade", "Congress.Trade"],
    ["my-app", "My App"],
  ])("matches legacy source app %s to project %s", (sourceApp, projectName) => {
    expect(canonicalProjectKey(sourceApp)).toBe(canonicalProjectKey(projectName));
  });
});
