/**
 * Dashboard Sentry Usage companion: latest polled snapshot, not a live
 * Sentry billing call.  Health stays on SentryHealthCard.  Prepaid
 * balance / invoice fields are never invented.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { canonicalProviderKey } from "@/lib/provider-identity";
import {
  parseSentryCategoriesFromRawData,
  type SentryCategoryTotal,
} from "@/lib/sentry-usage-categories";

export interface SentryUsageSnapshot {
  configured: true;
  providerId: string;
  fetchedAt: string;
  period: { scope?: string; start?: string; end?: string } | null;
  byCategory: SentryCategoryTotal[];
  billingCost: false;
  balance: null;
  totalCost: null;
  credits: null;
}

export interface SentryUsageUnconfigured {
  configured: false;
}

export type SentryUsageResult = SentryUsageSnapshot | SentryUsageUnconfigured;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPeriod(
  rawData: unknown
): SentryUsageSnapshot["period"] {
  if (!isRecord(rawData) || !isRecord(rawData.period)) return null;
  const scope =
    typeof rawData.period.scope === "string" ? rawData.period.scope : undefined;
  const start =
    typeof rawData.period.start === "string" ? rawData.period.start : undefined;
  const end =
    typeof rawData.period.end === "string" ? rawData.period.end : undefined;
  if (!scope && !start && !end) return null;
  return { scope, start, end };
}

export async function fetchSentryUsage(): Promise<SentryUsageResult> {
  const providers = await prisma.provider.findMany({
    where: { type: "builtin" },
    select: { id: true, name: true },
  });
  const sentry = providers.find(
    (provider) => canonicalProviderKey(provider.name) === "sentry"
  );
  if (!sentry) return { configured: false };

  const snapshot = await prisma.usageSnapshot.findFirst({
    where: {
      providerId: sentry.id,
      rawData: { not: Prisma.DbNull },
    },
    orderBy: { fetchedAt: "desc" },
    select: { rawData: true, fetchedAt: true },
  });
  if (!snapshot) return { configured: false };

  const categories = parseSentryCategoriesFromRawData(snapshot.rawData);
  if (!categories) return { configured: false };

  return {
    configured: true,
    providerId: sentry.id,
    fetchedAt: snapshot.fetchedAt.toISOString(),
    period: readPeriod(snapshot.rawData),
    byCategory: categories.byCategory,
    billingCost: false,
    balance: null,
    totalCost: null,
    credits: null,
  };
}
