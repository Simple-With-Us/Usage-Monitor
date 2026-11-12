import { describe, expect, it } from "vitest";

import { projectQuotaWindows } from "../quota-windows";
import {
  DEFAULT_PROVIDER_MANIFEST,
  parseProviderManifest,
  resolveProviderManifest,
} from "../provider-manifest";

function resolveFrom(raw: unknown) {
  const parsed = parseProviderManifest(raw) ?? DEFAULT_PROVIDER_MANIFEST;
  return resolveProviderManifest(parsed);
}

describe("provider-manifest integration into projectQuotaWindows", () => {
  it("decorates providerGroups with sortOrder, iconHint, and terms from the manifest", () => {
    const manifest = resolveFrom({
      providers: [
        {
          key: "anthropic",
          sortOrder: 5,
          iconHint: "anthropic-v2",
          terms: { defaultWindowLabel: "5h" },
        },
      ],
    });
    const result = projectQuotaWindows([], new Date(), manifest);
    const anthropic = result.providerGroups.find((g) => g.provider === "anthropic");
    expect(anthropic?.sortOrder).toBe(5);
    expect(anthropic?.iconHint).toBe("anthropic-v2");
    expect(anthropic?.terms?.defaultWindowLabel).toBe("5h");
    expect(anthropic?.providerLabel).toBe("Claude");
  });

  it("normalizes alias keys on windows[].providerKey AND providerGroups via the manifest", () => {
    // A vendor changed their key from "claude-code" to "claude-suite" -- the
    // collector still emits "claude-code" and "claude-suite", and the admin
    // has added an alias mapping both onto the canonical "anthropic" key.
    const manifest = resolveFrom({
      providers: [
        {
          key: "anthropic",
          aliases: ["claude-code", "claude-suite"],
        },
      ],
    });
    const result = projectQuotaWindows(
      [
        {
          provider: "claude-suite",
          credits: 50,
          limit: 100,
          occurredAt: "2026-09-12T12:00:00.000Z",
          metadata: { bucketId: "claude-suite:5h" },
        },
        {
          provider: "claude-code",
          credits: 30,
          limit: 100,
          occurredAt: "2026-09-12T12:00:01.000Z",
          metadata: { bucketId: "claude-code:5h" },
        },
      ],
      new Date(),
      manifest,
    );
    // Every window collapses onto the canonical key, and windows[].providerKey
    // reflects the canonicalization (not the raw event value).
    expect(result.windows.every((w) => w.providerKey === "anthropic")).toBe(true);
    const anthropicGroup = result.providerGroups.find((g) => g.provider === "anthropic");
    expect(anthropicGroup?.windows).toHaveLength(2);
  });

  it("surfaces a brand-new provider from the manifest even before any window arrives", () => {
    const manifest = resolveFrom({
      providers: [
        {
          key: "muse",
          label: "Muse",
          sortOrder: 100,
          iconHint: "muse",
          expected: true,
          terms: { defaultWindowLabel: "monthly" },
        },
      ],
    });
    const result = projectQuotaWindows([], new Date(), manifest);
    const muse = result.providerGroups.find((g) => g.provider === "muse");
    expect(muse).toBeDefined();
    expect(muse?.providerLabel).toBe("Muse");
    expect(muse?.expected).toBe(true);
    expect(muse?.sortOrder).toBe(100);
    expect(muse?.iconHint).toBe("muse");
    expect(muse?.terms?.defaultWindowLabel).toBe("monthly");
    expect(muse?.windows).toEqual([]);
  });

  it("manifest label override wins over compiled defaults", () => {
    const manifest = resolveFrom({
      providers: [{ key: "anthropic", label: "Claude (Anthropic)" }],
    });
    const result = projectQuotaWindows(
      [
        {
          provider: "anthropic",
          credits: 50,
          limit: 100,
          occurredAt: "2026-09-12T12:00:00.000Z",
          metadata: { bucketId: "anthropic:5h" },
        },
      ],
      new Date(),
      manifest,
    );
    const anthropic = result.providerGroups.find((g) => g.provider === "anthropic");
    expect(anthropic?.providerLabel).toBe("Claude (Anthropic)");
    expect(result.windows[0]?.providerLabel).toBe("Claude (Anthropic)");
  });

  it("falls back to compiled defaults when no manifest is passed", () => {
    const result = projectQuotaWindows([]);
    const keys = result.providerGroups.map((g) => g.provider);
    expect(keys).toContain("anthropic");
    expect(keys).toContain("openai");
    expect(keys).toContain("google-antigravity");
    // Defaults populate sortOrder and iconHint.
    const anthropic = result.providerGroups.find((g) => g.provider === "anthropic");
    expect(anthropic?.sortOrder).toBe(10);
    expect(anthropic?.iconHint).toBe("anthropic");
  });

  it("preserves the additivity contract: existing keys/fields are untouched", () => {
    const result = projectQuotaWindows(
      [
        {
          provider: "google-antigravity",
          credits: 42,
          limit: 100,
          occurredAt: "2026-09-12T12:00:00.000Z",
          metadata: { bucketId: "claude-gpt", quotaWindow: "5h" },
        },
      ],
      new Date(),
    );
    // Top-level keys that iOS and BotFleet read are intact.
    expect(result).toHaveProperty("generatedAt");
    expect(result).toHaveProperty("windows");
    expect(result).toHaveProperty("skipModelTypes");
    expect(result).toHaveProperty("providerGroups");
    // Existing window fields unchanged.
    expect(result.windows[0]).toHaveProperty("providerKey");
    expect(result.windows[0]).toHaveProperty("providerLabel");
    expect(result.windows[0]).toHaveProperty("via");
    expect(result.windows[0]).toHaveProperty("status");
    expect(result.windows[0]).toHaveProperty("skip");
    // Existing group fields unchanged.
    const ag = result.providerGroups.find((g) => g.provider === "google-antigravity");
    expect(ag).toHaveProperty("expected");
    expect(ag).toHaveProperty("windows");
    expect(ag?.providerLabel).toBe("Antigravity");
    expect(ag?.via).toBe("antigravity");
  });
});