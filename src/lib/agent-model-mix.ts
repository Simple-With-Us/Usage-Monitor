// Agent model mix: a fleet-wide (all sourceApps, not one producer) rollup of
// token/cost/event volume grouped by sourceApp x provider x model x seat x
// project over a trailing window.  Built for the weekly "fleet-mode
// compliance digest" script (a sibling repo) to poll — it wants a coarse
// answer to "which agents ran which models, how much, and (once seat
// attribution lands) which seat" without reimplementing the aggregate query.
//
// Split follows the external-usage-events.ts loadAnalyticsTokenRows /
// deriveAnalyticsTokenUsdByProvider convention: one bounded
// prisma.$queryRaw + Prisma.sql aggregate (loadAgentModelMixRows) and one
// PURE reducer (buildAgentModelMixReport) that never calls `new Date()` — the
// caller supplies windowStart/windowEnd/generatedAt so unit tests use plain
// literal Date fixtures with no vi.useFakeTimers() needed (see local memory
// note "wall-clock test rot").
//
// Cost/token figures here are the same class of number as llm-burn.ts and
// claude-cost-check.ts: analytics-only, API-equivalent estimates (recorded
// costUsd where a producer sent one; summed raw token quantity otherwise).
// They are NOT authoritative cash — cash spend is budget-status.ts's job.
//
// "seat" is read via json_extract("metadata", '$.seat') for forward
// compatibility, but src/lib/otlp/mapping-utils.ts's METADATA_ALLOWLIST does
// not yet include "seat" (confirmed 2026-09-24), so every row's seat is
// currently null.  seatDataAvailable in the report reflects that honestly
// instead of hiding the gap.
//
// Production BigInt crash (2026-09-24, found via PR #1541's temporary
// rethrow, fixed in PR #1546): the "tokens"/"costUsd" SUM(CASE ...)
// aggregates were bare, not CAST to REAL.  SQLite's $queryRaw type inference
// samples the FIRST row's runtime storage class per column to decide how
// Prisma should deserialize every row in that column -- when the first
// group's sum happened to land on an exact integer (e.g. a group with zero
// matching 'cost' events, summing to literal 0), Prisma inferred Int64/BigInt
// for the whole column, then threw `RangeError: The number 0.3... cannot be
// converted to a BigInt` converting a LATER group's genuinely fractional
// dollar amount.  Reproduced locally against a real SQLite db (see
// agent-model-mix.db.test.ts) and fixed by wrapping both SUMs in
// CAST(... AS REAL).
//
// Follow-up NULL-first variant (2026-09-25, adversarial review of PR #1546):
// `COALESCE(CAST(SUM(...) AS REAL), 0)` still crashed when the FIRST group's
// matching rows all had a NULL costUsd/quantity -- SUM() over all-NULL input
// returns SQL NULL, so COALESCE fell back to the untyped literal `0` and
// Prisma re-locked the column to BigInt exactly as before.  Reproduced the
// same RangeError against real SQLite with a NULL-only first group followed
// by a fractional-valued later group.  Fixed by switching both aggregates to
// SQLite's TOTAL(...), which always returns a REAL and never NULL (a bare
// TOTAL() over zero/NULL-only input is the float `0.0`, not SQL NULL), so
// there is no COALESCE fallback left for Prisma's type inference to latch
// onto.  See cost-by-session.ts for the same TOTAL() fix applied to its
// sibling aggregate, and the module docblock note there.
//
// The original bug was invisible in the first PR's tests because they mocked
// $queryRaw entirely (fails-closed contract below), never exercising real
// SQLite runtime typing -- same class of gap the cost-by-session.db.test.ts
// precedent (PR #1534) exists to close.  loadAgentModelMixRows's catch below
// now also logs via console.warn on a query failure, so a future regression
// shows up in server logs instead of silently degrading to an empty "no
// usage this window" result the way this one did.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export interface AgentModelMixRow {
  sourceApp: string;
  provider: string;
  /** ExternalUsageEvent.keyRef — the model identifier field in this schema. */
  model: string | null;
  /** json_extract("metadata", '$.seat'); null until the OTLP allowlist adds "seat". */
  seat: string | null;
  /** json_extract("metadata", '$.project'); the producer-supplied project name. */
  project: string | null;
  tokens: number;
  costUsd: number;
  eventCount: number;
}

/**
 * Fleet-wide aggregate over ExternalUsageEvent for the trailing window —
 * every sourceApp, not filtered to claude-code.  One bounded query; grouped
 * in SQL so the row count is bounded by the distinct
 * sourceApp/provider/model/seat/project combinations, not raw event count.
 * Fails closed (empty array) when the Prisma client in tests has no
 * $queryRaw, matching loadAnalyticsTokenRows's contract.
 */
export async function loadAgentModelMixRows(
  windowStart: Date,
  windowEnd: Date
): Promise<AgentModelMixRow[]> {
  if (typeof prisma.$queryRaw !== "function") return [];
  try {
    const rows = await prisma.$queryRaw<
      Array<{
        sourceApp: string;
        provider: string;
        model: string | null;
        seat: string | null;
        project: string | null;
        tokens: unknown;
        costUsd: unknown;
        eventCount: unknown;
      }>
    >(Prisma.sql`
      SELECT
        "sourceApp",
        "provider",
        "keyRef" AS "model",
        json_extract("metadata", '$.seat') AS "seat",
        json_extract("metadata", '$.project') AS "project",
        TOTAL(CASE WHEN "metricType" = 'usage' AND "unit" = 'token' THEN "quantity" ELSE 0 END) AS "tokens",
        TOTAL(CASE WHEN "metricType" = 'cost' THEN "costUsd" ELSE 0 END) AS "costUsd",
        COUNT(*) AS "eventCount"
      FROM "ExternalUsageEvent"
      WHERE "occurredAt" >= ${windowStart}
        AND "occurredAt" <= ${windowEnd}
      GROUP BY
        "sourceApp",
        "provider",
        "keyRef",
        json_extract("metadata", '$.seat'),
        json_extract("metadata", '$.project')
    `);
    if (!Array.isArray(rows)) return [];
    return rows
      .filter((row) => typeof row?.sourceApp === "string" && typeof row.provider === "string")
      .map((row) => ({
        sourceApp: row.sourceApp,
        provider: row.provider,
        model: row.model ?? null,
        seat: row.seat ?? null,
        project: row.project ?? null,
        tokens: Number(row.tokens ?? 0),
        costUsd: Number(row.costUsd ?? 0),
        eventCount: Number(row.eventCount ?? 0),
      }));
  } catch (err) {
    // Fails closed to [] like loadAnalyticsTokenRows -- a query hiccup
    // degrades the digest to "no data this window" rather than 500ing the
    // route.  See the module docblock's "production BigInt crash" notes:
    // this catch swallowing the error silently is why both underlying bugs
    // went undiagnosed until PR #1541's temporary rethrow surfaced the
    // first one.  Logging here (added in the 2026-09-25 follow-up) is a
    // cheap guard against a repeat: a future query failure now shows up in
    // server logs as a warning instead of masquerading as "no usage this
    // window" with zero trace of why.
    console.warn("[agent-model-mix] aggregate query failed; returning empty", err);
    return [];
  }
}

export interface AgentModelMixReport {
  windowStart: string;
  windowEnd: string;
  days: number;
  generatedAt: string;
  /** True iff at least one aggregated row carries a non-null seat. */
  seatDataAvailable: boolean;
  costSemantics: "estimated_api_equivalent_not_authoritative";
  billingMode: "estimated";
  rows: AgentModelMixRow[];
  totals: {
    tokens: number;
    costUsd: number;
    eventCount: number;
  };
}

/**
 * Pure reducer: shapes loaded rows into the response the digest script
 * consumes.  Deliberately takes windowStart/windowEnd/days/generatedAt as
 * parameters instead of calling `new Date()` — see the module docblock.
 * Rows are sorted by tokens desc (then costUsd desc, then
 * sourceApp/provider/model asc) so the biggest fleet consumers sort first
 * and output is deterministic for a fixed input.
 */
export function buildAgentModelMixReport(
  rows: AgentModelMixRow[],
  windowStart: Date,
  windowEnd: Date,
  days: number,
  generatedAt: Date
): AgentModelMixReport {
  const sorted = [...rows].sort((a, b) => {
    if (b.tokens !== a.tokens) return b.tokens - a.tokens;
    if (b.costUsd !== a.costUsd) return b.costUsd - a.costUsd;
    const bySourceApp = a.sourceApp.localeCompare(b.sourceApp);
    if (bySourceApp !== 0) return bySourceApp;
    const byProvider = a.provider.localeCompare(b.provider);
    if (byProvider !== 0) return byProvider;
    return (a.model ?? "").localeCompare(b.model ?? "");
  });

  const totals = sorted.reduce(
    (acc, row) => {
      acc.tokens += row.tokens;
      acc.costUsd += row.costUsd;
      acc.eventCount += row.eventCount;
      return acc;
    },
    { tokens: 0, costUsd: 0, eventCount: 0 }
  );

  return {
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    days,
    generatedAt: generatedAt.toISOString(),
    seatDataAvailable: sorted.some((row) => row.seat != null),
    costSemantics: "estimated_api_equivalent_not_authoritative",
    billingMode: "estimated",
    rows: sorted,
    totals,
  };
}
