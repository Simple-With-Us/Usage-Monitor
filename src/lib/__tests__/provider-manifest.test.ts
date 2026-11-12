import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { appSettings } from "../app-settings";
import {
  DEFAULT_PROVIDER_MANIFEST,
  PROVIDER_MANIFEST_KEY,
  loadResolvedProviderManifest,
  parseProviderManifest,
  resolveProviderManifest,
} from "../provider-manifest";

beforeEach(() => {
  appSettings._resetForTests();
  delete process.env[PROVIDER_MANIFEST_KEY];
});

afterEach(() => {
  appSettings._resetForTests();
  delete process.env[PROVIDER_MANIFEST_KEY];
});

describe("parseProviderManifest", () => {
  it("rejects non-object payloads", () => {
    expect(parseProviderManifest(null)).toBeNull();
    expect(parseProviderManifest("not an object")).toBeNull();
    expect(parseProviderManifest([])).toBeNull();
  });

  it("rejects payloads without a providers array", () => {
    expect(parseProviderManifest({ version: "1" })).toBeNull();
  });

  it("rejects payloads with zero valid entries", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseProviderManifest({ providers: [{}, { label: "no-key" }] })).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("sanitizes valid entries and drops missing/invalid fields", () => {
    const parsed = parseProviderManifest({
      version: "2",
      providers: [
        {
          key: "  anthropic  ",
          label: "  Claude  ",
          sortOrder: 10,
          iconHint: "anthropic",
          aliases: ["claude", "", 42, " claude-code "],
          expected: true,
          terms: { defaultWindowLabel: "5h", via: "" },
        },
        { key: "  ", label: "missing-key" }, // dropped
        "not-an-object", // dropped
      ],
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.version).toBe("2");
    const entry = parsed!.providers[0];
    expect(entry?.key).toBe("anthropic");
    expect(entry?.label).toBe("Claude");
    expect(entry?.aliases).toEqual(["claude", "claude-code"]);
    // Empty via is normalized to undefined.
    expect(entry?.terms?.via).toBeUndefined();
  });
});

describe("resolveProviderManifest", () => {
  it("returns compiled defaults when given null", () => {
    const resolved = resolveProviderManifest(null);
    expect(resolved.fromInfisical).toBe(false);
    expect(resolved.providers.map((p) => p.key)).toEqual(
      DEFAULT_PROVIDER_MANIFEST.providers.map((p) => p.key),
    );
    expect(resolved.byKey.get("anthropic")?.label).toBe("Claude");
    expect(resolved.byKey.get("google-antigravity")?.terms?.via).toBe("antigravity");
  });

  it("merges manifest overrides on top of defaults", () => {
    const parsed = parseProviderManifest({
      providers: [
        {
          key: "anthropic",
          label: "Claude (Anthropic)",
          sortOrder: 5,
          iconHint: "anthropic-v2",
          aliases: ["claude-suite"],
        },
      ],
    });
    const resolved = resolveProviderManifest(parsed);
    const cfg = resolved.byKey.get("anthropic");
    expect(cfg?.label).toBe("Claude (Anthropic)");
    expect(cfg?.sortOrder).toBe(5);
    expect(cfg?.iconHint).toBe("anthropic-v2");
    expect(cfg?.aliases).toEqual(
      expect.arrayContaining(["claude", "claude-code", "claude-suite"]),
    );
    // Untouched defaults stay intact.
    expect(resolved.byKey.get("openai")?.label).toBe("Codex");
  });

  it("adds a brand-new provider purely from the manifest", () => {
    const parsed = parseProviderManifest({
      providers: [
        {
          key: "muse",
          label: "Muse",
          sortOrder: 100,
          iconHint: "muse",
          aliases: ["muse-cli"],
          expected: true,
          terms: { defaultWindowLabel: "monthly" },
        },
      ],
    });
    const resolved = resolveProviderManifest(parsed);
    const muse = resolved.byKey.get("muse");
    expect(muse).toBeDefined();
    expect(muse?.label).toBe("Muse");
    expect(muse?.sortOrder).toBe(100);
    expect(muse?.aliases).toEqual(["muse-cli"]);
    // The new key is in the alias map so collector events resolve to it.
    expect(resolved.aliasToKey.get("muse-cli")).toBe("muse");
    expect(resolved.aliasToKey.get("muse")).toBe("muse");
  });

  it("sorts providers by sortOrder then label", () => {
    const parsed = parseProviderManifest({
      providers: [
        { key: "zeta", label: "Zeta", sortOrder: 50 },
        { key: "alpha", label: "Alpha", sortOrder: 5 },
        { key: "middle", label: "Middle", sortOrder: 20 },
      ],
    });
    const resolved = resolveProviderManifest(parsed);
    const keys = resolved.providers.map((p) => p.key);
    expect(keys[0]).toBe("alpha");
    // Defaults with sortOrder 10, 20, 30, ... intersperse correctly.
    expect(keys.indexOf("middle")).toBeGreaterThan(keys.indexOf("alpha"));
    expect(keys.indexOf("zeta")).toBeGreaterThan(keys.indexOf("middle"));
  });
});

describe("loadResolvedProviderManifest", () => {
  it("returns compiled defaults when the knob is missing", () => {
    const resolved = loadResolvedProviderManifest();
    expect(resolved.fromInfisical).toBe(false);
    expect(resolved.providers.length).toBe(DEFAULT_PROVIDER_MANIFEST.providers.length);
  });

  it("falls back to defaults on malformed JSON with a loud log", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env[PROVIDER_MANIFEST_KEY] = "{not json";
    const resolved = loadResolvedProviderManifest();
    expect(resolved.fromInfisical).toBe(false);
    expect(error).toHaveBeenCalled();
    expect(error.mock.calls[0]?.[0]).toEqual(
      expect.stringContaining("malformed JSON"),
    );
    error.mockRestore();
  });

  it("falls back to defaults when payload is structurally invalid", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env[PROVIDER_MANIFEST_KEY] = JSON.stringify({ version: "1" });
    const resolved = loadResolvedProviderManifest();
    expect(resolved.fromInfisical).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("uses the manifest knob value when it is well-formed", () => {
    process.env[PROVIDER_MANIFEST_KEY] = JSON.stringify({
      providers: [{ key: "muse", label: "Muse", sortOrder: 100, expected: true }],
    });
    const resolved = loadResolvedProviderManifest();
    expect(resolved.fromInfisical).toBe(true);
    expect(resolved.byKey.get("muse")?.label).toBe("Muse");
    // Defaults remain.
    expect(resolved.byKey.get("anthropic")?.label).toBe("Claude");
  });

  it("empty-string knob is treated as missing (no log noise)", () => {
    process.env[PROVIDER_MANIFEST_KEY] = "   ";
    const resolved = loadResolvedProviderManifest();
    expect(resolved.fromInfisical).toBe(false);
  });
});