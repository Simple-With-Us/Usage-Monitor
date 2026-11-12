import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// GET /api/cost-by-session -- "cost per board item" view (see AGENTS.md ->
// Sentry agent-telemetry plan, "Next" horizon). THE BOARD (mac-collab) links
// a finding to the Claude Code session id(s) that worked it via
// `board claim/status/comment --session`. This module answers "what did
// those sessions cost", by summing the ExternalUsageEvent rows Claude Code's
// OTLP exporter already pushed here (see src/lib/otlp/claude-code-mapper.ts),
// matched on the `session.id` resource attribute now kept in `metadata`
// (src/lib/otlp/mapping-utils.ts's METADATA_ALLOWLIST).
//
// Analytics-only, like every claude-code cost number in this app: the
// underlying claude_code.cost.usage metric is an API-equivalent estimate
// (billingMode="estimated"), never cash, never read by budget math. This
// view exists to answer "was this task worth the model tier", not "what did
// we owe".
//
// SQLite has no server-side JSON path index, so filtering by session id
// happens via json_extract() in a $queryRaw aggregate (same pattern as
// external-usage-events.ts's loadAnalyticsTokenRows / sumDerivedCostEstimates
// and key-attribution/route.ts) rather than materializing raw rows and
// filtering in JS -- that's the OOM anti-pattern llm-burn.ts's docblock
// warns about. The aggregate is grouped by (sessionId, metricType, unit,
// keyRef, label), which is bounded by session count x a handful of claude-code
// metric shapes, never by raw event count.

export const MAX_SESSION_IDS = 100;
// Aligned with data-retention.ts's DEFAULT_EXTERNAL_EVENT_RETENTION_DAYS (90):
// past that, raw ExternalUsageEvent rows (and their metadata -- including
// session.id) are pruned into ExternalUsageEventDailyRollup, which does not
// retain per-session attribution. The route additionally clamps the actual
// query `since` to the *live* retention cutoff (via
// data-retention.ts's getExternalEventRawCutoff), so a deployment that
// overrides EXTERNAL_USAGE_EVENT_RAW_RETENTION_DAYS is still handled
// correctly even though these two constants can't see that env var change.
export const DEFAULT_WINDOW_DAYS = 90;
export const MAX_WINDOW_DAYS = 180;

export interface CostBySessionRow {
  sessionId: string;
  metricType: string;
  unit: string | null;
  model: string | null;
  label: string | null;
  quantity: number;
  costUsd: number;
  eventCount: number;
  firstOccurredAt: Date;
  lastOccurredAt: Date;
}

export interface SessionTokenBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  unknown: number;
  total: number;
}

export interface SessionCostSummary {
  sessionId: string;
  eventCount: number;
  tokens: SessionTokenBreakdown;
  costUsd: number;
  models: string[];
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface CostBySessionReport {
  requestedSessionIds: string[];
  matchedSessionIds: string[];
  unmatchedSessionIds: string[];
  sessions: SessionCostSummary[];
  totals: {
    eventCount: number;
    tokens: SessionTokenBreakdown;
    costUsd: number;
  };
  billingMode: "estimated";
  costSemantics: "estimated_api_equivalent_not_authoritative";
}

const TOKEN_TYPE_LABEL_PREFIX = "token:";

function tokenTypeFromLabel(label: string | null): keyof SessionTokenBreakdown {
  if (!label || !label.startsWith(TOKEN_TYPE_LABEL_PREFIX)) return "unknown";
  const type = label.slice(TOKEN_TYPE_LABEL_PREFIX.length);
  return type === "input" || type === "output" || type === "cacheRead" || type === "cacheCreation"
    ? type
    : "unknown";
}

function emptyTokens(): SessionTokenBreakdown {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, unknown: 0, total: 0 };
}

function addTokens(into: SessionTokenBreakdown, type: keyof SessionTokenBreakdown, quantity: number): void {
  into[type] += quantity;
  into.total += quantity;
}

/**
 * Prisma's SQLite $queryRaw loses the DateTime-column type mapping on an
 * aggregated value: a direct SELECT of `occurredAt` deserializes to a JS
 * Date, but `MIN("occurredAt")` / `MAX("occurredAt")` comes back as the raw
 * driver value for that column's underlying storage -- observed as a bigint
 * (milliseconds since epoch) here, but this coerces defensively across
 * bigint, number, epoch-ms string, and ISO string so it doesn't silently
 * break again if the driver's raw-aggregate representation changes.
 * `new Date(bigint)` throws TypeError, which is exactly the bug this fixes.
 */
function coerceOccurredAt(value: Date | string | number | bigint): Date {
  if (value instanceof Date) return value;
  if (typeof value === "bigint" || typeof value === "number") return new Date(Number(value));
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return new Date(Number(trimmed));
  return new Date(trimmed);
}

/**
 * Parse and validate the `ids` query parameter: comma-separated and/or
 * repeated (`ids=a&ids=b`), trimmed, order-preserving de-dup. Returns an
 * error string instead of throwing so the route can 400 with a clear reason.
 */
export function parseSessionIdsParam(searchParams: URLSearchParams): { ids: string[] } | { error: string } {
  const raw: string[] = [];
  for (const value of searchParams.getAll("ids")) {
    raw.push(...value.split(","));
  }
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const candidate of raw) {
    const id = candidate.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  if (ids.length === 0) {
    return { error: "ids_required" };
  }
  if (ids.length > MAX_SESSION_IDS) {
    return { error: `too_many_ids (max ${MAX_SESSION_IDS})` };
  }
  return { ids };
}

/**
 * Bounded SQLite aggregate: sum quantity/costUsd/eventCount and track the
 * occurredAt span, grouped by session id + the dimensions needed to recover
 * a token-type breakdown per session.  `sourceApp = 'claude-code'` narrows to
 * the OTLP-mapped rows that carry a session.id at all (see
 * claude-code-mapper.ts) -- other producers never set this metadata key.
 *
 * quantity/costUsd use SQLite's TOTAL(...), not SUM(...), for the same
 * reason agent-model-mix.ts's sibling aggregate does (see that module's
 * docblock, "Follow-up NULL-first variant", 2026-09-25 adversarial review of
 * PR #1546): `COALESCE(SUM(x), 0)` returns SQL NULL, then falls back to the
 * untyped literal `0`, whenever every row in the FIRST GROUP BY bucket has a
 * NULL quantity/costUsd (e.g. a usage-only group sorting before a
 * fractional-cost group) -- Prisma's $queryRaw type inference then locks
 * that column to BigInt from the first row and throws converting a later
 * group's real fractional value.  Reproduced against real SQLite (see
 * cost-by-session.db.test.ts).  TOTAL() always returns a REAL and never
 * NULL, so there is no COALESCE fallback left for the inference to latch
 * onto.  This function has no try/catch of its own, so before this fix the
 * crash surfaced as a bare 500 from GET /api/cost-by-session.
 */
export async function loadCostBySessionRows(
  ids: string[],
  since: Date,
  until: Date
): Promise<CostBySessionRow[]> {
  if (ids.length === 0) return [];
  const rows = await prisma.$queryRaw<
    Array<{
      sessionId: string | null;
      metricType: string;
      unit: string | null;
      model: string | null;
      label: string | null;
      quantity: unknown;
      costUsd: unknown;
      eventCount: unknown;
      firstOccurredAt: Date | string | number | bigint;
      lastOccurredAt: Date | string | number | bigint;
    }>
  >(Prisma.sql`
    SELECT
      json_extract("metadata", '$."session.id"') AS "sessionId",
      "metricType" AS "metricType",
      "unit" AS "unit",
      "keyRef" AS "model",
      "label" AS "label",
      TOTAL("quantity") AS "quantity",
      TOTAL("costUsd") AS "costUsd",
      COUNT(*) AS "eventCount",
      MIN("occurredAt") AS "firstOccurredAt",
      MAX("occurredAt") AS "lastOccurredAt"
    FROM "ExternalUsageEvent"
    WHERE "sourceApp" = 'claude-code'
      AND "occurredAt" >= ${since}
      AND "occurredAt" <= ${until}
      AND json_extract("metadata", '$."session.id"') IN (${Prisma.join(ids)})
    GROUP BY "sessionId", "metricType", "unit", "keyRef", "label"
  `);
  return rows
    .filter((row): row is typeof row & { sessionId: string } => typeof row.sessionId === "string" && row.sessionId.length > 0)
    .map((row) => ({
      sessionId: row.sessionId,
      metricType: row.metricType,
      unit: row.unit,
      model: row.model,
      label: row.label,
      quantity: Number(row.quantity ?? 0),
      costUsd: Number(row.costUsd ?? 0),
      eventCount: Number(row.eventCount ?? 0),
      firstOccurredAt: coerceOccurredAt(row.firstOccurredAt),
      lastOccurredAt: coerceOccurredAt(row.lastOccurredAt),
    }));
}

/**
 * Pure aggregation from grouped rows to the API response shape. No wall-clock
 * or DB dependency, so this is fully unit-testable without frozen-clock
 * plumbing (see the memory note on wall-clock test rot: this function simply
 * has no clock to freeze).
 */
export function buildCostBySessionReport(
  requestedSessionIds: string[],
  rows: CostBySessionRow[]
): CostBySessionReport {
  const bySession = new Map<
    string,
    {
      eventCount: number;
      tokens: SessionTokenBreakdown;
      costUsd: number;
      models: Set<string>;
      firstSeenAt: Date;
      lastSeenAt: Date;
    }
  >();

  for (const row of rows) {
    let bucket = bySession.get(row.sessionId);
    if (!bucket) {
      bucket = {
        eventCount: 0,
        tokens: emptyTokens(),
        costUsd: 0,
        models: new Set<string>(),
        firstSeenAt: row.firstOccurredAt,
        lastSeenAt: row.lastOccurredAt,
      };
      bySession.set(row.sessionId, bucket);
    }
    bucket.eventCount += row.eventCount;
    if (row.model) bucket.models.add(row.model);
    if (row.firstOccurredAt < bucket.firstSeenAt) bucket.firstSeenAt = row.firstOccurredAt;
    if (row.lastOccurredAt > bucket.lastSeenAt) bucket.lastSeenAt = row.lastOccurredAt;

    if (row.metricType === "usage" && row.unit === "token") {
      addTokens(bucket.tokens, tokenTypeFromLabel(row.label), row.quantity);
    } else if (row.metricType === "cost") {
      bucket.costUsd += row.costUsd;
    }
  }

  const matchedSessionIds = requestedSessionIds.filter((id) => bySession.has(id));
  const unmatchedSessionIds = requestedSessionIds.filter((id) => !bySession.has(id));

  const sessions: SessionCostSummary[] = matchedSessionIds.map((sessionId) => {
    const bucket = bySession.get(sessionId)!;
    return {
      sessionId,
      eventCount: bucket.eventCount,
      tokens: bucket.tokens,
      costUsd: bucket.costUsd,
      models: Array.from(bucket.models).sort(),
      firstSeenAt: bucket.firstSeenAt.toISOString(),
      lastSeenAt: bucket.lastSeenAt.toISOString(),
    };
  });

  const totals = sessions.reduce(
    (acc, session) => {
      acc.eventCount += session.eventCount;
      acc.costUsd += session.costUsd;
      (Object.keys(acc.tokens) as Array<keyof SessionTokenBreakdown>).forEach((key) => {
        acc.tokens[key] += session.tokens[key];
      });
      return acc;
    },
    { eventCount: 0, tokens: emptyTokens(), costUsd: 0 }
  );

  return {
    requestedSessionIds,
    matchedSessionIds,
    unmatchedSessionIds,
    sessions,
    totals,
    billingMode: "estimated",
    costSemantics: "estimated_api_equivalent_not_authoritative",
  };
}
