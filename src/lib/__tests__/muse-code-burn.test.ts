import { describe, it, expect } from "vitest";
import {
  buildMuseCodeBurnReport,
  isContributorModelId,
  type MuseCodeBurnGroups,
} from "../muse-code-burn";

// Fixed literal fixtures — buildMuseCodeBurnReport never calls `new Date()`
// internally, so no fake timers are needed.
const WINDOW_START = new Date("2026-11-02T10:30:00.000Z");
const WINDOW_END = new Date("2026-11-02T12:00:00.000Z");

function groups(overrides: Partial<MuseCodeBurnGroups> = {}): MuseCodeBurnGroups {
  return {
    groups: [],
    firstOccurredAt: null,
    lastOccurredAt: null,
    ...overrides,
  };
}

function build(input: MuseCodeBurnGroups, windowMinutes = 90) {
  return buildMuseCodeBurnReport(input, {
    windowMinutes,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    generatedAt: WINDOW_END,
  });
}

describe("isContributorModelId", () => {
  it("matches exactly the -contributor suffix", () => {
    expect(isContributorModelId("muse-spark-1.3-contributor")).toBe(true);
    expect(isContributorModelId("muse-wonder-full-1.0-contributor")).toBe(true);
    expect(isContributorModelId("muse-wonder-1.0")).toBe(false);
    expect(isContributorModelId("muse-wonder-full-1.0")).toBe(false);
    expect(isContributorModelId(null)).toBe(false);
  });
});

describe("buildMuseCodeBurnReport", () => {
  it("returns zero totals and a null share for an empty window", () => {
    const report = build(groups());

    expect(report.provider).toBe("muse-code");
    expect(report.windowMinutes).toBe(90);
    expect(report.windowStart).toBe(WINDOW_START.toISOString());
    expect(report.windowEnd).toBe(WINDOW_END.toISOString());
    expect(report.totalTokens).toBe(0);
    expect(report.burnRatePerHour).toBe(0);
    expect(report.contributorShare).toBeNull();
    expect(report.allContributor).toBe(false);
    expect(report.eventCount).toBe(0);
    expect(report.firstOccurredAt).toBeNull();
    expect(report.models).toEqual([]);
  });

  it("sums per-model groups into totals, shares, and contributor share", () => {
    const report = build(
      groups({
        groups: [
          { model: "muse-spark-1.3-contributor", tokens: 900_000, eventCount: 12 },
          { model: "muse-wonder-1.0", tokens: 300_000, eventCount: 4 },
        ],
        firstOccurredAt: new Date("2026-11-02T10:45:00.000Z"),
        lastOccurredAt: new Date("2026-11-02T11:59:00.000Z"),
      })
    );

    expect(report.totalTokens).toBe(1_200_000);
    // 1.2M tokens over 90 minutes = 800K/hour.
    expect(report.burnRatePerHour).toBe(800_000);
    expect(report.contributorTokens).toBe(900_000);
    expect(report.contributorShare).toBeCloseTo(0.75);
    expect(report.allContributor).toBe(false);
    expect(report.eventCount).toBe(16);
    expect(report.firstOccurredAt).toBe("2026-11-02T10:45:00.000Z");
    expect(report.lastOccurredAt).toBe("2026-11-02T11:59:00.000Z");
    expect(report.models.map((m) => m.model)).toEqual([
      "muse-spark-1.3-contributor",
      "muse-wonder-1.0",
    ]);
    expect(report.models[0]).toMatchObject({ contributor: true, share: 0.75 });
    expect(report.models[1]).toMatchObject({ contributor: false, share: 0.25 });
  });

  it("reports allContributor and share 1 when every token is contributor", () => {
    const report = build(
      groups({
        groups: [
          { model: "muse-spark-1.3-contributor", tokens: 700_000, eventCount: 5 },
          { model: "muse-wonder-full-1.0-contributor", tokens: 300_000, eventCount: 2 },
        ],
      }),
      60
    );

    expect(report.contributorShare).toBe(1);
    expect(report.allContributor).toBe(true);
    // 1M tokens over 60 minutes = 1M/hour.
    expect(report.burnRatePerHour).toBe(1_000_000);
  });

  it("keeps a null-model group as a non-contributor bucket", () => {
    const report = build(
      groups({
        groups: [
          { model: null, tokens: 50_000, eventCount: 1 },
          { model: "muse-spark-1.3-contributor", tokens: 50_000, eventCount: 1 },
        ],
      })
    );

    expect(report.totalTokens).toBe(100_000);
    expect(report.contributorShare).toBeCloseTo(0.5);
    const unknown = report.models.find((m) => m.model === null);
    expect(unknown?.contributor).toBe(false);
  });

  it("sorts models by tokens desc, then model asc for determinism", () => {
    const report = build(
      groups({
        groups: [
          { model: "muse-wonder-1.0", tokens: 100, eventCount: 1 },
          { model: "muse-spark-1.3-contributor", tokens: 500, eventCount: 1 },
          { model: "muse-wonder-full-1.0", tokens: 100, eventCount: 1 },
        ],
      })
    );

    expect(report.models.map((m) => m.model)).toEqual([
      "muse-spark-1.3-contributor",
      "muse-wonder-1.0",
      "muse-wonder-full-1.0",
    ]);
  });
});
