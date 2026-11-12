"use client";

import { useEffect, useState } from "react";
import CardUnavailableNotice from "@/components/CardUnavailableNotice";

const DATADOG_HOST_CAP = 5;

interface DatadogUsageResponse {
  configured?: boolean;
  site?: string;
  hosts?: number | null;
  containers?: number | null;
  logsIngestedEvents?: number | null;
  apmIngestedSpans?: number | null;
  consoleUrl?: string;
  error?: string;
}

function formatCount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return Math.round(value).toLocaleString("en-US");
}

export default function DatadogUsageCard() {
  const [data, setData] = useState<DatadogUsageResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [reloadCount, setReloadCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/datadog-usage")
      .then((res) => {
        if (!res.ok) throw new Error(`Request failed (${res.status})`);
        return res.json();
      })
      .then((json: DatadogUsageResponse) => {
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
        title="Datadog usage unavailable."
        detail="Estimated host / log / APM counts could not be loaded."
        onRetry={() => setReloadCount((count) => count + 1)}
      />
    );
  }

  if (!data || !data.configured) return null;

  const hostsOver = (data.hosts ?? 0) > DATADOG_HOST_CAP;

  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
      <div className="flex items-center justify-between gap-4 border-b border-gray-100 px-6 py-4 dark:border-gray-700">
        <div>
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">
            Datadog Free Usage
          </h2>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            Estimated hosts, logs, and APM.&nbsp; {data.site}
          </p>
        </div>
        {data.consoleUrl ? (
          <a
            href={data.consoleUrl}
            target="_blank"
            rel="noreferrer"
            className="text-xs font-semibold text-accent underline underline-offset-2"
          >
            Open
          </a>
        ) : null}
      </div>
      <dl className="divide-y divide-gray-100 dark:divide-gray-700">
        <div className="flex items-center justify-between gap-4 px-6 py-3">
          <dt className="text-sm text-gray-900 dark:text-gray-100">Hosts</dt>
          <dd
            className={`text-xs font-medium ${
              hostsOver ? "text-amber-700 dark:text-amber-300" : "text-gray-700 dark:text-gray-300"
            }`}
          >
            {formatCount(data.hosts)} / {DATADOG_HOST_CAP}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-4 px-6 py-3">
          <dt className="text-sm text-gray-900 dark:text-gray-100">Containers</dt>
          <dd className="text-xs font-medium text-gray-700 dark:text-gray-300">
            {formatCount(data.containers)}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-4 px-6 py-3">
          <dt className="text-sm text-gray-900 dark:text-gray-100">Log events (1h)</dt>
          <dd className="text-xs font-medium text-gray-700 dark:text-gray-300">
            {formatCount(data.logsIngestedEvents)}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-4 px-6 py-3">
          <dt className="text-sm text-gray-900 dark:text-gray-100">APM spans (1h)</dt>
          <dd className="text-xs font-medium text-gray-700 dark:text-gray-300">
            {formatCount(data.apmIngestedSpans)}
          </dd>
        </div>
      </dl>
    </div>
  );
}
