import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExternalUsageEvent, Prisma } from "@prisma/client";

const prismaMock = vi.hoisted(() => ({
  subscription: { findMany: vi.fn() },
  externalUsageEvent: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    groupBy: vi.fn(),
  },
  externalUsageEventDailyRollup: {
    groupBy: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

import {
  computeAgentsOverview,
  preferPlatformEstimatedCostUsd,
  platformIdForSourceApp,
} from "../agents-overview";
import * as retention from "../data-retention";
import { getLatestMacHealth } from "@/lib/mac-health";

vi.mock("@/lib/mac-health", () => ({
  getLatestMacHealth: vi.fn(),
}));

const mockedMacHealth = vi.mocked(getLatestMacHealth);

type UsageGroupByArgs = Prisma.ExternalUsageEventGroupByArgs;
type UsageFindManyArgs = Prisma.ExternalUsageEventFindManyArgs;
type UsageFindFirstArgs = Prisma.ExternalUsageEventFindFirstArgs;
type RollupGroupByArgs = Prisma.ExternalUsageEventDailyRollupGroupByArgs;

type UsageGroupByRow = Pick<
  Prisma.ExternalUsageEventGroupByOutputType,
  "sourceApp" | "provider" | "keyRef" | "label"
> & {
  _sum?: { quantity?: number | null; costUsd?: number | null };
};

function usageGroupByRows(rows: UsageGroupByRow[]): Prisma.ExternalUsageEventGroupByOutputType[] {
  return rows as Prisma.ExternalUsageEventGroupByOutputType[];
}

type RollupGroupByRow = Pick<
  Prisma.ExternalUsageEventDailyRollupGroupByOutputType,
  "sourceApp" | "provider" | "keyRef" | "label"
> & {
  _sum?: { totalQuantity?: number | null; totalCostUsd?: number | null };
};

function rollupGroupByRows(
  rows: RollupGroupByRow[],
): Prisma.ExternalUsageEventDailyRollupGroupByOutputType[] {
  return rows as Prisma.ExternalUsageEventDailyRollupGroupByOutputType[];
}

type CursorAdminEventRow = Pick<
  ExternalUsageEvent,
  "keyRef" | "quantity" | "unit" | "costUsd" | "metadata" | "occurredAt"
>;

function cursorAdminEvents(rows: CursorAdminEventRow[]): ExternalUsageEvent[] {
  return rows as ExternalUsageEvent[];
}

function metricTypeFromUsageEventWhere(
  where: Prisma.ExternalUsageEventWhereInput | undefined,
): string | undefined {
  if (!where || typeof where !== "object") return undefined;
  const { metricType } = where;
  return typeof metricType === "string" ? metricType : undefined;
}

function sourceAppFromFindManyWhere(
  where: Prisma.ExternalUsageEventWhereInput | undefined,
): string | undefined {
  if (!where || typeof where !== "object") return undefined;
  const { sourceApp } = where;
  return typeof sourceApp === "string" ? sourceApp : undefined;
}

function emptyGroupBy() {
  prismaMock.externalUsageEvent.groupBy.mockResolvedValue([]);
  prismaMock.externalUsageEventDailyRollup.groupBy.mockResolvedValue([]);
}

describe("agents-overview", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    prismaMock.subscription.findMany.mockResolvedValue([]);
    prismaMock.externalUsageEvent.findMany.mockResolvedValue([]);
    prismaMock.externalUsageEvent.findFirst.mockResolvedValue(null);
    mockedMacHealth.mockResolvedValue({
      ok: false,
      status: "offline",
      lastHeartbeatAt: null,
      secondsSinceHeartbeat: null,
      mac: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("computes agent overview with Max/Heavy seat costs from the catalog", async () => {
    prismaMock.externalUsageEvent.groupBy.mockImplementation(async (args: UsageGroupByArgs) => {
      const metricType = metricTypeFromUsageEventWhere(args.where);
      if (metricType === "usage") {
        return usageGroupByRows([
          {
            sourceApp: "claude-code",
            provider: "anthropic",
            keyRef: "claude-sonnet",
            label: "input_tokens",
            _sum: { quantity: 100_000 },
          },
          {
            sourceApp: "claude-code",
            provider: "anthropic",
            keyRef: "claude-sonnet",
            label: "output_tokens",
            _sum: { quantity: 20_000 },
          },
          {
            sourceApp: "openai-codex",
            provider: "openai",
            keyRef: "gpt-5.6-sol",
            label: "input_tokens",
            _sum: { quantity: 50_000 },
          },
        ]);
      }
      if (metricType === "cost") {
        return usageGroupByRows([
          {
            sourceApp: "claude-code",
            provider: "anthropic",
            keyRef: "claude-sonnet",
            label: null,
            _sum: { costUsd: 0.6 },
          },
        ]);
      }
      return [];
    });

    const rollupSpy = prismaMock.externalUsageEventDailyRollup.groupBy.mockResolvedValue([]);
    prismaMock.externalUsageEvent.findFirst.mockImplementation(async (args: UsageFindFirstArgs) => {
      if (args?.where?.label === "observed-plan") return { keyRef: "plus" } as ExternalUsageEvent;
      return null;
    });

    const result = await computeAgentsOverview(30);
    expect(result.ok).toBe(true);
    expect(result.summary.totalTokens).toBe(170_000);
    expect(result.platforms.length).toBe(10);
    // 30-day window sits inside the raw-event retention window, so rollups
    // must not be queried (they would double-count the same days).
    expect(rollupSpy).not.toHaveBeenCalled();
    const claudePlatform = result.platforms.find((p) => p.id === "claude-code");
    expect(claudePlatform).toBeDefined();
    expect(claudePlatform?.totalTokens).toBe(120_000);
    expect(claudePlatform?.monthlySeatCostUsd).toBe(200);
    expect(claudePlatform?.billedMonthlySeatCostUsd).toBe(200);
    expect(claudePlatform?.seatPlanName).toBe("Claude Max 20x");
    expect(claudePlatform?.usageIsReliable).toBe(true);
    expect(claudePlatform?.telemetryAccuracy).toBe("reported");
    const codexPlatform = result.platforms.find((p) => p.id === "openai-codex");
    expect(codexPlatform).toBeDefined();
    expect(codexPlatform?.totalTokens).toBe(50_000);
    expect(codexPlatform?.monthlySeatCostUsd).toBe(20);
    expect(codexPlatform?.seatPlanName).toBe("ChatGPT Plus");
    expect(codexPlatform?.usageIsReliable).toBe(true);
    const grokPlatform = result.platforms.find((p) => p.id === "grok-build");
    expect(grokPlatform?.monthlySeatCostUsd).toBe(300);
    expect(grokPlatform?.billedMonthlySeatCostUsd).toBe(100);
    expect(grokPlatform?.seatPlanName).toBe("SuperGrok Heavy");
    const antigravity = result.platforms.find((p) => p.id === "antigravity-cli");
    expect(antigravity?.monthlySeatCostUsd).toBe(70);
    expect(antigravity?.listMonthlySeatCostUsd).toBe(100);
    const copilot = result.platforms.find((p) => p.id === "github-copilot");
    expect(copilot?.billedMonthlySeatCostUsd).toBe(0);
    const cursor = result.platforms.find((p) => p.id === "cursor-agent");
    expect(cursor?.billedMonthlySeatCostUsd).toBe(0);
    expect(cursor?.listMonthlySeatCostUsd).toBe(200);
    const minimax = result.platforms.find((p) => p.id === "minimax-code");
    expect(minimax?.billedMonthlySeatCostUsd).toBe(0);
    expect(result.platforms.find((p) => p.id === "deepseek-dsh")).toBeDefined();
    expect(result.platforms.find((p) => p.id === "kimi-code")).toBeDefined();
  });

  it("uses rollups only for days before the raw-event cutoff", async () => {
    vi.spyOn(retention, "getExternalEventRawCutoff").mockReturnValue(
      new Date("2026-08-01T00:00:00.000Z"),
    );
    prismaMock.externalUsageEvent.groupBy.mockResolvedValue([]);
    prismaMock.externalUsageEvent.findFirst.mockImplementation(async (args: UsageFindFirstArgs) => {
      if (args?.where?.label === "observed-plan") return { keyRef: "plus" } as ExternalUsageEvent;
      return { occurredAt: new Date("2026-06-15T00:00:00.000Z") } as ExternalUsageEvent;
    });
    prismaMock.externalUsageEventDailyRollup.groupBy.mockImplementation(async (args: RollupGroupByArgs) => {
      const dayFilter = args.where?.day;
      const lt =
        dayFilter && typeof dayFilter === "object" && "lt" in dayFilter
          ? dayFilter.lt
          : undefined;
      expect(lt instanceof Date ? lt.getTime() : lt).toBe(
        new Date("2026-08-01T00:00:00.000Z").getTime(),
      );
      if (metricTypeFromUsageEventWhere(args.where) === "usage") {
        return rollupGroupByRows([
          {
            sourceApp: "openai-codex",
            provider: "openai",
            keyRef: "gpt-5.6-sol",
            label: "input_tokens",
            _sum: { totalQuantity: 50_000 },
          },
        ]);
      }
      return [];
    });

    const result = await computeAgentsOverview(3650);
    const codexFromRollup = result.platforms.find((p) => p.id === "openai-codex");
    expect(codexFromRollup?.totalTokens).toBe(50_000);
  });

  it("prefers Claude Code OTLP reported cost over token-derived PAYG when both exist", async () => {
    prismaMock.externalUsageEvent.groupBy.mockImplementation(async (args: UsageGroupByArgs) => {
      const metricType = metricTypeFromUsageEventWhere(args.where);
      if (metricType === "usage") {
        return usageGroupByRows([
          {
            sourceApp: "claude-code",
            provider: "anthropic",
            keyRef: "claude-sonnet-5",
            label: "input_tokens",
            _sum: { quantity: 1_000_000 },
          },
        ]);
      }
      if (metricType === "cost") {
        return usageGroupByRows([
          {
            sourceApp: "claude-code",
            provider: "anthropic",
            keyRef: "claude-sonnet-5",
            label: null,
            _sum: { costUsd: 0.25 },
          },
        ]);
      }
      return [];
    });
    prismaMock.externalUsageEventDailyRollup.groupBy.mockResolvedValue([]);

    const result = await computeAgentsOverview(30);
    const claude = result.platforms.find((p) => p.id === "claude-code");
    expect(claude?.tokenDerivedCostUsd).toBeCloseTo(2, 2);
    expect(claude?.reportedCostUsd).toBeCloseTo(0.25, 2);
    expect(claude?.estimatedCostUsd).toBeCloseTo(0.25, 2);
    expect(preferPlatformEstimatedCostUsd("claude-code", 2, 0.25)).toBe(0.25);
  });

  it("folds cursor-admin billed rows into the Cursor platform without double-counting cursor-agent", async () => {
    prismaMock.externalUsageEvent.groupBy.mockImplementation(async (args: UsageGroupByArgs) => {
      const metricType = metricTypeFromUsageEventWhere(args.where);
      if (metricType === "usage") {
        return usageGroupByRows([
          {
            sourceApp: "cursor-agent",
            provider: "cursor",
            keyRef: "gpt-5",
            label: "input_tokens",
            _sum: { quantity: 99_000 },
          },
        ]);
      }
      if (metricType === "cost") {
        return usageGroupByRows([
          {
            sourceApp: "cursor-admin",
            provider: "cursor",
            keyRef: "claude-sonnet-4-5",
            label: null,
            _sum: { costUsd: 1.5 },
          },
        ]);
      }
      return [];
    });
    prismaMock.externalUsageEvent.findMany.mockImplementation(async (args: UsageFindManyArgs) => {
      if (sourceAppFromFindManyWhere(args?.where) === "cursor-admin") {
        return cursorAdminEvents([
          {
            keyRef: "claude-sonnet-4-5",
            quantity: 30_000,
            unit: "token",
            costUsd: 1.5,
            metadata: {
              inputTokens: 20_000,
              outputTokens: 10_000,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
            occurredAt: new Date(),
          },
        ]);
      }
      return [];
    });
    prismaMock.externalUsageEventDailyRollup.groupBy.mockResolvedValue([]);

    const result = await computeAgentsOverview(30);
    expect(platformIdForSourceApp("cursor-admin")).toBe("cursor-agent");
    const cursor = result.platforms.find((p) => p.id === "cursor-agent");
    expect(cursor?.usageIsReliable).toBe(true);
    expect(cursor?.totalTokens).toBe(30_000);
    expect(cursor?.reportedCostUsd).toBeCloseTo(1.5, 2);
    expect(cursor?.fidelityTier).toBe("session_jsonl");
    expect(result.summary.totalTokens).toBe(30_000);
  });

  it("does not treat request-based cursor-admin quantity as tokens", async () => {
    prismaMock.externalUsageEvent.groupBy.mockImplementation(async (args: UsageGroupByArgs) => {
      if (metricTypeFromUsageEventWhere(args.where) === "cost") {
        return usageGroupByRows([
          {
            sourceApp: "cursor-admin",
            provider: "cursor",
            keyRef: "claude-sonnet-4-5",
            label: null,
            _sum: { costUsd: 2 },
          },
        ]);
      }
      return [];
    });
    prismaMock.externalUsageEvent.findMany.mockImplementation(async (args: UsageFindManyArgs) => {
      if (sourceAppFromFindManyWhere(args?.where) === "cursor-admin") {
        return cursorAdminEvents([
          {
            keyRef: "claude-sonnet-4-5",
            quantity: 7,
            unit: "request",
            costUsd: 2,
            metadata: {},
            occurredAt: new Date(),
          },
        ]);
      }
      return [];
    });
    prismaMock.externalUsageEventDailyRollup.groupBy.mockResolvedValue([]);

    const result = await computeAgentsOverview(30);
    const cursor = result.platforms.find((p) => p.id === "cursor-agent");
    expect(cursor?.totalTokens).toBe(0);
    expect(cursor?.usageIsReliable).toBe(false);
    expect(cursor?.fidelityTier).toBe("session_jsonl");
    expect(result.summary.totalTokens).toBe(0);
  });

  it("reconciles 5h burn cost with max(reported, derived) except Claude Code prefers reported", async () => {
    prismaMock.externalUsageEvent.groupBy.mockImplementation(async (args: UsageGroupByArgs) => {
      const occurredAt = args.where?.occurredAt;
      const gte =
        occurredAt && typeof occurredAt === "object" && "gte" in occurredAt
          ? occurredAt.gte
          : undefined;
      if (gte instanceof Date && gte.getTime() > Date.now() - 6 * 3600 * 1000) {
        const metricType = metricTypeFromUsageEventWhere(args.where);
        if (metricType === "usage") {
          return usageGroupByRows([
            {
              sourceApp: "claude-code",
              provider: "anthropic",
              keyRef: "claude-sonnet",
              label: "input_tokens",
              _sum: { quantity: 100_000 },
            },
          ]);
        }
        if (metricType === "cost") {
          return usageGroupByRows([
            {
              sourceApp: "claude-code",
              provider: "anthropic",
              keyRef: "claude-sonnet",
              label: null,
              _sum: { costUsd: 0.5 },
            },
          ]);
        }
      }
      return [];
    });

    prismaMock.externalUsageEventDailyRollup.groupBy.mockResolvedValue([]);

    const result = await computeAgentsOverview(30);
    expect(result.burn5h.tokens5h).toBe(100_000);
    // Derived for 100k input tokens on claude-sonnet is below reported; Claude prefers reported.
    expect(result.burn5h.costEstimate5hUsd).toBe(0.5);
  });

  it("uses $70 net Antigravity seat cost and never treats its estimates as usage", async () => {
    prismaMock.externalUsageEvent.groupBy.mockImplementation(async (args: UsageGroupByArgs) => {
      if (metricTypeFromUsageEventWhere(args.where) === "usage") {
        return usageGroupByRows([
          {
            sourceApp: "antigravity-cli",
            provider: "google",
            keyRef: "gemini-3.7-flash",
            label: "token:input",
            _sum: { quantity: 8_000 },
          },
          {
            sourceApp: "claude-code",
            provider: "anthropic",
            keyRef: "claude-sonnet",
            label: "input_tokens",
            _sum: { quantity: 100_000 },
          },
        ]);
      }
      return [];
    });
    prismaMock.externalUsageEventDailyRollup.groupBy.mockResolvedValue([]);

    const result = await computeAgentsOverview(30);
    const antigravity = result.platforms.find((p) => p.id === "antigravity-cli");
    expect(antigravity).toBeDefined();
    expect(antigravity?.monthlySeatCostUsd).toBe(70);
    expect(antigravity?.listMonthlySeatCostUsd).toBe(100);
    expect(antigravity?.bundledOffsetUsd).toBe(30);
    expect(antigravity?.bundledOffsetLabel).toBe("Google One");
    expect(antigravity?.seatCostNote).toContain("$70 net for the AI");
    expect(antigravity?.usageIsReliable).toBe(false);
    expect(antigravity?.telemetryAccuracy).toBe("none_in_window");
    expect(antigravity?.telemetryAccuracyLabel).toBe("not reported");
    expect(antigravity?.totalTokens).toBe(0);
    expect(antigravity?.modelsUsed).toEqual([]);
    expect(result.summary.totalTokens).toBe(100_000);
    expect(result.summary.telemetryIncomplete).toBe(true);
    expect(result.summary.unreliablePlatformIds).toContain("antigravity-cli");
    expect(result.summary.telemetryIncompleteNote).toContain("Antigravity");
  });

  it("labels a running session seat with no events as not reported", async () => {
    mockedMacHealth.mockResolvedValue({
      ok: true,
      status: "online",
      lastHeartbeatAt: "2026-09-03T12:00:00.000Z",
      secondsSinceHeartbeat: 10,
      mac: {
        hostname: "jays.services",
        cpuUsagePct: 10,
        memoryUsagePct: 20,
        diskUsagePct: 30,
        uptimeSeconds: 1000,
        lastHeartbeatAt: "2026-09-03T12:00:00.000Z",
        agentProcesses: { "grok-build": "running" },
      },
    });
    emptyGroupBy();

    const result = await computeAgentsOverview(30);
    const grok = result.platforms.find((p) => p.id === "grok-build");
    expect(grok?.isRunningOnMac).toBe(true);
    expect(grok?.usageIsReliable).toBe(false);
    expect(grok?.telemetryAccuracyLabel).toBe("not reported");
    expect(grok?.telemetryAccuracyNote).toContain("not confirmed as zero usage");
  });

  it("marks Cursor usage as not reported when Admin API rows are absent", async () => {
    emptyGroupBy();
    const result = await computeAgentsOverview(30);
    const cursor = result.platforms.find((p) => p.id === "cursor-agent");
    expect(cursor?.usageIsReliable).toBe(false);
    expect(cursor?.telemetryAccuracy).toBe("unavailable");
    expect(cursor?.totalTokens).toBe(0);
  });

  it("prices DeepSeek flash output from the event UTC hour", async () => {
    prismaMock.externalUsageEvent.groupBy.mockImplementation(async (args: UsageGroupByArgs) => {
      if (metricTypeFromUsageEventWhere(args.where) === "usage") {
        return usageGroupByRows([
          {
            sourceApp: "deepseek-dsh",
            provider: "deepseek",
            keyRef: "deepseek-v4-flash",
            label: "token:output",
            _sum: { quantity: 1_000_000 },
          },
        ]);
      }
      return [];
    });
    prismaMock.externalUsageEvent.findMany.mockImplementation(async (args: UsageFindManyArgs) => {
      if (sourceAppFromFindManyWhere(args?.where) === "cursor-admin") return [];
      return [
        {
          sourceApp: "deepseek-dsh",
          keyRef: "deepseek-v4-flash",
          label: "token:output",
          quantity: 1_000_000,
          // Monday 02:30 UTC is inside the first peak window.  Flash output peak is $1.20 / 1M.
          occurredAt: new Date("2026-09-21T02:30:00.000Z"),
        },
      ] as ExternalUsageEvent[];
    });
    prismaMock.externalUsageEventDailyRollup.groupBy.mockResolvedValue([]);

    const result = await computeAgentsOverview(30);
    const deepseek = result.platforms.find((p) => p.id === "deepseek-dsh");
    expect(deepseek?.totalTokens).toBe(1_000_000);
    expect(deepseek?.apiEquivalentCostUsd).toBeCloseTo(1.2, 2);
    expect(deepseek?.apiEquivalentCostComplete).toBe(true);
    expect(deepseek?.modelsUsed[0]?.apiEquivalentCostUsd).toBeCloseTo(1.2, 4);
    expect(deepseek?.modelsUsed[0]?.apiEquivalentCostKnown).toBe(true);
    expect(result.summary.unpricedModelCount).toBe(0);
    expect(result.modelDistribution[0]?.apiEquivalentCostKnown).toBe(true);
    // Other seats still have no telemetry, so the hero total stays incomplete.
    expect(result.summary.apiEquivalentCostComplete).toBe(false);
  });

  it("does not include cache-unsplit input in the known API-equivalent subtotal", async () => {
    prismaMock.externalUsageEvent.groupBy.mockImplementation(async (args: UsageGroupByArgs) => {
      if (metricTypeFromUsageEventWhere(args.where) === "usage") {
        return usageGroupByRows([
          {
            sourceApp: "antigravity-statusline",
            provider: "google-antigravity",
            keyRef: "gpt-5.6-sol",
            label: "token:inputUnsplit",
            _sum: { quantity: 100_000 },
          },
          {
            sourceApp: "antigravity-statusline",
            provider: "google-antigravity",
            keyRef: "gpt-5.6-sol",
            label: "token:output",
            _sum: { quantity: 10_000 },
          },
        ]);
      }
      return [];
    });
    prismaMock.externalUsageEventDailyRollup.groupBy.mockResolvedValue([]);

    const result = await computeAgentsOverview(30);
    const antigravity = result.platforms.find((p) => p.id === "antigravity-cli");
    expect(antigravity?.totalTokens).toBe(110_000);
    expect(antigravity?.apiEquivalentCostUsd).toBeCloseTo(0.2, 6);
    expect(antigravity?.apiEquivalentCostComplete).toBe(false);
    expect(antigravity?.modelsUsed[0]?.apiEquivalentCostKnown).toBe(false);
  });
});
