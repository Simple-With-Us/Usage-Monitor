import { beforeEach, describe, it, expect, vi } from "vitest";

// The loader tests mock Prisma's groupBy with a faithful where-filter +
// grouping simulation over fixture rows, so a missing sourceApp pin in the
// loader's where clause makes the foreign-producer rows below leak into the
// result and fail the test — the mock applies only the filters the loader
// actually sends.
const mocks = vi.hoisted(() => ({
  groupBy: vi.fn(),
  rows: [] as Array<{
    provider: string;
    sourceApp: string;
    metricType: string;
    unit: string | null;
    keyRef: string | null;
    quantity: number | null;
    occurredAt: Date;
  }>,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    externalUsageEvent: {
      groupBy: mocks.groupBy,
    },
  },
}));

import {
  buildMuseCodeBurnReport,
  isContributorModelId,
  loadMuseCodeBurnGroups,
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

type FixtureRow = (typeof mocks.rows)[number];

function fixtureRow(overrides: Partial<FixtureRow>): FixtureRow {
  return {
    provider: "muse-code",
    sourceApp: "muse-code",
    metricType: "usage",
    unit: "token",
    keyRef: "muse-spark-1.3-contributor",
    quantity: 0,
    occurredAt: new Date("2026-11-02T11:00:00.000Z"),
    ...overrides,
  };
}

/** Simulate Prisma groupBy: apply the where equality/range filters the
 * loader sent, then group by the requested fields with the requested
 * aggregates. */
function simulateGroupBy(args: {
  by: string[];
  where: Record<string, unknown>;
  _sum?: unknown;
  _count?: unknown;
  _min?: unknown;
  _max?: unknown;
}) {
  const where = args.where as {
    provider?: string;
    sourceApp?: string;
    metricType?: string;
    unit?: string;
    occurredAt: { gte: Date; lte: Date };
  };
  const filtered = mocks.rows.filter(
    (row) =>
      (where.provider === undefined || row.provider === where.provider) &&
      (where.sourceApp === undefined || row.sourceApp === where.sourceApp) &&
      (where.metricType === undefined ||
        row.metricType === where.metricType) &&
      (where.unit === undefined || row.unit === where.unit) &&
      row.occurredAt >= where.occurredAt.gte &&
      row.occurredAt <= where.occurredAt.lte
  );
  const buckets = new Map<string, FixtureRow[]>();
  for (const row of filtered) {
    const key = args.by
      .map((field) => String(row[field as keyof FixtureRow]))
      .join("|");
    const bucket = buckets.get(key) ?? [];
    bucket.push(row);
    buckets.set(key, bucket);
  }
  return [...buckets.values()].map((items) => {
    const out: Record<string, unknown> = {};
    for (const field of args.by) {
      out[field] = items[0][field as keyof FixtureRow];
    }
    if (args._sum) {
      out._sum = {
        quantity: items.reduce((sum, row) => sum + (row.quantity ?? 0), 0),
      };
    }
    if (args._count) out._count = { _all: items.length };
    if (args._min) {
      out._min = {
        occurredAt: new Date(
          Math.min(...items.map((row) => row.occurredAt.getTime()))
        ),
      };
    }
    if (args._max) {
      out._max = {
        occurredAt: new Date(
          Math.max(...items.map((row) => row.occurredAt.getTime()))
        ),
      };
    }
    return out;
  });
}

describe("loadMuseCodeBurnGroups", () => {
  beforeEach(() => {
    mocks.groupBy.mockReset();
    mocks.rows = [];
    mocks.groupBy.mockImplementation(async (args: Parameters<typeof simulateGroupBy>[0]) =>
      simulateGroupBy(args)
    );
  });

  it("pins sourceApp to the CodeCaps producer in both groupBy queries", async () => {
    await loadMuseCodeBurnGroups(WINDOW_START, WINDOW_END);

    expect(mocks.groupBy).toHaveBeenCalledTimes(2);
    for (const call of mocks.groupBy.mock.calls) {
      expect(call[0].where).toMatchObject({
        provider: "muse-code",
        sourceApp: "muse-code",
        metricType: "usage",
        unit: "token",
      });
    }
  });

  it("excludes provider muse-code rows from other producers (deepseek-dsh, opencode)", async () => {
    mocks.rows = [
      // CodeCaps rows — the only ones that count.
      fixtureRow({
        keyRef: "muse-spark-1.3-contributor",
        quantity: 900_000,
        occurredAt: new Date("2026-11-02T11:00:00.000Z"),
      }),
      fixtureRow({
        keyRef: "muse-wonder-1.0",
        quantity: 100_000,
        occurredAt: new Date("2026-11-02T11:30:00.000Z"),
      }),
      // DeepSeek Harness maps its "meta"/"muse*" upstreams onto provider
      // "muse-code" but posts as sourceApp "deepseek-dsh".
      fixtureRow({
        sourceApp: "deepseek-dsh",
        keyRef: "muse-wonder-1.0",
        quantity: 500_000,
        occurredAt: new Date("2026-11-02T10:45:00.000Z"),
      }),
      // opencode does the same mapping for providerID "meta"/"muse*".
      fixtureRow({
        sourceApp: "opencode",
        keyRef: "muse-spark-1.3",
        quantity: 700_000,
        occurredAt: new Date("2026-11-02T11:59:00.000Z"),
      }),
    ];

    const loaded = await loadMuseCodeBurnGroups(WINDOW_START, WINDOW_END);

    expect(loaded.groups).toEqual([
      { model: "muse-spark-1.3-contributor", tokens: 900_000, eventCount: 1 },
      { model: "muse-wonder-1.0", tokens: 100_000, eventCount: 1 },
    ]);
    // The activity bounds come from the same filtered query, so the foreign
    // rows' earlier/later timestamps must not widen them.
    expect(loaded.firstOccurredAt).toEqual(
      new Date("2026-11-02T11:00:00.000Z")
    );
    expect(loaded.lastOccurredAt).toEqual(
      new Date("2026-11-02T11:30:00.000Z")
    );

    const report = build(loaded);
    expect(report.totalTokens).toBe(1_000_000);
    expect(report.contributorTokens).toBe(900_000);
    expect(report.contributorShare).toBeCloseTo(0.9);
  });

  it("fails closed to empty groups when the query throws", async () => {
    mocks.groupBy.mockRejectedValue(new Error("sqlite busy"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const loaded = await loadMuseCodeBurnGroups(WINDOW_START, WINDOW_END);
      expect(loaded).toEqual({
        groups: [],
        firstOccurredAt: null,
        lastOccurredAt: null,
      });
    } finally {
      warnSpy.mockRestore();
    }
  });
});
