import { describe, expect, it } from "vitest";

import {
  ANTIGRAVITY_THIRD_PARTY_LABEL,
  antigravityDisplayLabel,
  projectQuotaWindows,
  quotaProviderKey,
  quotaProviderLabel,
  quotaProviderVia,
  quotaStatus,
} from "../quota-windows";

describe("quotaStatus", () => {
  it("treats remaining 0 and isExhausted as a hit", () => {
    expect(quotaStatus({ remainingPercent: 0, remainingUnknown: false, isExhausted: false })).toBe(
      "exhausted",
    );
    expect(quotaStatus({ remainingPercent: null, remainingUnknown: true, isExhausted: true })).toBe(
      "exhausted",
    );
  });

  it("treats omitted remaining (N/A) as exhausted", () => {
    expect(quotaStatus({ remainingPercent: null, remainingUnknown: true, isExhausted: false })).toBe(
      "exhausted",
    );
  });

  it("keeps 30% remaining available", () => {
    expect(quotaStatus({ remainingPercent: 29.75, remainingUnknown: false, isExhausted: false })).toBe(
      "available",
    );
  });

  it("treats remaining under 20% as near_cap", () => {
    expect(quotaStatus({ remainingPercent: 19.9, remainingUnknown: false, isExhausted: false })).toBe(
      "near_cap",
    );
  });

  it("treats remainingPercent null without remainingUnknown as exhausted", () => {
    expect(quotaStatus({ remainingPercent: null, remainingUnknown: false, isExhausted: false })).toBe(
      "exhausted",
    );
  });
});

describe("projectQuotaWindows", () => {
  it("projects per-model skip targets from antigravity-usage events", () => {
    const result = projectQuotaWindows([
      {
        provider: "google-antigravity",
        label: "Claude Opus 4.6 (Thinking)",
        credits: 0,
        limit: 100,
        occurredAt: "2026-09-04T04:20:02.182Z",
        metadata: {
          modelId: "claude-opus-4-6-thinking",
          isExhausted: true,
          source: "antigravity-usage",
          resetAt: "2026-09-09T07:04:37Z",
        },
      },
      {
        provider: "google-antigravity",
        label: "Gemini 3.1 Pro (High)",
        credits: null,
        limit: 100,
        occurredAt: "2026-09-04T04:20:02.182Z",
        metadata: {
          modelId: "gemini-3.1-pro-high",
          remainingUnknown: true,
          isExhausted: false,
          source: "antigravity-usage",
        },
      },
    ]);
    expect(result.skipModelTypes.map((row) => row.model).sort()).toEqual([
      "claude-opus-4-6-thinking",
      "gemini-3.1-pro-high",
    ]);
    const gemini = result.windows.find((row) => row.modelId === "gemini-3.1-pro-high");
    expect(gemini?.status).toBe("exhausted");
    expect(gemini?.skip).toBe(true);
    expect(gemini?.remainingPercent).toBe(0);
  });

  it("keeps the latest event per series", () => {
    const result = projectQuotaWindows([
      {
        provider: "google-antigravity",
        label: "Claude Opus 4.6 (Thinking)",
        credits: 10,
        limit: 100,
        occurredAt: "2026-09-04T05:00:00.000Z",
        metadata: { modelId: "claude-opus-4-6-thinking", isExhausted: false },
      },
      {
        provider: "google-antigravity",
        label: "Claude Opus 4.6 (Thinking)",
        credits: 0,
        limit: 100,
        occurredAt: "2026-09-04T04:00:00.000Z",
        metadata: { modelId: "claude-opus-4-6-thinking", isExhausted: true },
      },
    ]);
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0]?.remainingPercent).toBe(10);
    expect(result.skipModelTypes).toEqual([]);
  });

  it("keeps the same bucket separate by producer identity and selects each machine's newest reading", () => {
    const event = (
      producerInstanceId: string,
      machine: string,
      credits: number,
      occurredAt: string,
    ) => ({
      provider: "anthropic",
      label: "5h window",
      credits,
      limit: 100,
      occurredAt,
      metadata: {
        bucketId: "anthropic:five_hour",
        _producerInstanceId: producerInstanceId,
        machine,
      },
    });
    const result = projectQuotaWindows([
      event("machine-a", "Laptop", 80, "2026-10-03T12:00:00.000Z"),
      event("machine-b", "Laptop", 30, "2026-10-03T11:00:00.000Z"),
      event("machine-a", "Laptop", 10, "2026-10-03T10:00:00.000Z"),
    ]);

    expect(result.windows).toHaveLength(2);
    expect(
      result.windows.map((window) => [
        window.producerInstanceId,
        window.machine,
        window.remainingPercent,
      ]),
    ).toEqual([
      ["machine-a", "Laptop", 80],
      ["machine-b", "Laptop", 30],
    ]);
    expect(new Set(result.windows.map((window) => window.id)).size).toBe(2);
  });

  it("serializes producer and series components without delimiter collisions", () => {
    const event = (producerInstanceId: string, bucketId: string) => ({
      provider: "anthropic",
      label: "5h window",
      credits: 50,
      limit: 100,
      occurredAt: "2026-10-03T12:00:00.000Z",
      metadata: { bucketId, _producerInstanceId: producerInstanceId },
    });
    const result = projectQuotaWindows([
      event("machine:a", "b:c"),
      event("machine", "a:b:c"),
    ]);

    expect(result.windows).toHaveLength(2);
    expect(result.windows.map((window) => window.id)).toEqual([
      JSON.stringify(["machine:a", "b:c"]),
      JSON.stringify(["machine", "a:b:c"]),
    ]);
  });

  it("retains legacy ids and omits provenance fields when metadata has no producer identity", () => {
    const result = projectQuotaWindows([
      {
        provider: "anthropic",
        label: "5h window",
        credits: 50,
        limit: 100,
        occurredAt: "2026-10-03T12:00:00.000Z",
        metadata: { bucketId: "anthropic:five_hour", machine: "Unattributed Mac" },
      },
    ]);

    expect(result.windows[0]?.id).toBe("anthropic:five_hour");
    expect(result.windows[0]).not.toHaveProperty("producerInstanceId");
    expect(result.windows[0]?.machine).toBe("Unattributed Mac");
  });
});

describe("provider grouping", () => {
  const events = [
    {
      provider: "google-antigravity",
      label: "Third-Party Models",
      credits: 42,
      limit: 100,
      occurredAt: "2026-09-12T12:00:00.000Z",
      metadata: { bucketId: "claude-gpt", quotaWindow: "5h", source: "antigravity-usage" },
    },
    {
      provider: "anthropic",
      service: "claude-code",
      label: "5h window",
      credits: 62.5,
      limit: 100,
      occurredAt: "2026-09-12T12:00:00.000Z",
      metadata: {
        bucketId: "anthropic:five_hour",
        quotaWindow: "5h",
        resetAt: "2026-09-12T18:00:00.000Z",
        planType: "max_20x",
        source: "api.anthropic.com",
      },
    },
    {
      provider: "xai",
      service: "grok-cli",
      label: "weekly window",
      credits: 75,
      limit: 100,
      occurredAt: "2026-09-12T12:00:00.000Z",
      metadata: { bucketId: "xai:weekly", quotaWindow: "weekly", source: "cli-chat-proxy.grok.com" },
    },
  ];

  it("labels each provider and marks Antigravity buckets as via antigravity", () => {
    const result = projectQuotaWindows(events);
    const anthropic = result.windows.find((row) => row.provider === "anthropic");
    expect(anthropic?.providerLabel).toBe("Claude");
    expect(anthropic?.via).toBeNull();

    const antigravity = result.windows.find((row) => row.provider === "google-antigravity");
    // Antigravity's own routing bucket holds Claude and GPT models (shown as
    // "Third-Party Models").  It is NOT the user's Claude plan, so it must be
    // marked.
    expect(antigravity?.providerLabel).toBe("Antigravity");
    expect(antigravity?.via).toBe("antigravity");
  });

  it("returns a group for every expected provider, empty ones included", () => {
    const result = projectQuotaWindows(events);
    expect(result.providerGroups.map((group) => group.provider)).toEqual([
      "anthropic",
      "openai",
      "google-antigravity",
      "xai",
      "minimax",
      "grok-bot",
    ]);
    const byProvider = new Map(result.providerGroups.map((group) => [group.provider, group]));
    expect(byProvider.get("anthropic")?.windows).toHaveLength(1);
    expect(byProvider.get("xai")?.windows).toHaveLength(1);
    // Never reported yet: visible as an empty group, not silently absent.
    expect(byProvider.get("openai")?.windows).toEqual([]);
    expect(byProvider.get("minimax")?.windows).toEqual([]);
    expect(byProvider.get("minimax")?.providerLabel).toBe("MiniMax");
    expect(byProvider.get("minimax")?.expected).toBe(true);
  });

  it("collapses provider aliases onto one canonical group", () => {
    expect(quotaProviderKey("google")).toBe("google-antigravity");
    expect(quotaProviderKey("openai-codex")).toBe("openai");
    expect(quotaProviderLabel("grok-build")).toBe("Grok");
    expect(quotaProviderVia("google")).toBe("antigravity");
    expect(quotaProviderVia("anthropic")).toBeNull();
    // An unregistered provider still groups, it just has no friendly label.
    const result = projectQuotaWindows([
      {
        provider: "acme",
        label: "monthly window",
        credits: 50,
        limit: 100,
        occurredAt: "2026-09-12T12:00:00.000Z",
        metadata: { bucketId: "acme:monthly" },
      },
    ]);
    const extra = result.providerGroups.find((group) => group.provider === "acme");
    expect(extra?.expected).toBe(false);
    expect(extra?.windows).toHaveLength(1);
  });

  it("never emits an antigravity skip target for another provider's exhausted window", () => {
    const result = projectQuotaWindows([
      {
        provider: "anthropic",
        label: "7d window (Opus)",
        credits: 0,
        limit: 100,
        occurredAt: "2026-09-12T12:00:00.000Z",
        metadata: { bucketId: "anthropic:seven_day_opus", modelId: "opus", isExhausted: true },
      },
    ]);
    expect(result.windows[0]?.status).toBe("exhausted");
    // skipModelTypes drives Antigravity instance routing only.
    expect(result.skipModelTypes).toEqual([]);
  });

  it("emits group skip targets for Antigravity Third-Party and Gemini buckets without modelId", () => {
    const result = projectQuotaWindows([
      {
        provider: "google-antigravity",
        label: "Third-Party Models",
        credits: 0,
        limit: 100,
        occurredAt: "2026-09-12T12:00:00.000Z",
        metadata: { bucketId: "claude-gpt", isExhausted: true, source: "antigravity-usage" },
      },
      {
        provider: "google-antigravity",
        label: "Gemini models",
        credits: 0,
        limit: 0,
        occurredAt: "2026-09-12T12:00:00.000Z",
        metadata: { bucketId: "gemini", isExhausted: true, source: "antigravity-usage" },
      },
      {
        provider: "google-antigravity",
        label: "Other routing bucket",
        credits: 0,
        limit: 100,
        occurredAt: new Date("2026-09-12T12:00:00.000Z"),
        metadata: { bucketId: "other", isExhausted: true, source: "antigravity-usage" },
      },
    ]);
    const models = result.skipModelTypes.map((row) => row.model);
    expect(models).toContain("claude-opus-4-6-thinking");
    expect(models).toContain("gemini-3.1-pro-high");
    expect(models.some((model) => model.includes("other"))).toBe(false);
  });

  it("falls back labels and ignores invalid metadata, duplicate series, and empty provider", () => {
    const result = projectQuotaWindows([
      {
        provider: "anthropic",
        credits: 40,
        occurredAt: "not-a-date",
        metadata: ["not", "an", "object"],
      },
      {
        provider: "anthropic",
        credits: 10,
        limit: 100,
        occurredAt: "2026-09-12T12:00:00.000Z",
        metadata: { bucketId: "anthropic:five_hour" },
      },
      {
        provider: "   ",
        label: "orphan",
        credits: 50,
        limit: 100,
        occurredAt: "2026-09-12T12:00:00.000Z",
        metadata: { bucketId: "blank" },
      },
    ]);
    expect(result.windows.some((row) => row.label === "anthropic")).toBe(true);
    expect(result.windows.filter((row) => row.provider === "anthropic")).toHaveLength(2);
    expect(quotaProviderLabel("   ")).toBe("Unknown");
    expect(quotaProviderKey(undefined as unknown as string)).toBe("");
  });

  it("dedupes identical Antigravity skip targets and leaves skipReason null when available", () => {
    const result = projectQuotaWindows([
      {
        provider: "google-antigravity",
        label: "Opus copy A",
        credits: 0,
        limit: 100,
        occurredAt: "2026-09-12T12:00:00.000Z",
        metadata: { modelId: "claude-opus-4-6-thinking", isExhausted: true },
      },
      {
        provider: "google-antigravity",
        label: "Opus copy B",
        credits: 0,
        limit: 100,
        occurredAt: "2026-09-12T12:01:00.000Z",
        metadata: { modelId: "claude-opus-4-6-thinking", isExhausted: true },
      },
      {
        provider: "google-antigravity",
        label: "Healthy Gemini",
        credits: 80,
        limit: 100,
        occurredAt: "2026-09-12T12:00:00.000Z",
        metadata: { modelId: "gemini-3.1-pro-high" },
      },
    ]);
    expect(result.skipModelTypes.filter((row) => row.model === "claude-opus-4-6-thinking")).toHaveLength(1);
    const healthy = result.windows.find((row) => row.modelId === "gemini-3.1-pro-high");
    expect(healthy?.skip).toBe(false);
    expect(healthy?.skipReason).toBeNull();
  });
});

describe("Antigravity third-party pool display label", () => {
  const base = {
    provider: "google-antigravity",
    credits: 40,
    limit: 100,
    occurredAt: "2026-09-12T12:00:00.000Z",
  };

  it("uses Third-Party Models as the display name", () => {
    expect(ANTIGRAVITY_THIRD_PARTY_LABEL).toBe("Third-Party Models");
  });

  it("maps the legacy Claude and GPT label variants and keeps the window suffix", () => {
    expect(antigravityDisplayLabel("Claude and GPT models")).toBe("Third-Party Models");
    expect(antigravityDisplayLabel("Claude and GPT models (weekly)")).toBe(
      "Third-Party Models (weekly)",
    );
    expect(antigravityDisplayLabel("Claude and GPT models (5h)")).toBe("Third-Party Models (5h)");
    expect(antigravityDisplayLabel("Claude & GPT models (5h)")).toBe("Third-Party Models (5h)");
    expect(antigravityDisplayLabel("claude/gpt")).toBe("Third-Party Models");
    expect(antigravityDisplayLabel("Claude and GPT (weekly)")).toBe("Third-Party Models (weekly)");
  });

  it("passes every other label through untouched", () => {
    expect(antigravityDisplayLabel("Third-Party Models (5h)")).toBe("Third-Party Models (5h)");
    expect(antigravityDisplayLabel("Gemini Models (weekly)")).toBe("Gemini Models (weekly)");
    expect(antigravityDisplayLabel("Claude Opus 4.6 (Thinking)")).toBe("Claude Opus 4.6 (Thinking)");
    expect(antigravityDisplayLabel("Claude and GPT-OSS")).toBe("Claude and GPT-OSS");
    expect(antigravityDisplayLabel(null)).toBeNull();
    expect(antigravityDisplayLabel(undefined)).toBeUndefined();
  });

  it("shows already-ingested legacy labels as Third-Party Models without touching the stored event", () => {
    const stored = {
      ...base,
      label: "Claude and GPT models (weekly)",
      metadata: { bucketId: "3p-weekly", quotaWindow: "weekly", modelGroup: "Claude and GPT models" },
    };
    const result = projectQuotaWindows([stored]);
    expect(result.windows[0]?.label).toBe("Third-Party Models (weekly)");
    // The stored row and its raw group name are display-mapped, never rewritten.
    expect(stored.label).toBe("Claude and GPT models (weekly)");
    expect(stored.metadata.modelGroup).toBe("Claude and GPT models");
    expect(result.windows[0]?.id).toBe("3p-weekly");
  });

  it("collapses a legacy and a new reading of one label-keyed series onto the newest", () => {
    const result = projectQuotaWindows([
      { ...base, label: "Third-Party Models (5h)", credits: 70, occurredAt: "2026-09-12T12:00:00.000Z" },
      { ...base, label: "Claude and GPT models (5h)", credits: 10, occurredAt: "2026-09-12T08:00:00.000Z" },
    ]);
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0]?.label).toBe("Third-Party Models (5h)");
    expect(result.windows[0]?.remainingPercent).toBe(70);
  });

  it("uses the display label in skipReason and still emits Claude/GPT skip targets", () => {
    for (const label of ["Claude and GPT models", "Third-Party Models"]) {
      const result = projectQuotaWindows([{ ...base, label, credits: 0 }]);
      expect(result.windows[0]?.label).toBe("Third-Party Models");
      expect(result.windows[0]?.skipReason).toBe("Third-Party Models remaining 0%");
      const models = result.skipModelTypes.map((row) => row.model);
      expect(models).toContain("claude-opus-4-6-thinking");
      expect(models).toContain("gpt-oss-120b-medium");
      expect(models.some((model) => model.startsWith("gemini"))).toBe(false);
    }
  });

  it("does not rewrite the same label on another provider's window", () => {
    const result = projectQuotaWindows([
      { ...base, provider: "anthropic", label: "Claude and GPT models", metadata: { bucketId: "x" } },
    ]);
    expect(result.windows[0]?.label).toBe("Claude and GPT models");
  });
});
