"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  getFleetAlerts,
  worstFiringSeverity,
  type FleetAlertsPayload,
  type FleetAlertSeverity,
} from "@/lib/fleet-alerts";

/**
 * Fleet Alerts card for `/ops`.
 *
 * Renders the shared alert ingress rather than re-deriving health per vendor,
 * so this page and the Zulip `#alerts` channel show the same current truth.
 * Degrades to "Not Configured" rather than an error card: an ops page must
 * never hard-fail because an alert surface is down.
 */
export default function FleetAlertsCard() {
  const [data, setData] = useState<FleetAlertsPayload | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/fleet-alerts", { cache: "no-store" });
      if (res.ok) setData(await res.json());
      else
        setData({
          configured: true,
          generatedAt: null,
          ok: false,
          summary: { topics: 0, alerts: 0, firing: 0 },
          topics: {},
          reason: `HTTP ${res.status}`,
        });
    } catch {
      setData({
        configured: true,
        generatedAt: null,
        ok: false,
        summary: { topics: 0, alerts: 0, firing: 0 },
        topics: {},
        reason: "unreachable",
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // Match the rest of the ops page's cadence.
    const id = setInterval(() => void load(), 30_000);
    return () => clearInterval(id);
  }, [load]);

  if (loading && !data) {
    return (
      <div className="rounded-xl border border-border bg-card p-5 shadow-sm animate-pulse">
        <div className="h-6 w-32 bg-muted rounded mb-4" />
        <div className="h-4 w-56 bg-muted rounded" />
      </div>
    );
  }

  if (!data || !data.configured) {
    return (
      <Shell
        title="Fleet Alerts"
        dot="bg-gray-400"
        headline="Not Configured"
        detail="Set FLEET_ALERTS_URL to the alert ingress to see fleet alert state here."
      />
    );
  }

  if (!data.ok) {
    return (
      <Shell
        title="Fleet Alerts"
        dot="bg-amber-500"
        headline="Unreachable"
        detail={`Alert ingress did not answer${data.reason ? ` (${data.reason})` : ""}. Zulip #alerts is unaffected.`}
      />
    );
  }

  const { firing } = data.summary;

  if (firing === 0) {
    return (
      <Shell
        title="Fleet Alerts"
        dot="bg-emerald-500"
        headline="All Clear"
        detail={`${data.summary.alerts} signal${data.summary.alerts === 1 ? "" : "s"} across ${data.summary.topics} topic${data.summary.topics === 1 ? "" : "s"}. Nothing firing.`}
        onRefresh={load}
      />
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <Header
        dot={dotFor(worstFiringSeverity(data))}
        headline={`${firing} Firing`}
        detail={`${data.summary.alerts} signals across ${data.summary.topics} topics`}
        onRefresh={load}
      />
      <ul className="mt-4 space-y-4">
        {Object.entries(data.topics).map(([topic, t]) => (
          <li key={topic}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm font-medium text-foreground">{topic}</span>
              <span className="text-xs text-muted-foreground">
                {t.firing === 0 ? "All clear" : `${t.firing} firing`}
              </span>
            </div>
            <ul className="mt-2 space-y-1.5">
              {t.alerts.map((a) => (
                <li key={a.key} className="flex items-start gap-2 text-sm">
                  <span
                    aria-hidden
                    className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dotFor(
                      a.phase === "alerting" ? a.severity : "INFO",
                      a.phase
                    )}`}
                  />
                  <span className="min-w-0 flex-1">
                    <span
                      className={
                        a.phase === "alerting"
                          ? "font-medium text-foreground"
                          : "text-muted-foreground"
                      }
                    >
                      {a.text || a.service}
                    </span>
                    {a.link && (
                      <>
                        {" "}
                        <a
                          href={a.link}
                          target="_blank"
                          rel="noreferrer"
                          className="text-blue-600 hover:underline dark:text-blue-300"
                        >
                          Source
                        </a>
                      </>
                    )}
                    {a.prodDown && a.phase === "alerting" && (
                      <span className="ml-2 text-xs text-red-600 dark:text-red-400">
                        Production
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Shell({
  title,
  dot,
  headline,
  detail,
  onRefresh,
}: {
  title: string;
  dot: string;
  headline: string;
  detail: string;
  onRefresh?: () => void;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <Header dot={dot} headline={headline} detail={detail} onRefresh={onRefresh} />
    </div>
  );
}

function Header({
  dot,
  headline,
  detail,
  onRefresh,
}: {
  dot: string;
  headline: string;
  detail: string;
  onRefresh?: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <h3 className="text-sm font-semibold text-foreground">Fleet Alerts</h3>
        <div className="mt-2 flex items-center gap-2">
          <span className={`h-2.5 w-2.5 rounded-full ${dot}`} />
          <span className="text-sm font-medium text-foreground">{headline}</span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
      </div>
      {onRefresh && (
        <button
          type="button"
          onClick={() => void onRefresh()}
          aria-label="Refresh Fleet Alerts"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-muted"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

function dotFor(severity: FleetAlertSeverity, phase?: string): string {
  if (phase === "pending") return "bg-amber-400";
  if (severity === "SEVERE") return "bg-red-500";
  if (severity === "MODERATE") return "bg-amber-500";
  return "bg-emerald-500";
}

// Re-exported so the page can prefetch without importing the whole card.
export { getFleetAlerts };