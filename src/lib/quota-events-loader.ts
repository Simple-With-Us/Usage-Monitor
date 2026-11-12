import { Prisma } from "@prisma/client";
import * as Sentry from "@sentry/nextjs";

import { prisma } from "@/lib/prisma";
import type { QuotaEventLike } from "@/lib/quota-windows";

/**
 * Latest raw quota event per (producer identity, series) inside the lookback
 * window.  Matches `projectQuotaWindows`'s dedupe partition without a flat
 * `take` that evicts low-cadence producers.
 * Equal observations prefer the producer settings revision, then receipt time and row ID.
 * Legacy events without a revision remain receipt ordered.
 */
export async function loadLatestQuotaWindowEvents(since: Date): Promise<QuotaEventLike[]> {
  if (typeof prisma.$queryRaw !== "function") {
    return loadFallback(since);
  }

  try {
    const rows = await prisma.$queryRaw<
      Array<{
        provider: string;
        service: string | null;
        sourceApp: string | null;
        label: string | null;
        credits: number | null;
        limit: number | null;
        occurredAt: Date;
        metadata: unknown;
      }>
    >(Prisma.sql`
      SELECT
        "provider",
        "service",
        "sourceApp",
        "label",
        "credits",
        "limit",
        "occurredAt",
        "metadata"
      FROM (
        SELECT
          "provider",
          "service",
          "sourceApp",
          "label",
          "credits",
          "limit",
          "occurredAt",
          "metadata",
          ROW_NUMBER() OVER (
            PARTITION BY "producerKey", "seriesKey"
            ORDER BY "occurredAt" DESC,
              "planRevision" DESC,
              "createdAt" DESC, "id" DESC
          ) AS "rn"
        FROM (
          SELECT
            "provider",
            "service",
            "sourceApp",
            "label",
            "credits",
            "limit",
            "occurredAt",
            "metadata",
            "createdAt",
            "id",
            -- Bounds-checked revision from the single extraction below: typeof
            -- mirrors json_type for JSON numbers, and NULL/text sorts as 0.
            CASE WHEN typeof("rawPlanRevision") IN ('integer', 'real')
              AND "rawPlanRevision" > 0
              AND "rawPlanRevision" < 1.7976931348623157e308
              THEN "rawPlanRevision" ELSE 0 END AS "planRevision",
            -- Partition identity, mirroring projectQuotaWindows' asString():
            -- only a non-blank string counts, surrounding whitespace is
            -- ignored, and anything else (NULL, "", "  ", a number) falls
            -- through to the next candidate.  The in-memory fallback in
            -- loadFallback computes the same key.
            COALESCE(
              CASE WHEN typeof("rawProducerId") = 'text'
                THEN TRIM("rawProducerId", char(32, 9, 10, 11, 12, 13)) END,
              ''
            ) AS "producerKey",
            COALESCE(
              NULLIF(CASE WHEN typeof("rawModelId") = 'text'
                THEN TRIM("rawModelId", char(32, 9, 10, 11, 12, 13)) END, ''),
              NULLIF(CASE WHEN typeof("rawBucketId") = 'text'
                THEN TRIM("rawBucketId", char(32, 9, 10, 11, 12, 13)) END, ''),
              "provider" || ':' || COALESCE("label", '')
            ) AS "seriesKey"
          FROM (
            SELECT
              "provider",
              "service",
              "sourceApp",
              "label",
              "credits",
              "limit",
              "occurredAt",
              "metadata",
              "createdAt",
              "id",
              -- One metadata JSON parse per extracted key, all in this one
              -- level; the levels above only read these columns.
              json_extract("metadata", '$.planUserUpdatedAt') AS "rawPlanRevision",
              json_extract("metadata", '$._producerInstanceId') AS "rawProducerId",
              json_extract("metadata", '$.modelId') AS "rawModelId",
              json_extract("metadata", '$.bucketId') AS "rawBucketId"
            FROM "ExternalUsageEvent"
            WHERE "metricType" = 'quota'
              AND "occurredAt" >= ${since}
          ) AS "withRawKeys"
        ) AS "withRevision"
      ) AS "ranked"
      WHERE "rn" = 1
    `);
    if (!Array.isArray(rows)) return [];
    return rows;
  } catch (err) {
    console.error(
      "[quota-events-loader] window query failed; falling back to bounded findMany",
      err,
    );
    try {
      Sentry.captureException(err);
    } catch {
      /* Sentry not initialized in this env; never let observability break the fallback */
    }
    return loadFallback(since);
  }
}

/**
 * The whitespace `asString` trims: space, tab, LF, VT, FF, CR.  The window
 * query trims the same set with `TRIM(x, char(32, 9, 10, 11, 12, 13))`.
 */
const SERIES_WHITESPACE = /^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g;

/** Rows per page when the degraded path walks the window. */
const FALLBACK_PAGE_SIZE = 500;

/** `asString` as the window query computes it: a non-blank trimmed string, else null. */
function seriesText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(SERIES_WHITESPACE, "");
  return text === "" ? null : text;
}

type FallbackRow = {
  id: string;
  createdAt: Date;
  provider: string;
  service: string | null;
  sourceApp: string | null;
  label: string | null;
  credits: number | null;
  limit: number | null;
  occurredAt: Date;
  metadata: unknown;
};

function revision(metadata: unknown): number {
  if (!metadata || typeof metadata !== "object") return 0;
  const value = (metadata as Record<string, unknown>).planUserUpdatedAt;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function partitionKey(row: FallbackRow): string {
  const meta = (row.metadata && typeof row.metadata === "object"
    ? row.metadata : {}) as Record<string, unknown>;
  const series =
    seriesText(meta.modelId) ??
    seriesText(meta.bucketId) ??
    `${row.provider}:${row.label ?? ""}`;
  const producer = seriesText(meta._producerInstanceId) ?? "";
  return `${producer}\0${series}`;
}

/** True when `a` beats `b` under the window query's ORDER BY. */
function outranks(a: FallbackRow, b: FallbackRow): boolean {
  return (
    a.occurredAt.getTime() - b.occurredAt.getTime()
    || revision(a.metadata) - revision(b.metadata)
    || a.createdAt.getTime() - b.createdAt.getTime()
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  ) > 0;
}

async function loadFallback(since: Date): Promise<QuotaEventLike[]> {
  // Prisma cannot partition or order by a JSON scalar on SQLite, so the degraded
  // path walks the window in keyset pages and keeps only the best row per
  // partition as it goes.  Memory is bounded by one page plus one row per
  // partition, never by the window, and nothing is dropped before the revision
  // tie-break has seen it: a flat `take` is applied before that tie-break, so it
  // can discard the very event the rule exists to promote (and evict
  // low-cadence producers), making this path disagree with the window query.
  const best = new Map<string, FallbackRow>();
  let cursor: string | undefined;
  for (;;) {
    const page: FallbackRow[] = await prisma.externalUsageEvent.findMany({
      where: { metricType: "quota", occurredAt: { gte: since } },
      orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      take: FALLBACK_PAGE_SIZE,
      ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
      select: {
        id: true, createdAt: true, provider: true, service: true, sourceApp: true,
        label: true, credits: true, limit: true, occurredAt: true, metadata: true,
      },
    });
    for (const row of page) {
      const key = partitionKey(row);
      const current = best.get(key);
      if (current === undefined || outranks(row, current)) best.set(key, row);
    }
    if (page.length < FALLBACK_PAGE_SIZE) break;
    cursor = page[page.length - 1].id;
  }
  return [...best.values()];
}
