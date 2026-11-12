"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import CardUnavailableNotice from "@/components/CardUnavailableNotice";
import { formatNumber } from "@/lib/format";
import type { SentryCategoryTotal } from "@/lib/sentry-usage-categories";

const SENTENCE_GAP = "\u00a0 ";

interface SentryUsageResponse {
  configured?: boolean;
  providerId?: string;
  fetchedAt?: string;
  period?: { scope?: string; start?: string; end?: string } | null;
  byCategory?: SentryCategoryTotal[];
  billingCost?: false;
  balance?: null;
  totalCost?: null;
  credits?: null;
  error?: string;
}

function formatUnit(unit: SentryCategoryTotal["unit"]): string {
  if (unit === "bytes") return "bytes";
  if (unit === "milliseconds") return "ms";
  return "events";
}

export function SentryUsageTable({
  rows,
}: {
  rows: SentryCategoryTotal[];
}) {
  if (rows.length === 0) {
    return (
      <p className="px-6 py-4 text-sm text-gray-500 dark:text-gray-400">
        No category totals yet.{SENTENCE_GAP}The next Sentry poll will record accepted and rate-limited counts.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">Sentry Usage by Category</caption>
        <thead>
          <tr className="border-b border-gray-100 bg-gray-50 text-left text-xs font-medium text-gray-500 dark:border-gray-700 dark:bg-gray-900/60 dark:text-gray-400">
            <th className="px-6 py-2">Category</th>
            <th className="px-3 py-2 text-right">Accepted</th>
            <th className="px-3 py-2 text-right">Rate Limited</th>
            <th className="px-6 py-2 text-right">Unit</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={`${row.category}-${row.unit}`}
              className="border-b border-gray-50 dark:border-gray-700"
            >
              <td className="px-6 py-2 font-medium text-gray-900 dark:text-gray-100">
                {row.label}
              </td>
              <td className="px-3 py-2 text-right text-gray-700 dark:text-gray-300">
                {formatNumber(row.accepted, { maximumFractionDigits: 0 })}
              </td>
              <td className="px-3 py-2 text-right text-gray-700 dark:text-gray-300">
                {formatNumber(row.rateLimited, { maximumFractionDigits: 0 })}
              </td>
              <td className="px-6 py-2 text-right text-xs text-gray-500 dark:text-gray-400">
                {formatUnit(row.unit)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function SentryUsageCard() {
  const [data, setData] = useState<SentryUsageResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [reloadCount, setReloadCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/sentry-usage")
      .then((res) => {
        if (!res.ok) throw new Error(`Request failed (${res.status})`);
        return res.json();
      })
      .then((json: SentryUsageResponse) => {
        if (cancelled) return;
        setData(json);
        setFailed(false);
      })
      .catch(() => {
        if (cancelled) return;
        setData(null);
        setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadCount]);

  if (failed) {
    return (
      <CardUnavailableNotice
        title="Sentry usage unavailable."
        detail="Category totals could not be loaded from the latest poll."
        onRetry={() => setReloadCount((count) => count + 1)}
      />
    );
  }

  if (!data || !data.configured) return null;

  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-gray-100 px-6 py-4 dark:border-gray-700">
        <div>
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">
            Sentry Usage
          </h2>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            Month-to-date accepted and rate-limited counts.{SENTENCE_GAP}Not invoice spend or prepaid credits.
          </p>
        </div>
        {data.providerId ? (
          <Link
            href={`/providers/${encodeURIComponent(data.providerId)}`}
            className="text-xs font-semibold text-accent underline underline-offset-2"
          >
            Open Sentry
          </Link>
        ) : null}
      </div>
      <SentryUsageTable rows={data.byCategory ?? []} />
    </div>
  );
}
