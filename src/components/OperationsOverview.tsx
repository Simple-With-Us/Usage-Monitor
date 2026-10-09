"use client";

import { ChevronDown, Cloud, Inbox, RefreshCw, Server } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { FleetBackupStatusPayload } from "@/lib/fleet-backup-status";
import type {
  CongressInfrastructureSummary,
  CoolifyFleetSummary,
  OperationsHealthSummary,
  OperationalState,
  ReceiptInboxSummary,
  SocraticInfrastructureSummary,
} from "@/lib/operations-health";
import type { R2FleetAccountSnapshot, R2FleetSummary } from "@/lib/r2-usage";
import type { ServerMetricsPayload } from "@/lib/server-metrics";
import type { HostPreventionPanel } from "@/lib/server-metrics-indicators";

const REFRESH_INTERVAL_MS = 60_000;

import { MacHealthCard } from "@/components/MacHealthCard";
import SentryHealthCard from "@/components/SentryHealthCard";

export function markOperationsStale(previous: OperationsHealthSummary): OperationsHealthSummary {
  return {
    ...previous,
    receiptInbox: {
      ...previous.receiptInbox,
      state: previous.receiptInbox.configured ? "stale" : previous.receiptInbox.state,
      error: "dashboard_refresh_failed",
    },
    socraticInfrastructure: {
      ...previous.socraticInfrastructure,
      state: "stale",
      error: "dashboard_refresh_failed",
    },
    congressInfrastructure: {
      ...previous.congressInfrastructure,
      state: "stale",
      error: "dashboard_refresh_failed",
    },
    coolifyFleet: {
      ...previous.coolifyFleet,
      state: previous.coolifyFleet.configured ? "stale" : previous.coolifyFleet.state,
      error: "dashboard_refresh_failed",
    },
    // Keep last R2 / fleet backup numbers; null out only if we never had them.
    r2Fleet: previous.r2Fleet,
    fleetBackups: previous.fleetBackups
      ? { ...previous.fleetBackups, ok: false }
      : previous.fleetBackups,
  };
}

function formatUptime(seconds: number | null): string {
  if (seconds === null) return "uptime unknown";
  if (seconds < 60) return `up ${Math.round(seconds)}s`;
  if (seconds < 3600) return `up ${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `up ${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `up ${Math.floor(seconds / 86_400)}d`;
}

function stateLabel(state: OperationalState): string {
  return {
    healthy: "Healthy",
    degraded: "Degraded",
    receiving: "Receiving",
    stale: "Stale",
    unavailable: "Unavailable",
    unreachable: "Unreachable",
    unconfigured: "Not configured",
  }[state];
}

function stateClasses(state: OperationalState): string {
  if (state === "healthy" || state === "receiving") {
    return "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300";
  }
  if (state === "degraded" || state === "stale") {
    return "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300";
  }
  return "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300";
}

function formatBytes(value: number | null): string {
  if (value === null) return "Unavailable";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount.toFixed(unit >= 3 ? 1 : 0)} ${units[unit]}`;
}

function relativeTime(value: string | null): string {
  if (!value) return "never";
  const ageSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000));
  if (ageSeconds < 60) return `${ageSeconds}s ago`;
  if (ageSeconds < 3600) return `${Math.floor(ageSeconds / 60)}m ago`;
  if (ageSeconds < 86_400) return `${Math.floor(ageSeconds / 3600)}h ago`;
  return `${Math.floor(ageSeconds / 86_400)}d ago`;
}

function StatePill({ state }: { state: OperationalState }) {
  return <span className={`rounded-full px-2 py-1 text-xs font-medium ${stateClasses(state)}`}>{stateLabel(state)}</span>;
}

function DisclosureButton({ expanded, onClick, controls, children }: {
  expanded: boolean;
  onClick: () => void;
  controls: string;
  children: ReactNode;
}) {
  return (
    <button type="button" aria-expanded={expanded} aria-controls={controls} onClick={onClick}
      className="flex min-h-11 items-center gap-1 rounded-lg px-2 text-xs font-medium text-blue-600 hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-blue-300 dark:hover:bg-blue-950/30">
      {children}
      <ChevronDown className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-180" : ""}`} />
    </button>
  );
}

function truncateReceiptId(id: string): string {
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

export function ReceiptInboxCard({ data }: { data: ReceiptInboxSummary }) {
  const [expanded, setExpanded] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [formNotice, setFormNotice] = useState<string | null>(null);
  const count = `${data.countIsLowerBound ? "at least " : ""}${data.needsReviewCount}`;

  async function ignoreReceipt(id: string) {
    setBusyId(id);
    setFormError(null);
    try {
      const response = await fetch(`/api/receipt-inbox/${id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "ignored" }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Could not ignore this receipt");
      }
      setFormNotice("Receipt marked ignored.");
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Could not ignore this receipt");
    } finally {
      setBusyId(null);
    }
  }

  async function recordExpense(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setFormNotice(null);
    const form = new FormData(event.currentTarget);
    const amount = Number(form.get("amountUsd"));
    const occurred = String(form.get("occurredOn") ?? "");
    const occurredAt = occurred
      ? new Date(`${occurred}T12:00:00.000Z`).toISOString()
      : new Date().toISOString();
    const payload = {
      provider: String(form.get("provider") ?? "").trim(),
      amountUsd: amount,
      occurredAt,
      kind: String(form.get("kind") ?? "one_time"),
      label: String(form.get("label") ?? "").trim(),
      notes: String(form.get("notes") ?? "").trim() || undefined,
      receiptInboxId: String(form.get("receiptInboxId") ?? "").trim() || undefined,
      confidence: "actual",
    };
    try {
      const response = await fetch("/api/owner-expenses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        throw new Error(body?.error ?? "Could not record this expense");
      }
      setFormNotice("Expense recorded on the ledger.");
      event.currentTarget.reset();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Could not record this expense");
    }
  }

  return (
    <section aria-labelledby="receipt-inbox-heading" className="rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
      <div className="flex items-start justify-between gap-4 px-5 py-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="rounded-lg bg-blue-50 p-2 text-blue-600 dark:bg-blue-950/40 dark:text-blue-300" aria-hidden="true"><Inbox className="h-4 w-4" /></span>
          <div className="min-w-0">
            <h3 id="receipt-inbox-heading" className="text-sm font-semibold text-gray-900 dark:text-gray-100">Receipt Inbox</h3>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {data.configured ? <>{count} need review · last receipt <time suppressHydrationWarning dateTime={data.latestReceivedAt ?? undefined}>{relativeTime(data.latestReceivedAt)}</time></> : "Forwarded receipts are not connected yet"}
            </p>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Review a forwarded receipt, then record the expense if it is real cash
              that is not already on the ledger.  Upcoming dues also land on the
              Bills calendar at <code>/api/bills.ics</code>.  If it{" "}
              <strong className="font-medium text-gray-600 dark:text-gray-300">matches existing cash</strong>{" "}
              (subscription or prepaid already in the system), keep it as evidence and do{" "}
              <strong className="font-medium text-gray-600 dark:text-gray-300">not double-count</strong> spend.
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <StatePill state={data.state} />
          <DisclosureButton expanded={expanded} onClick={() => setExpanded((value) => !value)} controls="receipt-inbox-detail">Review</DisclosureButton>
        </div>
      </div>
      {expanded && (
        <div id="receipt-inbox-detail" className="border-t border-gray-100 px-5 py-3 dark:border-gray-700">
          {data.items.length > 0 ? (
            <ul className="divide-y divide-gray-100 dark:divide-gray-700">
              {data.items.map((item) => (
                <li key={item.id} className="flex flex-col gap-2 py-2 text-xs sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-gray-800 dark:text-gray-200">
                      {item.subject || item.senderDomain}
                    </p>
                    <p className="text-gray-500 dark:text-gray-400">
                      {item.amountUsd != null ? `$${item.amountUsd.toFixed(2)}` : "amount unknown"}
                      {item.kind ? ` · ${item.kind}` : ""}
                      {item.service ? ` · ${item.service}` : ""}
                      {" · "}
                      {truncateReceiptId(item.id)}
                      {" · "}
                      {item.quarantineReason.replaceAll("_", " ")}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <time suppressHydrationWarning dateTime={item.receivedAt} title={item.receivedAt} className="text-gray-500 dark:text-gray-400">{relativeTime(item.receivedAt)}</time>
                    {data.evidenceActionsConfigured && (
                      <>
                        <a
                          className="rounded border border-gray-300 px-2 py-1 font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200"
                          href={`/api/receipt-inbox/${item.id}/evidence`}
                        >
                          Download
                        </a>
                        <button
                          type="button"
                          className="rounded border border-gray-300 px-2 py-1 font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200"
                          disabled={busyId === item.id}
                          onClick={() => void ignoreReceipt(item.id)}
                        >
                          Ignore
                        </button>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-gray-500 dark:text-gray-400">No inbox items waiting.  You can still record an expense from a Gmail or iCloud receipt.</p>
          )}
          <form className="mt-4 grid gap-2 sm:grid-cols-2" onSubmit={(event) => void recordExpense(event)}>
            <label className="text-xs text-gray-600 dark:text-gray-300">
              Provider
              <input required name="provider" className="mt-1 w-full rounded border border-gray-300 px-2 py-1 dark:border-gray-600 dark:bg-gray-900" placeholder="anthropic" />
            </label>
            <label className="text-xs text-gray-600 dark:text-gray-300">
              Amount USD
              <input required name="amountUsd" type="number" step="0.01" className="mt-1 w-full rounded border border-gray-300 px-2 py-1 dark:border-gray-600 dark:bg-gray-900" />
            </label>
            <label className="text-xs text-gray-600 dark:text-gray-300">
              Date
              <input name="occurredOn" type="date" className="mt-1 w-full rounded border border-gray-300 px-2 py-1 dark:border-gray-600 dark:bg-gray-900" />
            </label>
            <label className="text-xs text-gray-600 dark:text-gray-300">
              Kind
              <select name="kind" className="mt-1 w-full rounded border border-gray-300 px-2 py-1 dark:border-gray-600 dark:bg-gray-900" defaultValue="subscription">
                <option value="subscription">subscription</option>
                <option value="usage">usage</option>
                <option value="prepaid">prepaid</option>
                <option value="one_time">one-time / dev expense</option>
              </select>
            </label>
            <label className="text-xs text-gray-600 dark:text-gray-300 sm:col-span-2">
              Label
              <input required name="label" className="mt-1 w-full rounded border border-gray-300 px-2 py-1 dark:border-gray-600 dark:bg-gray-900" placeholder="Claude Pro July receipt" />
            </label>
            <label className="text-xs text-gray-600 dark:text-gray-300 sm:col-span-2">
              Inbox Id
              <input name="receiptInboxId" className="mt-1 w-full rounded border border-gray-300 px-2 py-1 dark:border-gray-600 dark:bg-gray-900" placeholder="optional 64-hex inbox id" />
            </label>
            <label className="text-xs text-gray-600 dark:text-gray-300 sm:col-span-2">
              Notes
              <input name="notes" className="mt-1 w-full rounded border border-gray-300 px-2 py-1 dark:border-gray-600 dark:bg-gray-900" placeholder="optional" />
            </label>
            <div className="sm:col-span-2">
              <button type="submit" className="rounded bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white dark:bg-gray-100 dark:text-gray-900">
                Record Expense
              </button>
            </div>
          </form>
          {formNotice && <p className="mt-2 text-xs text-emerald-700 dark:text-emerald-300">{formNotice}</p>}
          {formError && <p className="mt-2 text-xs text-red-700 dark:text-red-300">{formError}</p>}
          {!data.evidenceActionsConfigured && (
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
              Download and ignore need RECEIPT_INBOX_EVIDENCE_TOKEN on the server.  Recording an expense works from the form above.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function formatGiB(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return "—";
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

function formatOps(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString("en-US");
}

function MeterBar({ pct, warn }: { pct: number; warn: boolean }) {
  const width = Math.min(Math.max(pct, 0), 100);
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700">
      <div
        className={`h-full rounded-full ${warn ? "bg-amber-500" : "bg-emerald-500"}`}
        style={{ width: `${width}%` }}
        role="presentation"
      />
    </div>
  );
}

function fleetAccountStatusLine(
  account: R2FleetAccountSnapshot,
  thresholdPct: number
): string {
  if (account.autoDisabled) {
    return `DISABLED (auto-kill at ${thresholdPct}% threshold)`;
  }
  if (account.metricsSource === "unavailable") {
    return "METRICS UNAVAILABLE";
  }
  if (account.overallOnTrackToExceed70Pct) {
    return `WARNING (pace/MTD ≥ ${thresholdPct}%)`;
  }
  return `OK (under ${thresholdPct}% free-tier pace)`;
}

function FleetAccountBlock({
  account,
  thresholdPct,
  freeTier,
}: {
  account: R2FleetAccountSnapshot;
  thresholdPct: number;
  freeTier: R2FleetSummary["freeTier"];
}) {
  if (!account.configured) {
    return (
      <div className="rounded-lg border border-dashed border-gray-200 px-3 py-2 dark:border-gray-600">
        <p className="text-xs font-semibold text-gray-800 dark:text-gray-200">{account.label}</p>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Not configured — set{" "}
          <span className="font-mono">
            CLOUDFLARE_{account.id === "um" ? "JAY" : account.id.toUpperCase()}_ACCOUNT_ID
          </span>{" "}
          + analytics token.
        </p>
      </div>
    );
  }
  if (account.status === "error") {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50/50 px-3 py-2 dark:border-amber-900 dark:bg-amber-950/20">
        <p className="text-xs font-semibold text-gray-800 dark:text-gray-200">{account.label}</p>
        <p className="mt-1 text-xs text-amber-800 dark:text-amber-200">
          {account.error ?? "Metrics unavailable"}
        </p>
      </div>
    );
  }
  if (account.metricsSource === "r2_not_enabled") {
    return (
      <div className="rounded-lg border border-gray-200 px-3 py-2 dark:border-gray-700">
        <p className="text-xs font-semibold text-gray-800 dark:text-gray-200">{account.label}</p>
        {account.accountIdSuffix ? (
          <p className="font-mono text-[10px] text-gray-500 dark:text-gray-400">
            …{account.accountIdSuffix}
          </p>
        ) : null}
        <p className="mt-1.5 text-[11px] text-gray-600 dark:text-gray-300">
          R2 is not enabled on this account.{"  "}GraphQL leftovers are ignored.
        </p>
      </div>
    );
  }
  const metrics = [
    {
      key: "storage",
      label: account.gbMonthBytes != null ? "Storage (GB-month)" : "Storage",
      m: account.storage,
      fmt: formatGiB,
      limitLabel: formatGiB(freeTier.storageBytes),
      showPace: false,
    },
    {
      key: "classA",
      label: "Class A ops",
      m: account.classA,
      fmt: formatOps,
      limitLabel: formatOps(freeTier.classAOps),
      showPace: true,
    },
    {
      key: "classB",
      label: "Class B ops",
      m: account.classB,
      fmt: formatOps,
      limitLabel: formatOps(freeTier.classBOps),
      showPace: true,
    },
  ];
  const statusLine = fleetAccountStatusLine(account, thresholdPct);
  return (
    <div className="rounded-lg border border-gray-200 px-3 py-2 dark:border-gray-700">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-gray-800 dark:text-gray-200">{account.label}</p>
          {account.accountIdSuffix ? (
            <p className="font-mono text-[10px] text-gray-500 dark:text-gray-400">
              …{account.accountIdSuffix}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {account.autoDisabled ? (
            <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
              R2 writes paused
            </span>
          ) : null}
          {account.overallOnTrackToExceed70Pct ? (
            <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
              ≥{thresholdPct}% risk
            </span>
          ) : (
            <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
              OK
            </span>
          )}
        </div>
      </div>
      <p
        className={`mt-1.5 text-[11px] ${
          account.overallOnTrackToExceed70Pct || account.autoDisabled
            ? "font-medium text-amber-800 dark:text-amber-200"
            : "text-gray-600 dark:text-gray-300"
        }`}
      >
        Status: {statusLine}
      </p>
      <div className="mt-2 space-y-2">
        {metrics.map(({ key, label, m, fmt, limitLabel, showPace }) => {
          if (!m) return null;
          return (
            <div key={key}>
              <div className="mb-0.5 flex items-center justify-between gap-2 text-[11px]">
                <span className="text-gray-500 dark:text-gray-400">{label}</span>
                <span
                  className={
                    m.onTrackToExceed
                      ? "text-right font-medium text-amber-700 dark:text-amber-300"
                      : "text-right text-gray-700 dark:text-gray-200"
                  }
                >
                  {fmt(m.actual)} / {limitLabel} ({m.mtdPct.toFixed(0)}% MTD
                  {showPace ? `, ${m.projectedPct.toFixed(0)}% proj` : ""})
                </span>
              </div>
              <MeterBar pct={m.mtdPct} warn={m.onTrackToExceed} />
            </div>
          );
        })}
      </div>
      {account.currentBytes != null || account.monthPeakBytes != null ? (
        <p className="mt-1 text-[10px] text-gray-500 dark:text-gray-400">
          {account.currentBytes != null
            ? `now ${formatGiB(account.currentBytes)}`
            : null}
          {account.monthPeakBytes != null
            ? `${account.currentBytes != null ? " · " : ""}month peak ${formatGiB(account.monthPeakBytes)}${
                account.monthPeakDate ? ` ${account.monthPeakDate}` : ""
              }`
            : null}
          {account.previousWeekGbMonthBytes != null
            ? ` · last 7d ${formatGiB(account.previousWeekGbMonthBytes)}`
            : null}
        </p>
      ) : null}
      <p className="mt-2 text-[10px] text-gray-500 dark:text-gray-400">
        Threshold {thresholdPct}% · Source {account.metricsSource}
        {account.litestreamUsesR2 != null
          ? ` · Litestream→R2: ${account.litestreamUsesR2 ? "yes" : "no"}`
          : ""}
      </p>
      {account.buckets.length > 0 && (
        <ul className="mt-2 space-y-0.5 border-t border-gray-100 pt-2 text-[11px] text-gray-500 dark:border-gray-700 dark:text-gray-400">
          <li className="text-[10px] font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
            Top buckets
          </li>
          {account.buckets
            .slice()
            .sort((a, b) => b.bytes - a.bytes)
            .slice(0, 4)
            .map((b) => (
              <li key={b.bucketName} className="flex justify-between gap-2">
                <span className="truncate font-mono">{b.bucketName}</span>
                <span className="shrink-0">{formatGiB(b.bytes)}</span>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}

export function R2FleetCard({ data }: { data: R2FleetSummary | null }) {
  if (!data) {
    return (
      <section aria-labelledby="r2-fleet-heading" className="rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
        <div className="flex items-start gap-3 px-5 py-4">
          <span className="rounded-lg bg-sky-50 p-2 text-sky-600 dark:bg-sky-950/40 dark:text-sky-300" aria-hidden="true">
            <Cloud className="h-4 w-4" />
          </span>
          <div>
            <h3 id="r2-fleet-heading" className="text-sm font-semibold text-gray-900 dark:text-gray-100">R2 Free Tier (Fleet)</h3>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Could not load R2 metrics for Usage Monitor / Socratic / Congress.</p>
          </div>
        </div>
      </section>
    );
  }
  const state: OperationalState = !data.configured
    ? "unconfigured"
    : data.anyOnTrackToExceed || data.localBackup.autoDisabled
      ? "degraded"
      : "healthy";
  return (
    <section aria-labelledby="r2-fleet-heading" className="rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800 lg:col-span-2">
      <div className="flex items-start justify-between gap-4 px-5 py-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="rounded-lg bg-sky-50 p-2 text-sky-600 dark:bg-sky-950/40 dark:text-sky-300" aria-hidden="true">
            <Cloud className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h3 id="r2-fleet-heading" className="text-sm font-semibold text-gray-900 dark:text-gray-100">R2 Free Tier (Fleet)</h3>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Three Cloudflare accounts · 10 GiB / 1M Class A / 10M Class B each · alert at {data.thresholdPct}%
              {data.localBackup.autoDisabled ? " · this host paused Litestream writes" : ""}
            </p>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Checked <time suppressHydrationWarning dateTime={data.fetchedAt}>{relativeTime(data.fetchedAt)}</time>
              {" · "}Off-site backup is DR-only (hourly sync); app readiness does not depend on it.
            </p>
          </div>
        </div>
        <StatePill state={state} />
      </div>
      <div className="grid gap-3 border-t border-gray-100 px-5 py-4 sm:grid-cols-3 dark:border-gray-700">
        {data.accounts.map((account) => (
          <FleetAccountBlock
            key={account.id}
            account={account}
            thresholdPct={data.thresholdPct}
            freeTier={data.freeTier}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * Runtime & services detail row: embed provider (if the ST health payload
 * reported one) plus OpenRouter credit state.  Returns null — render
 * nothing — when neither has data, rather than fabricating a status line.
 *
 * Pinecone was dropped from this card (retired per owner 2026-09-04) and
 * there is no live Qdrant/vector-store health field in this payload to take
 * its place — qdrant-st's real status is Coolify-resource data and already
 * surfaces on the Coolify Fleet card, not duplicated here.
 */
export function socraticVectorStoreLine(
  data: Pick<SocraticInfrastructureSummary, "ragEmbedProvider" | "openrouterCreditsOk">
): string | null {
  const parts = [
    data.ragEmbedProvider ? `Embed ${data.ragEmbedProvider}` : null,
    data.openrouterCreditsOk === null
      ? null
      : data.openrouterCreditsOk
        ? "OpenRouter credits ok"
        : "OpenRouter credits low",
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function SocraticInfrastructureCard({ data }: { data: SocraticInfrastructureSummary }) {
  const [expanded, setExpanded] = useState(false);
  const scheduler = data.schedulerAgeSeconds === null ? "scheduler unavailable" : `scheduler ${Math.round(data.schedulerAgeSeconds)}s ago`;
  const uptime = formatUptime(data.processUptimeSeconds);
  const depTotal = data.dependencyCount ?? data.failedDependencies.length;
  const vectorStoreLine = socraticVectorStoreLine(data);
  return (
    <section aria-labelledby="socratic-infrastructure-heading" className="rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
      <div className="flex items-start justify-between gap-4 px-5 py-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="rounded-lg bg-violet-50 p-2 text-violet-600 dark:bg-violet-950/40 dark:text-violet-300" aria-hidden="true"><Server className="h-4 w-4" /></span>
          <div className="min-w-0">
            <h3 id="socratic-infrastructure-heading" className="text-sm font-semibold text-gray-900 dark:text-gray-100">Socratic Trade Infrastructure</h3>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Database {data.database} · {scheduler} · {uptime}
              {data.recentRestart ? " · recent restart" : ""}
            </p>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {data.failedDependencies.length} dependency issue{data.failedDependencies.length === 1 ? "" : "s"}
              {depTotal != null ? ` of ${depTotal}` : ""}
              {data.tradingLivenessDegraded ? " · trading liveness degraded" : ""}
              {data.dataProvidersDegraded ? " · data providers degraded" : ""}
            </p>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Last checked <time suppressHydrationWarning dateTime={data.fetchedAt} title={data.fetchedAt}>{relativeTime(data.fetchedAt)}</time>{data.releaseSha ? ` · ${data.releaseSha.slice(0, 8)}` : ""}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <StatePill state={data.state} />
          <DisclosureButton expanded={expanded} onClick={() => setExpanded((value) => !value)} controls="socratic-infrastructure-detail">Details</DisclosureButton>
        </div>
      </div>
      {expanded && (
        <div id="socratic-infrastructure-detail" className="grid gap-3 border-t border-gray-100 px-5 py-4 text-xs sm:grid-cols-2 dark:border-gray-700">
          <div>
            <p className="font-medium text-gray-800 dark:text-gray-200">Storage &amp; backup</p>
            <p className="mt-1 text-gray-500 dark:text-gray-400">DB {formatBytes(data.dbSizeBytes)} · WAL {formatBytes(data.walSizeBytes)}</p>
            <p className="mt-1 text-gray-500 dark:text-gray-400">Free {formatBytes(data.freeBytes)} · Litestream {data.litestreamState ?? "Unavailable"}{data.storageDegraded ? " (degraded)" : ""}</p>
          </div>
          <div>
            <p className="font-medium text-gray-800 dark:text-gray-200">Runtime &amp; services</p>
            <p className="mt-1 text-gray-500 dark:text-gray-400">
              {uptime}
              {data.processStartedAt ? ` · started ${relativeTime(data.processStartedAt)}` : ""}
              {data.recentRestart ? " · crash/restart window" : ""}
            </p>
            <p className="mt-1 text-gray-500 dark:text-gray-400">
              {data.activeTradingAccounts ?? "Unavailable"} active account{data.activeTradingAccounts === 1 ? "" : "s"} · {data.degradedTradingAccounts ?? "Unavailable"} degraded
              {data.marketOpen === true ? " · market open" : data.marketOpen === false ? " · market closed" : ""}
            </p>
            <p className="mt-1 text-gray-500 dark:text-gray-400">
              Dependencies: {data.failedDependencies.length > 0 ? data.failedDependencies.join(", ") : "none failed"}
              {data.dependencyCount != null ? ` (${data.dependencyCount} total)` : ""}
            </p>
            {vectorStoreLine && (
              <p className="mt-1 text-gray-500 dark:text-gray-400">{vectorStoreLine}</p>
            )}
            <a href={data.adminUrl} target="_blank" rel="noreferrer" className="mt-2 inline-flex min-h-11 items-center font-medium text-blue-600 hover:underline dark:text-blue-300">Open full Socratic admin panel</a>
          </div>
        </div>
      )}
    </section>
  );
}

export function CongressInfrastructureCard({ data }: { data: CongressInfrastructureSummary }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <section aria-labelledby="congress-infrastructure-heading" className="rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
      <div className="flex items-start justify-between gap-4 px-5 py-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="rounded-lg bg-sky-50 p-2 text-sky-600 dark:bg-sky-950/40 dark:text-sky-300" aria-hidden="true"><Server className="h-4 w-4" /></span>
          <div className="min-w-0">
            <h3 id="congress-infrastructure-heading" className="text-sm font-semibold text-gray-900 dark:text-gray-100">Congress.Trade Liveness</h3>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Database {data.database}
              {data.schemaOk === true ? " · schema ok" : data.schemaOk === false ? " · schema missing" : ""}
              {data.pipelineStatus ? ` · pipeline ${data.pipelineStatus}` : ""}
            </p>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {data.failedChecks.length} required check issue{data.failedChecks.length === 1 ? "" : "s"}
              {" · last-resort lanes excluded"}
            </p>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Last checked <time suppressHydrationWarning dateTime={data.fetchedAt} title={data.fetchedAt}>{relativeTime(data.fetchedAt)}</time>{data.releaseSha ? ` · ${data.releaseSha.slice(0, 8)}` : ""}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <StatePill state={data.state} />
          <DisclosureButton expanded={expanded} onClick={() => setExpanded((value) => !value)} controls="congress-infrastructure-detail">Details</DisclosureButton>
        </div>
      </div>
      {expanded && (
        <div id="congress-infrastructure-detail" className="grid gap-3 border-t border-gray-100 px-5 py-4 text-xs sm:grid-cols-2 dark:border-gray-700">
          <div>
            <p className="font-medium text-gray-800 dark:text-gray-200">Liveness</p>
            <p className="mt-1 text-gray-500 dark:text-gray-400">
              {data.ok === true ? "Process answered ok" : data.ok === false ? "Readiness failed" : "Unreachable"}
            </p>
            <p className="mt-1 text-gray-500 dark:text-gray-400">
              Pipeline {data.pipelineStatus ?? "unknown"} (does not paint this card)
            </p>
          </div>
          <div>
            <p className="font-medium text-gray-800 dark:text-gray-200">Required checks</p>
            <p className="mt-1 text-gray-500 dark:text-gray-400">
              {data.failedChecks.length > 0 ? data.failedChecks.join(", ") : "none failed"}
            </p>
            <a href={data.adminUrl} target="_blank" rel="noreferrer" className="mt-2 inline-flex min-h-11 items-center font-medium text-blue-600 hover:underline dark:text-blue-300">Open Congress.Trade health</a>
          </div>
        </div>
      )}
    </section>
  );
}

function fleetBackupAgeLabel(ageSeconds: number | null | undefined): string {
  if (ageSeconds == null || !Number.isFinite(ageSeconds)) return "age unknown";
  if (ageSeconds < 60) return `${Math.round(ageSeconds)}s ago`;
  if (ageSeconds < 3600) return `${Math.floor(ageSeconds / 60)}m ago`;
  if (ageSeconds < 86_400) return `${Math.floor(ageSeconds / 3600)}h ago`;
  return `${Math.floor(ageSeconds / 86_400)}d ago`;
}

export function FleetBackupsCard({ data }: { data: FleetBackupStatusPayload | null }) {
  const [expanded, setExpanded] = useState(false);
  if (!data) {
    return (
      <section aria-labelledby="fleet-backups-heading" className="rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
        <div className="px-5 py-4">
          <h3 id="fleet-backups-heading" className="text-sm font-semibold text-gray-900 dark:text-gray-100">Fleet Backups</h3>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Backup status could not be loaded.</p>
        </div>
      </section>
    );
  }
  const state: OperationalState = !data.configured
    ? "unconfigured"
    : data.ok
      ? "healthy"
      : "degraded";
  const okApps = data.apps.filter((a) => a.ok).length;
  return (
    <section aria-labelledby="fleet-backups-heading" className="rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
      <div className="flex items-start justify-between gap-4 px-5 py-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="rounded-lg bg-sky-50 p-2 text-sky-600 dark:bg-sky-950/40 dark:text-sky-300" aria-hidden="true">
            <Cloud className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h3 id="fleet-backups-heading" className="text-sm font-semibold text-gray-900 dark:text-gray-100">Fleet Backups</h3>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {data.configured
                ? `${okApps} of ${data.apps.length} apps OK · B2 dumps + Litestream per location`
                : "Backblaze monitor key not configured"}
            </p>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Checked <time suppressHydrationWarning dateTime={data.asOf}>{relativeTime(data.asOf)}</time>
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <StatePill state={state} />
          <DisclosureButton expanded={expanded} onClick={() => setExpanded((v) => !v)} controls="fleet-backups-detail">
            Details
          </DisclosureButton>
        </div>
      </div>
      {expanded && (
        <div id="fleet-backups-detail" className="space-y-4 border-t border-gray-100 px-5 py-4 text-xs dark:border-gray-700">
          {data.apps.map((app) => (
            <div key={app.id}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-medium text-gray-800 dark:text-gray-200">
                  {app.label}
                  {app.self ? (
                    <span className="ml-1 font-normal text-gray-400">· this app</span>
                  ) : null}
                </p>
                <StatePill state={app.ok ? "healthy" : "degraded"} />
              </div>
              <ul className="mt-2 space-y-1.5">
                {app.locations.map((loc) => (
                  <li key={`${app.id}-${loc.id}`} className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-gray-700 dark:text-gray-300">{loc.label}</span>
                    <span className="text-gray-500 dark:text-gray-400">
                      {loc.ok === true
                        ? "OK"
                        : loc.ok === false
                          ? loc.present
                            ? "Lagging"
                            : "Missing"
                          : loc.reason === "not_configured" || loc.reason === "b2_unconfigured"
                            ? "N/A"
                            : "Unknown"}
                      {loc.latestAgeSeconds != null
                        ? ` · ${fleetBackupAgeLabel(loc.latestAgeSeconds)}`
                        : ""}
                      {loc.fileCount != null && loc.fileCount > 0
                        ? ` · ${loc.fileCount} object${loc.fileCount === 1 ? "" : "s"}`
                        : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {data.warnings.length > 0 ? (
            <p className="text-amber-700 dark:text-amber-300">{data.warnings.join(" · ")}</p>
          ) : null}
          <p className="text-gray-500 dark:text-gray-400">
            Locations are independent.{"\u00a0"} A fresh B2 full dump keeps disaster recovery alive even when continuous Litestream is lagging.
          </p>
        </div>
      )}
    </section>
  );
}

function preventionState(overall: string | undefined | null): OperationalState {
  if (overall === "critical") return "degraded";
  if (overall === "warning") return "degraded";
  if (overall === "ok") return "healthy";
  return "unavailable";
}

function MiniSparkline({ values, label }: { values: number[]; label: string }) {
  if (values.length < 2) return null;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = Math.max(max - min, 1);
  const w = 120;
  const h = 28;
  const pts = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * w;
      const y = h - ((v - min) / span) * (h - 2) - 1;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      role="img"
      aria-label={label}
      className="text-sky-600 dark:text-sky-300"
    >
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        points={pts}
      />
    </svg>
  );
}

export function HostStatsCard({ data }: { data: ServerMetricsPayload | null }) {
  const [expanded, setExpanded] = useState(false);
  if (!data) {
    return (
      <section
        aria-labelledby="host-stats-heading"
        className="rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800"
      >
        <div className="px-5 py-4">
          <h3
            id="host-stats-heading"
            className="text-sm font-semibold text-gray-900 dark:text-gray-100"
          >
            Host Stats
          </h3>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Sign in to load Hetzner CPU, disk, app, and backup risk indicators.
          </p>
        </div>
      </section>
    );
  }

  const prevention: HostPreventionPanel | null = data.prevention;
  const state = preventionState(prevention?.overall);
  const cpuTrail =
    prevention?.history
      .map((h) => h.cpuPct)
      .filter((v): v is number => typeof v === "number") ?? [];
  const summary = prevention?.summary;
  const headline = prevention
    ? prevention.overall === "ok"
      ? `CPU ${summary?.cpuLatestPct != null ? `${Math.round(summary.cpuLatestPct)}%` : "—"} · disk ${summary?.diskUsedPct != null ? `${summary.diskUsedPct}%` : "—"} · ${summary?.appsDown ?? 0} apps down`
      : `${prevention.indicators.length} active indicator${prevention.indicators.length === 1 ? "" : "s"}`
    : "Prevention panel unavailable";

  return (
    <section
      aria-labelledby="host-stats-heading"
      className="rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800 lg:col-span-2"
    >
      <div className="flex items-start justify-between gap-4 px-5 py-4">
        <div className="flex min-w-0 items-start gap-3">
          <span
            className="rounded-lg bg-emerald-50 p-2 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-300"
            aria-hidden="true"
          >
            <Server className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h3
              id="host-stats-heading"
              className="text-sm font-semibold text-gray-900 dark:text-gray-100"
            >
              Host Stats
            </h3>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {data.host.name ?? "Hetzner host"}
              {data.host.serverType ? ` · ${data.host.serverType}` : ""}
              {data.host.cpus != null ? ` · ${data.host.cpus} vCPU` : ""}
            </p>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {headline}
            </p>
            {cpuTrail.length >= 2 ? (
              <div className="mt-2">
                <MiniSparkline values={cpuTrail} label="CPU history sparkline" />
              </div>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <StatePill state={state} />
          <DisclosureButton
            expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
            controls="host-stats-detail"
          >
            Details
          </DisclosureButton>
        </div>
      </div>
      {expanded && prevention ? (
        <div
          id="host-stats-detail"
          className="space-y-4 border-t border-gray-100 px-5 py-4 text-xs dark:border-gray-700"
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <p className="font-medium text-gray-800 dark:text-gray-200">CPU (1h)</p>
              <p className="mt-1 text-gray-500 dark:text-gray-400">
                Peak{" "}
                {summary?.cpuPeakPct != null
                  ? `${Math.round(summary.cpuPeakPct)}%`
                  : "—"}{" "}
                · avg{" "}
                {summary?.cpuAvgPct != null
                  ? `${Math.round(summary.cpuAvgPct)}%`
                  : "—"}{" "}
                · now{" "}
                {summary?.cpuLatestPct != null
                  ? `${Math.round(summary.cpuLatestPct)}%`
                  : "—"}
              </p>
            </div>
            <div>
              <p className="font-medium text-gray-800 dark:text-gray-200">Disk</p>
              <p className="mt-1 text-gray-500 dark:text-gray-400">
                {summary?.diskUsedPct != null
                  ? `${summary.diskUsedPct}% used`
                  : "—"}
                {summary?.diskFreeBytes != null
                  ? ` · free ${formatBytes(summary.diskFreeBytes)}`
                  : ""}
              </p>
            </div>
            <div>
              <p className="font-medium text-gray-800 dark:text-gray-200">Apps &amp; backups</p>
              <p className="mt-1 text-gray-500 dark:text-gray-400">
                {summary?.appsHealthy ?? 0}/{summary?.appsTotal ?? 0} healthy
                {summary?.appsDown
                  ? ` · ${summary.appsDown} down`
                  : ""}
                {summary?.backupAppsOk != null && summary.backupAppsTotal != null
                  ? ` · backups ${summary.backupAppsOk}/${summary.backupAppsTotal}`
                  : ""}
              </p>
            </div>
          </div>

          {prevention.indicators.length > 0 ? (
            <div>
              <p className="font-medium text-gray-800 dark:text-gray-200">
                Active Indicators
              </p>
              <ul className="mt-2 space-y-2">
                {prevention.indicators.map((ind) => (
                  <li key={ind.id} className="rounded-lg bg-gray-50 px-3 py-2 dark:bg-gray-900/40">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="font-medium text-gray-800 dark:text-gray-200">
                        {ind.label}
                        {ind.subject ? (
                          <span className="ml-1 font-normal text-gray-400">
                            · {ind.subject}
                          </span>
                        ) : null}
                      </span>
                      <span
                        className={
                          ind.severity === "critical"
                            ? "text-red-600 dark:text-red-300"
                            : ind.severity === "warning"
                              ? "text-amber-700 dark:text-amber-300"
                              : "text-gray-500"
                        }
                      >
                        {ind.severity}
                      </span>
                    </div>
                    <p className="mt-1 text-gray-500 dark:text-gray-400">
                      {ind.detail}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-gray-500 dark:text-gray-400">
              No active risk indicators.{"\u00a0"} Host CPU, disk, apps, and backups look within thresholds.
            </p>
          )}

          {prevention.history.length > 0 ? (
            <div>
              <p className="font-medium text-gray-800 dark:text-gray-200">
                Recent Poll History
              </p>
              <p className="mt-1 text-gray-500 dark:text-gray-400">
                {prevention.historyNote}
              </p>
              <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto">
                {[...prevention.history].reverse().slice(0, 16).map((sample) => (
                  <li
                    key={sample.at}
                    className="flex flex-wrap items-baseline justify-between gap-2 font-mono text-[11px] text-gray-500 dark:text-gray-400"
                  >
                    <span>{sample.at}</span>
                    <span>
                      cpu{" "}
                      {sample.cpuPct != null
                        ? `${Math.round(sample.cpuPct)}%`
                        : "—"}
                      {sample.diskUsedPct != null
                        ? ` · disk ${sample.diskUsedPct}%`
                        : ""}
                      {sample.appsDown > 0
                        ? ` · ${sample.appsDown} down`
                        : ""}
                      {sample.indicatorIds.length > 0
                        ? ` · ${sample.indicatorIds.length} flags`
                        : ""}
                      {` · ${sample.overall}`}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export function CoolifyFleetCard({ data }: { data: CoolifyFleetSummary }) {
  const [expanded, setExpanded] = useState(false);
  const summary =
    !data.configured
      ? "Coolify host token not configured"
      : `${data.appsUp} up · ${data.appsDown} down · ${data.appsDegraded} degraded` +
        (data.appsUnknown > 0 ? ` · ${data.appsUnknown} unknown` : "");
  const rows = data.resources.length > 0 ? data.resources : data.applications;
  return (
    <section aria-labelledby="coolify-fleet-heading" className="rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
      <div className="flex items-start justify-between gap-4 px-5 py-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="rounded-lg bg-sky-50 p-2 text-sky-600 dark:bg-sky-950/40 dark:text-sky-300" aria-hidden="true"><Cloud className="h-4 w-4" /></span>
          <div className="min-w-0">
            <h3 id="coolify-fleet-heading" className="text-sm font-semibold text-gray-900 dark:text-gray-100">Coolify Fleet</h3>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{summary}</p>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Last checked <time suppressHydrationWarning dateTime={data.fetchedAt} title={data.fetchedAt}>{relativeTime(data.fetchedAt)}</time>
              {data.host ? ` · ${data.host.replace(/^https?:\/\//, "")}` : ""}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <StatePill state={data.state} />
          <DisclosureButton expanded={expanded} onClick={() => setExpanded((value) => !value)} controls="coolify-fleet-detail">Details</DisclosureButton>
        </div>
      </div>
      {expanded && (
        <div id="coolify-fleet-detail" className="border-t border-gray-100 px-5 py-4 text-xs dark:border-gray-700">
          {rows.length === 0 ? (
            <p className="text-gray-500 dark:text-gray-400">
              {data.error ? `Could not load services: ${data.error}` : "No applications or resources reported."}
            </p>
          ) : (
            <ul className="space-y-2">
              {rows.map((row, index) => {
                const label = row.name ?? row.fqdn ?? `resource-${index + 1}`;
                const status = row.status ?? (row.up === true ? "running" : row.up === false ? "down" : "unknown");
                return (
                  <li key={`${label}-${index}`} className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-medium text-gray-800 dark:text-gray-200">
                      {label}
                      {row.type ? <span className="ml-1 font-normal text-gray-400">({row.type})</span> : null}
                    </span>
                    <span className="text-gray-500 dark:text-gray-400">
                      {status}
                      {row.degraded ? " · degraded" : ""}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="mt-3 text-gray-500 dark:text-gray-400">
            Live CPU/memory still comes from Coolify Sentinel (not this API). Application status is from Coolify REST.
          </p>
        </div>
      )}
    </section>
  );
}

export default function OperationsOverview() {
  const [data, setData] = useState<OperationsHealthSummary | null>(null);
  const [hostMetrics, setHostMetrics] = useState<ServerMetricsPayload | null>(
    null
  );
  const [refreshing, setRefreshing] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);

  const refresh = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      const [opsResponse, metricsResponse] = await Promise.all([
        fetch("/api/operations", { cache: "no-store" }),
        fetch("/api/server-metrics", { cache: "no-store" }),
      ]);
      if (!opsResponse.ok) throw new Error(`HTTP ${opsResponse.status}`);
      setData((await opsResponse.json()) as OperationsHealthSummary);
      if (metricsResponse.ok) {
        setHostMetrics(
          (await metricsResponse.json()) as ServerMetricsPayload
        );
      } else {
        // 401 without session is fine; keep last metrics if any.
        if (metricsResponse.status !== 401) {
          setHostMetrics(null);
        }
      }
      setRequestError(null);
    } catch {
      setRequestError("Operations status could not be refreshed.");
      setData((previous) => (previous ? markOperationsStale(previous) : null));
    } finally {
      if (manual) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, REFRESH_INTERVAL_MS);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh]);

  return (
    <section aria-labelledby="operations-heading" className="space-y-3">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2
            id="operations-heading"
            className="text-sm font-semibold text-gray-800 dark:text-gray-200"
          >
            Operations
          </h2>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            Receipt intake, host risk indicators, and service health — kept
            separate from provider costs.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh(true)}
          disabled={refreshing}
          className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-gray-200 px-3 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`}
            aria-hidden="true"
          />{" "}
          Refresh
        </button>
      </div>
      <div aria-live="polite" className="sr-only">
        {requestError ??
          (data ? "Operations status refreshed." : "Loading operations status.")}
      </div>
      {requestError && (
        <p className="rounded-xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          {requestError}
          {data ? " Last confirmed data is marked stale." : ""}
        </p>
      )}
      {data ? (
        <div className="grid gap-3 lg:grid-cols-2">
          <MacHealthCard />
          <HostStatsCard data={hostMetrics} />
          <SentryHealthCard />
          <R2FleetCard data={data.r2Fleet} />
          <FleetBackupsCard data={data.fleetBackups} />
          <ReceiptInboxCard data={data.receiptInbox} />
          <SocraticInfrastructureCard data={data.socraticInfrastructure} />
          <CongressInfrastructureCard data={data.congressInfrastructure} />
          <CoolifyFleetCard data={data.coolifyFleet} />
        </div>
      ) : !requestError ? (
        <div className="grid gap-3 lg:grid-cols-2" aria-hidden="true">
          <div className="h-40 animate-pulse rounded-xl border border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800 lg:col-span-2" />
          <div className="h-28 animate-pulse rounded-xl border border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800" />
          <div className="h-28 animate-pulse rounded-xl border border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800" />
          <div className="h-28 animate-pulse rounded-xl border border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800" />
        </div>
      ) : null}
    </section>
  );
}
