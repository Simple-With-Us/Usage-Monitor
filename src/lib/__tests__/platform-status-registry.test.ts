import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PLATFORM_PROBES,
  fetchPlatformStatus,
  resetPlatformStatusCacheForTests,
} from "@/lib/platform-status/registry";
import {
  MAX_PLATFORM_METRICS,
  MAX_PLATFORM_STRING_LENGTH,
  boundMetrics,
  boundString,
} from "@/lib/platform-status/types";

// The registry must never reach the network during these tests: every probe is
// expected to short-circuit on `isConfigured()` with no credentials present.
vi.mock("@/lib/adapters/helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/adapters/helpers")>();
  return {
    ...actual,
    fetchJson: vi.fn(async () => {
      throw new Error("network access is not allowed in registry tests");
    }),
  };
});

describe("platform-status registry", () => {
  beforeEach(() => {
    resetPlatformStatusCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetPlatformStatusCacheForTests();
  });

  it("registers a unique, stable, kebab-case id for every probe", () => {
    const ids = PLATFORM_PROBES.map((probe) => probe.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it("gives every probe a display name, category and credential setup metadata", () => {
    for (const probe of PLATFORM_PROBES) {
      expect(probe.name.length).toBeGreaterThan(0);
      expect(probe.category.length).toBeGreaterThan(0);
      // Infisical also supports encrypted dashboard connections without env credentials.
      if (probe.id === "infisical") expect(probe.requiredEnv).toEqual([]);
      else expect(probe.requiredEnv.length).toBeGreaterThan(0);
      for (const name of probe.requiredEnv) {
        // Env var names only — a value would be a credential leak.
        expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/);
      }
    }
  });

  it("keeps isConfigured() pure and non-throwing with a bare environment", () => {
    for (const probe of PLATFORM_PROBES) {
      expect(() => probe.isConfigured()).not.toThrow();
    }
  });

  it("reports every platform as unconfigured when no credentials are set", async () => {
    for (const probe of PLATFORM_PROBES) {
      for (const name of probe.requiredEnv) vi.stubEnv(name, "");
    }
    // Aliases the probes accept beyond their advertised requiredEnv.
    for (const name of [
      "HETZNER_API_TOKEN",
      "HETZNER_API_KEY",
      "COOLIFY_API_TOKEN",
      "RENDER_API_TOKEN",
      "VERCEL_TOKEN",
      "R2_USAGE_ACCOUNT_ID",
      "R2_USAGE_API_TOKEN",
      "CLOUDFLARE_JAY_ACCOUNT_ID",
      "CLOUDFLARE_JAY_API_TOKEN",
    ]) {
      vi.stubEnv(name, "");
    }

    const payload = await fetchPlatformStatus();

    expect(payload.platforms).toHaveLength(PLATFORM_PROBES.length);
    expect(payload.summary.total).toBe(PLATFORM_PROBES.length);
    expect(payload.summary.unconfigured).toBe(PLATFORM_PROBES.length);
    expect(payload.summary.configured).toBe(0);
    expect(payload.degraded).toBe(false);
    for (const card of payload.platforms) {
      expect(card.configured).toBe(false);
      expect(card.state).toBe("unconfigured");
      expect(card.metrics).toEqual([]);
      expect(card.headline).toBeNull();
    }
  });

  it("contains a card for a failing probe instead of rejecting the sweep", async () => {
    const exploding = PLATFORM_PROBES[0];
    const spyConfigured = vi.spyOn(exploding, "isConfigured").mockReturnValue(true);
    const spyProbe = vi.spyOn(exploding, "probe").mockRejectedValue(new Error("boom"));

    const payload = await fetchPlatformStatus();
    const card = payload.platforms.find((entry) => entry.id === exploding.id);

    expect(card?.state).toBe("unreachable");
    expect(card?.error).toBe("probe_failed");
    // Every other platform still rendered.
    expect(payload.platforms).toHaveLength(PLATFORM_PROBES.length);

    spyConfigured.mockRestore();
    spyProbe.mockRestore();
  });

  it("serves a cached payload on the second call within the TTL", async () => {
    const first = await fetchPlatformStatus();
    const second = await fetchPlatformStatus();
    expect(second.fetchedAt).toBe(first.fetchedAt);
    expect(second.stale).toBe(false);
  });

  it("never emits a value that looks like a credential", async () => {
    const payload = await fetchPlatformStatus();
    const serialized = JSON.stringify(payload);
    // Common credential prefixes across the platforms in the registry.
    for (const marker of ["sk_live", "sk_test", "Bearer ", "xoxb-", "hcloud_"]) {
      expect(serialized).not.toContain(marker);
    }
  });
});

describe("platform-status payload bounds", () => {
  it("truncates an over-long string to the documented bound", () => {
    const bounded = boundString("x".repeat(MAX_PLATFORM_STRING_LENGTH + 50));
    expect(bounded).toHaveLength(MAX_PLATFORM_STRING_LENGTH);
    expect(bounded.endsWith("…")).toBe(true);
  });

  it("caps the metric list and bounds each field", () => {
    const metrics = Array.from({ length: MAX_PLATFORM_METRICS + 4 }, (_, index) => ({
      label: `  Label ${index}  `,
      value: "y".repeat(MAX_PLATFORM_STRING_LENGTH + 10),
      hint: "  hint  ",
    }));

    const bounded = boundMetrics(metrics);

    expect(bounded).toHaveLength(MAX_PLATFORM_METRICS);
    expect(bounded[0].label).toBe("Label 0");
    expect(bounded[0].hint).toBe("hint");
    expect(bounded[0].value).toHaveLength(MAX_PLATFORM_STRING_LENGTH);
  });

  it("omits hint entirely when a probe did not supply one", () => {
    const [bounded] = boundMetrics([{ label: "A", value: "B" }]);
    expect("hint" in bounded).toBe(false);
  });

  it("keeps a finite usagePct for the fill bar and drops a non-number", () => {
    const [kept] = boundMetrics([{ label: "R2", value: "1.0 GB / 10 GB Free Tier", usagePct: 41 }]);
    expect(kept.usagePct).toBe(41);
    const [dropped] = boundMetrics([
      { label: "R2", value: "Unavailable", usagePct: Number.NaN },
    ]);
    expect("usagePct" in dropped).toBe(false);
  });
});
