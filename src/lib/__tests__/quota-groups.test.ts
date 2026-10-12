import { describe, expect, it } from "vitest";

import {
  buildQuotaGroups,
  pickPrimarySource,
  quotaSourceFreshness,
  type QuotaSourceCandidate,
} from "../quota-groups";
import type { QuotaEventLike } from "../quota-windows";

const NOW = new Date("2026-10-12T12:00:00.000Z");

function candidate(
  partial: Partial<QuotaSourceCandidate> & Pick<QuotaSourceCandidate, "reportedAt">,
): QuotaSourceCandidate {
  return {
    source: partial.source ?? "unknown",
    sourceLabel: partial.sourceLabel ?? "Unknown",
    machine: partial.machine ?? null,
    collector: partial.collector ?? null,
    remainingPercent: partial.remainingPercent ?? 50,
    remainingUnknown: partial.remainingUnknown ?? false,
    isExhausted: partial.isExhausted ?? false,
    resetAt: partial.resetAt ?? null,
    reportedAt: partial.reportedAt,
    freshness: partial.freshness ?? "fresh",
    kindRank: partial.kindRank ?? 1,
    reportedMs: Date.parse(partial.reportedAt),
  };
}

function claudeEvent(
  partial: Partial<QuotaEventLike> & { occurredAt: string; credits?: number | null },
): QuotaEventLike {
  return {
    provider: "anthropic",
    sourceApp: partial.sourceApp ?? "subscription-quota-collector",
    label: partial.label ?? "5-hour",
    credits: partial.credits ?? 70,
    limit: 100,
    occurredAt: partial.occurredAt,
    metadata: partial.metadata ?? {},
  };
}

describe("quotaSourceFreshness", () => {
  const nowMs = NOW.getTime();

  it("classifies fresh, stale, old, and expired tiers", () => {
    expect(quotaSourceFreshness("2026-10-12T11:40:00.000Z", nowMs)).toBe("fresh");
    expect(quotaSourceFreshness("2026-10-12T08:00:00.000Z", nowMs)).toBe("stale");
    expect(quotaSourceFreshness("2026-10-12T02:00:00.000Z", nowMs)).toBe("old");
    expect(quotaSourceFreshness("2026-10-09T12:00:00.000Z", nowMs)).toBe("expired");
  });
});

describe("pickPrimarySource", () => {
  const nowMs = NOW.getTime();

  it("prefers fresh CodeCaps over a fresh API collector", () => {
    const chosen = pickPrimarySource(
      [
        candidate({
          source: "api.anthropic.com",
          sourceLabel: "Anthropic API",
          reportedAt: "2026-10-12T11:58:00.000Z",
          remainingPercent: 90,
          kindRank: 2,
        }),
        candidate({
          source: "codecaps",
          sourceLabel: "CodeCaps",
          reportedAt: "2026-10-12T11:55:00.000Z",
          remainingPercent: 40,
          kindRank: 3,
        }),
      ],
      nowMs,
    );
    expect(chosen?.source).toBe("codecaps");
  });

  it("prefers a fresh collector over stale CodeCaps", () => {
    const chosen = pickPrimarySource(
      [
        candidate({
          source: "codecaps",
          sourceLabel: "CodeCaps",
          reportedAt: "2026-10-12T08:00:00.000Z",
          freshness: "stale",
          kindRank: 3,
        }),
        candidate({
          source: "api.anthropic.com",
          sourceLabel: "Anthropic API",
          reportedAt: "2026-10-12T11:59:00.000Z",
          kindRank: 2,
        }),
      ],
      nowMs,
    );
    expect(chosen?.source).toBe("api.anthropic.com");
  });

  it("breaks a five-minute tie by lower remaining percent", () => {
    const chosen = pickPrimarySource(
      [
        candidate({
          source: "api.anthropic.com",
          reportedAt: "2026-10-12T11:59:00.000Z",
          remainingPercent: 80,
          kindRank: 2,
        }),
        candidate({
          source: "claude-code",
          reportedAt: "2026-10-12T11:57:00.000Z",
          remainingPercent: 15,
          kindRank: 2,
        }),
      ],
      nowMs,
    );
    expect(chosen?.remainingPercent).toBe(15);
  });

  it("falls back to the newest stale report when nothing is fresh", () => {
    const chosen = pickPrimarySource(
      [
        candidate({
          source: "codecaps",
          reportedAt: "2026-10-12T08:00:00.000Z",
          freshness: "stale",
          kindRank: 3,
        }),
        candidate({
          source: "api.anthropic.com",
          reportedAt: "2026-10-12T09:30:00.000Z",
          freshness: "stale",
          kindRank: 2,
        }),
      ],
      nowMs,
    );
    expect(chosen?.source).toBe("api.anthropic.com");
  });

  it("returns null when every candidate is expired", () => {
    const chosen = pickPrimarySource(
      [
        candidate({
          source: "codecaps",
          reportedAt: "2026-10-09T12:00:00.000Z",
          freshness: "old",
        }),
      ],
      nowMs,
    );
    expect(chosen).toBeNull();
  });
});

describe("buildQuotaGroups", () => {
  it("merges the same window across sources and treats null credits as unknown", () => {
    const groups = buildQuotaGroups(
      [
        claudeEvent({
          occurredAt: "2026-10-12T11:55:00.000Z",
          credits: 60,
          metadata: {
            bucketId: "anthropic:five_hour",
            quotaWindow: "5h",
            source: "codecaps",
            machine: "Mac.Jays.Services",
          },
        }),
        claudeEvent({
          occurredAt: "2026-10-12T11:58:00.000Z",
          credits: 40,
          metadata: {
            bucketId: "anthropic:five_hour",
            quotaWindow: "5h",
            source: "api.anthropic.com",
          },
        }),
        claudeEvent({
          occurredAt: "2026-10-12T11:50:00.000Z",
          credits: null,
          metadata: {
            bucketId: "anthropic:five_hour",
            quotaWindow: "5h",
            source: "api.anthropic.com",
            remainingUnknown: true,
          },
        }),
      ],
      NOW,
    );

    const claude = groups.find((group) => group.provider === "anthropic");
    expect(claude?.windows).toHaveLength(1);
    const window = claude?.windows[0];
    expect(window?.displayName).toBe("5-hour");
    expect(window?.primary.source).toBe("codecaps");
    expect(window?.sources.length).toBeGreaterThanOrEqual(2);
    const unknownRow = window?.sources.find((row) => row.remainingUnknown);
    expect(unknownRow?.remainingPercent).toBeNull();
    expect(unknownRow?.isExhausted).toBe(false);
  });

  it("omits sources older than forty-eight hours", () => {
    const groups = buildQuotaGroups(
      [
        claudeEvent({
          occurredAt: "2026-10-09T12:00:00.000Z",
          metadata: { bucketId: "anthropic:five_hour", source: "codecaps" },
        }),
      ],
      NOW,
    );
    expect(groups.find((group) => group.provider === "anthropic")?.windows ?? []).toHaveLength(0);
  });
});
