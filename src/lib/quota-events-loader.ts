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
            PARTITION BY
              COALESCE(json_extract("metadata", '$._producerInstanceId'), ''),
              COALESCE(
                json_extract("metadata", '$.modelId'),
                json_extract("metadata", '$.bucketId'),
                "provider" || ':' || COALESCE("label", '')
              )
            ORDER BY "occurredAt" DESC,
              CASE WHEN json_type("metadata", '$.planUserUpdatedAt') IN ('integer', 'real')
                AND json_extract("metadata", '$.planUserUpdatedAt') > 0
                AND json_extract("metadata", '$.planUserUpdatedAt') < 1.7976931348623157e308
                THEN json_extract("metadata", '$.planUserUpdatedAt') ELSE 0 END DESC,
              "createdAt" DESC, "id" DESC
          ) AS "rn"
        FROM "ExternalUsageEvent"
        WHERE "metricType" = 'quota'
          AND "occurredAt" >= ${since}
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

async function loadFallback(since: Date): Promise<QuotaEventLike[]> {
  const rows = await prisma.externalUsageEvent.findMany({
    where: { metricType: "quota", occurredAt: { gte: since } },
    orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    take: 400,
    select: {
      id: true, createdAt: true, provider: true, service: true, sourceApp: true,
      label: true, credits: true, limit: true, occurredAt: true, metadata: true,
    },
  });
  function revision(metadata: unknown): number {
    if (!metadata || typeof metadata !== "object") return 0;
    const value = (metadata as Record<string, unknown>).planUserUpdatedAt;
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
  }
  // Prisma cannot order by a JSON scalar on SQLite; sort the bounded fallback in memory.
  return rows.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime()
    || revision(b.metadata) - revision(a.metadata)
    || b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
}
