import { Prisma } from "@prisma/client";
import * as Sentry from "@sentry/nextjs";

import { prisma } from "@/lib/prisma";
import type { QuotaEventLike } from "@/lib/quota-windows";

/**
 * Latest raw quota event per (producer identity, series) inside the lookback
 * window.  Matches `projectQuotaWindows`'s dedupe partition without a flat
 * `take` that evicts low-cadence producers.
 */
export async function loadLatestQuotaWindowEvents(since: Date): Promise<QuotaEventLike[]> {
  if (typeof prisma.$queryRaw !== "function") {
    return prisma.externalUsageEvent.findMany({
      where: { metricType: "quota", occurredAt: { gte: since } },
      orderBy: { occurredAt: "desc" },
      take: 400,
      select: {
        provider: true,
        service: true,
        label: true,
        credits: true,
        limit: true,
        occurredAt: true,
        metadata: true,
      },
    });
  }

  try {
    const rows = await prisma.$queryRaw<
      Array<{
        provider: string;
        service: string | null;
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
        "label",
        "credits",
        "limit",
        "occurredAt",
        "metadata"
      FROM (
        SELECT
          "provider",
          "service",
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
            ORDER BY "occurredAt" DESC
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
    return prisma.externalUsageEvent.findMany({
      where: { metricType: "quota", occurredAt: { gte: since } },
      orderBy: { occurredAt: "desc" },
      take: 400,
      select: {
        provider: true,
        service: true,
        label: true,
        credits: true,
        limit: true,
        occurredAt: true,
        metadata: true,
      },
    });
  }
}
