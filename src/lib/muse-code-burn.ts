/**
 * Muse Code burn report — the server read path for the token events the
 * CodeCaps app posts from the Mac.
 *
 * CodeCaps reads the Muse Code session stores itself (Swift, QuotaCore
 * reader pattern) and posts per-model TOKEN events through the standard v2
 * ingest as producer "muse-code": metricType "usage", unit "token",
 * producerKeyRef = modelId, quantity = the positive delta of a session's
 * latest-segment totalTokens since its previous observation (stable
 * eventIds make replays dedupe).  Because the events are true deltas with
 * unit "token", every existing token-summing read already counts them; this
 * module adds the one read they do not provide: a minutes-granularity
 * trailing window (the evaluator's 90 minutes is not an integer number of
 * hours for /api/llm-burn), grouped by model, with contributor share
 * computed server-side, behind the USAGE_READ_TOKEN bearer an external
 * client can actually hold (/api/llm-burn is dashboard-session only and
 * folds models away in its report).
 *
 * Contributor models are exactly the modelIds ending in "-contributor".
 *
 * The reducer is a pure function of already-loaded groups plus
 * caller-supplied window parameters (no hidden clock), the same split
 * agent-model-mix.ts uses.  The loader fails closed to empty groups on a
 * query error (with a console.warn, same convention) so a hiccup degrades
 * the endpoint to "no data" instead of a 500.
 */

import { prisma } from "@/lib/prisma";

export const MUSE_CODE_BURN_PROVIDER = "muse-code";
export const DEFAULT_MUSE_CODE_BURN_WINDOW_MINUTES = 90;
export const MAX_MUSE_CODE_BURN_WINDOW_MINUTES = 240;

export function isContributorModelId(model: string | null): boolean {
  return typeof model === "string" && model.endsWith("-contributor");
}

export interface MuseCodeBurnModelGroup {
  /** ExternalUsageEvent.keyRef — the model id; null when unreported. */
  model: string | null;
  tokens: number;
  eventCount: number;
}

export interface MuseCodeBurnGroups {
  groups: MuseCodeBurnModelGroup[];
  firstOccurredAt: Date | null;
  lastOccurredAt: Date | null;
}

export interface MuseCodeBurnModel {
  model: string | null;
  tokens: number;
  eventCount: number;
  contributor: boolean;
  /** Share of the window total, 0..1; 0 when the total is 0. */
  share: number;
}

export interface MuseCodeBurnReport {
  provider: string;
  windowMinutes: number;
  windowStart: string;
  windowEnd: string;
  generatedAt: string;
  totalTokens: number;
  /** totalTokens normalized to an hourly rate for the measured window. */
  burnRatePerHour: number;
  contributorTokens: number;
  /** 0..1, or null when the window has zero tokens (share is undefined). */
  contributorShare: number | null;
  /** True when every token in the window is on a contributor model. */
  allContributor: boolean;
  eventCount: number;
  /** Oldest/newest event inside the window; null when the window is empty. */
  firstOccurredAt: string | null;
  lastOccurredAt: string | null;
  models: MuseCodeBurnModel[];
}

/**
 * Load per-model token sums for provider "muse-code" over the trailing
 * window.  Two bounded groupBy queries (by model, and one activity row),
 * never raw rows.  Fails closed to empty groups on any query error (see
 * module docblock) rather than throwing into the route.
 */
export async function loadMuseCodeBurnGroups(
  windowStart: Date,
  windowEnd: Date
): Promise<MuseCodeBurnGroups> {
  const empty: MuseCodeBurnGroups = {
    groups: [],
    firstOccurredAt: null,
    lastOccurredAt: null,
  };
  if (typeof prisma.externalUsageEvent?.groupBy !== "function") return empty;
  try {
    const where = {
      provider: MUSE_CODE_BURN_PROVIDER,
      metricType: "usage",
      unit: "token",
      occurredAt: { gte: windowStart, lte: windowEnd },
    };
    const [modelGroups, activity] = await Promise.all([
      prisma.externalUsageEvent.groupBy({
        by: ["keyRef"],
        where,
        _sum: { quantity: true },
        _count: { _all: true },
      }),
      prisma.externalUsageEvent.groupBy({
        by: ["provider"],
        where,
        _min: { occurredAt: true },
        _max: { occurredAt: true },
      }),
    ]);
    const activityRow = activity[0];
    return {
      groups: modelGroups.map((group) => ({
        model: group.keyRef ?? null,
        tokens: group._sum.quantity ?? 0,
        eventCount: group._count._all,
      })),
      firstOccurredAt: activityRow?._min.occurredAt ?? null,
      lastOccurredAt: activityRow?._max.occurredAt ?? null,
    };
  } catch (err) {
    console.warn("[muse-code-burn] token group query failed; returning empty", err);
    return empty;
  }
}

/** Pure reducer: shape loaded per-model groups into the burn report. */
export function buildMuseCodeBurnReport(
  groups: MuseCodeBurnGroups,
  options: {
    windowMinutes: number;
    windowStart: Date;
    windowEnd: Date;
    generatedAt: Date;
  }
): MuseCodeBurnReport {
  const { windowMinutes } = options;
  const models: MuseCodeBurnModel[] = groups.groups
    .map((group) => ({
      model: group.model,
      tokens: group.tokens,
      eventCount: group.eventCount,
      contributor: isContributorModelId(group.model),
      share: 0,
    }))
    .sort(
      (a, b) =>
        b.tokens - a.tokens || (a.model ?? "").localeCompare(b.model ?? "")
    );
  const totalTokens = models.reduce((sum, model) => sum + model.tokens, 0);
  const contributorTokens = models
    .filter((model) => model.contributor)
    .reduce((sum, model) => sum + model.tokens, 0);
  for (const model of models) {
    model.share = totalTokens > 0 ? model.tokens / totalTokens : 0;
  }
  return {
    provider: MUSE_CODE_BURN_PROVIDER,
    windowMinutes,
    windowStart: options.windowStart.toISOString(),
    windowEnd: options.windowEnd.toISOString(),
    generatedAt: options.generatedAt.toISOString(),
    totalTokens,
    burnRatePerHour: (totalTokens * 60) / windowMinutes,
    contributorTokens,
    contributorShare: totalTokens > 0 ? contributorTokens / totalTokens : null,
    allContributor: totalTokens > 0 && contributorTokens === totalTokens,
    eventCount: models.reduce((sum, model) => sum + model.eventCount, 0),
    firstOccurredAt: groups.firstOccurredAt?.toISOString() ?? null,
    lastOccurredAt: groups.lastOccurredAt?.toISOString() ?? null,
    models,
  };
}
