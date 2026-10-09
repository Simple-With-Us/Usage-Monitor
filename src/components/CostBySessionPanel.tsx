"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { formatCurrency } from "@/lib/format";

interface SessionTokenBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  unknown: number;
  total: number;
}

interface SessionCostSummary {
  sessionId: string;
  eventCount: number;
  tokens: SessionTokenBreakdown;
  costUsd: number;
  models: string[];
  firstSeenAt: string;
  lastSeenAt: string;
}

interface Report {
  requestedSessionIds: string[];
  matchedSessionIds: string[];
  unmatchedSessionIds: string[];
  sessions: SessionCostSummary[];
  totals: { eventCount: number; tokens: SessionTokenBreakdown; costUsd: number };
  window: {
    since: string;
    until: string;
    requestedSince: string;
    clampedToRawRetention: boolean;
    expiredBeforeRawRetention?: boolean;
    rawRetentionCutoff?: string;
  };
}

const inputClass =
  "w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100";

const money = (amount: number) => formatCurrency(amount);
const tokens = (n: number) => n.toLocaleString("en-US");

function fmtTime(iso: string): string {
  // Central Time display per AGENTS.md / FLEET-UI-COPY.md; UTC follows in
  // parentheses since this page is read by agents debugging across zones.
  const date = new Date(iso);
  const ct = date.toLocaleString("en-US", {
    timeZone: "America/Chicago",
    dateStyle: "medium",
    timeStyle: "short",
  });
  return `${ct} CT (${date.toISOString()})`;
}

/**
 * Reads `?ids=` on mount (so a link from THE BOARD's finding page loads
 * pre-filled), otherwise the seat pastes session ids from `board show <id>`.
 * See src/lib/cost-by-session.ts for the analytics-only cost caveat this
 * panel surfaces verbatim.
 */
export default function CostBySessionPanel() {
  const [idsInput, setIdsInput] = useState("");
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const runQuery = useCallback(async (ids: string) => {
    const trimmed = ids.trim();
    if (!trimmed) return;
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/cost-by-session?ids=${encodeURIComponent(trimmed)}`);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
      setReport(body as Report);
    } catch (caught) {
      setReport(null);
      setError(caught instanceof Error ? caught.message : "Failed to load cost-by-session");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get("ids");
    if (fromUrl) {
      setIdsInput(fromUrl);
      void runQuery(fromUrl);
    }
  }, [runQuery]);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void runQuery(idsInput);
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Cost by Session</h1>
        <p className="mt-2 max-w-3xl text-sm text-gray-600 dark:text-gray-300">
          Sums tokens and API-equivalent cost across one or more Claude Code session ids -- the
          same ids THE BOARD records on a finding via <code>board claim/status/comment --session</code>.
          This is an analytics-only, API-equivalent estimate (Claude Code&apos;s own{" "}
          <code>claude_code.cost.usage</code> metric), never cash and never a budget figure -- it
          answers &quot;was this task worth the model tier&quot;, not &quot;what did we owe&quot;.
        </p>
      </header>

      <form onSubmit={onSubmit} className="space-y-3 rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
        <label htmlFor="session-ids" className="block text-sm font-medium text-gray-700 dark:text-gray-200">
          Session id(s)
        </label>
        <input
          id="session-ids"
          value={idsInput}
          onChange={(event) => setIdsInput(event.target.value)}
          className={inputClass}
          placeholder="d244c761-c933-4a45-a342-b625b0abc7fc, sub-agent-session-id"
        />
        <p className="text-xs text-gray-500 dark:text-gray-400">Comma-separated. Paste from <code>board show &lt;id&gt;</code>&apos;s <code>session_ids</code> line.</p>
        <button disabled={loading} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
          {loading ? "Loading…" : "Look up cost"}
        </button>
      </form>

      {error ? (
        <p role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      ) : null}

      {report ? (
        <>
          <section className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
            <h2 className="font-semibold text-gray-900 dark:text-gray-100">Totals across {report.matchedSessionIds.length} matched session(s)</h2>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <Metric label="Estimated API-equivalent cost" value={money(report.totals.costUsd)} />
              <Metric label="Total tokens" value={tokens(report.totals.tokens.total)} />
              <Metric label="Events" value={tokens(report.totals.eventCount)} />
            </div>
            {report.window.expiredBeforeRawRetention ? (
              <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
                The requested window ({report.window.since} to {report.window.until}) ended before raw event data starts
                ({report.window.rawRetentionCutoff}), so no session in it can be matched any more, even if it had usage.
              </p>
            ) : report.unmatchedSessionIds.length > 0 ? (
              <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
                No claude-code usage found in this window for: {report.unmatchedSessionIds.join(", ")}. That session may not have exported OTLP
                metrics yet (the exporter only runs while the seat has restarted since it was configured), or it falls outside {report.window.since}
                {" "}to {report.window.until}
                {report.window.clampedToRawRetention
                  ? ` (the requested window started ${report.window.requestedSince}, but raw event data only survives back to ${report.window.since} -- older sessions can no longer be matched even though they existed)`
                  : ""}
                .
              </p>
            ) : null}
          </section>

          {report.sessions.length > 0 ? (
            <section className="overflow-x-auto rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
              <table className="w-full text-left border-collapse responsive-table">
                <caption className="sr-only">Cost and token totals per Claude Code session</caption>
                <thead>
                  <tr className="border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900">
                    <th className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Session</th>
                    <th className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Models</th>
                    <th className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Tokens</th>
                    <th className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Est. cost</th>
                    <th className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Events</th>
                    <th className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Span</th>
                  </tr>
                </thead>
                <tbody>
                  {report.sessions.map((session) => (
                    <tr key={session.sessionId} className="border-b border-gray-100 dark:border-gray-700">
                      <td data-label="Session" className="px-4 py-3 font-mono text-xs text-gray-900 dark:text-gray-100">{session.sessionId}</td>
                      <td data-label="Models" className="px-4 py-3 text-sm text-gray-700 dark:text-gray-300">{session.models.join(", ") || "—"}</td>
                      <td data-label="Tokens" className="px-4 py-3 text-sm text-gray-700 dark:text-gray-300">{tokens(session.tokens.total)}</td>
                      <td data-label="Est. cost" className="px-4 py-3 text-sm text-gray-700 dark:text-gray-300">{money(session.costUsd)}</td>
                      <td data-label="Events" className="px-4 py-3 text-sm text-gray-700 dark:text-gray-300">{tokens(session.eventCount)}</td>
                      <td data-label="Span" className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">
                        {fmtTime(session.firstSeenAt)} to {fmtTime(session.lastSeenAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-gray-50 p-3 dark:bg-gray-900">
      <p className="text-xs text-gray-500 dark:text-gray-400">{label}</p>
      <p className="mt-1 text-lg font-semibold text-gray-900 dark:text-gray-100">{value}</p>
    </div>
  );
}
