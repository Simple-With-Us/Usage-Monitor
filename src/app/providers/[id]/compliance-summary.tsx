"use client";

import { AlertTriangle, CheckCircle2, HelpCircle, Loader2 } from "lucide-react";

/**
 * Per-provider compliance badge + detail (DESIGN §3f).
 *
 * Kept in its own module rather than inline in `page.tsx` because Next.js
 * route-type generation rejects extra named exports from a page file — the
 * same reason `cost-coverage-caveat.tsx` is a sibling module.
 *
 * Display-only: every number here is read back from the audit layer, never
 * recomputed, and none of it feeds budgets or alerts.
 */

export type ComplianceState =
  | "verified"
  | "discrepancy"
  | "partial"
  | "pending"
  | "unverifiable";

export interface ProviderComplianceSummaryView {
  state: ComplianceState;
  verifiedCoverage: number | null;
  verifiableEventCount: number;
  verifiedEventCount: number;
  matchedEventCount: number;
  discrepancyEventCount: number;
  pendingEventCount: number;
  unverifiableEventCount: number;
  periodDeltaUsd: number | null;
  periodReportedCostUsd: number | null;
  periodVerifiedCostUsd: number | null;
  periodStatus: string | null;
  unverifiableReason: string | null;
  checkedAt: string | null;
}

function formatUsd(value: number): string {
  const abs = Math.abs(value);
  // Sub-cent LLM costs are routine here; don't round them away to "$0.00".
  const digits = abs > 0 && abs < 0.01 ? 6 : 2;
  return `${value < 0 ? "-" : ""}$${abs.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

function formatPercent(ratio: number): string {
  // FLOOR, never round: 99,600/100,000 must not render as "100%". A reassuring
  // rounded 100% over incomplete verification is precisely the silent-OK this
  // panel exists to prevent, so 100% is reserved for genuinely complete
  // coverage.
  if (ratio >= 1) return "100%";
  const floored = Math.floor(ratio * 1000) / 10;
  return `${floored % 1 === 0 ? floored.toFixed(0) : floored.toFixed(1)}%`;
}

const STATE_PRESENTATION: Record<
  ComplianceState,
  { label: string; className: string; Icon: typeof CheckCircle2 }
> = {
  verified: {
    label: "Verified",
    className:
      "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-300",
    Icon: CheckCircle2,
  },
  discrepancy: {
    label: "Discrepancy",
    className:
      "border-orange-300 bg-orange-50 text-orange-700 dark:border-orange-500/40 dark:bg-orange-500/10 dark:text-orange-300",
    Icon: AlertTriangle,
  },
  partial: {
    label: "Partially verified",
    className:
      "border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-500/40 dark:bg-sky-500/10 dark:text-sky-300",
    Icon: Loader2,
  },
  pending: {
    label: "Verification pending",
    className:
      "border-gray-300 bg-gray-50 text-gray-600 dark:border-gray-600 dark:bg-gray-700/40 dark:text-gray-300",
    Icon: Loader2,
  },
  unverifiable: {
    label: "Unverifiable",
    className:
      "border-gray-300 bg-gray-50 text-gray-500 dark:border-gray-600 dark:bg-gray-700/40 dark:text-gray-400",
    Icon: HelpCircle,
  },
};

export function ComplianceBadge({ state }: { state: ComplianceState }) {
  const { label, className, Icon } = STATE_PRESENTATION[state];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${className}`}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {label}
    </span>
  );
}

export function ComplianceSummaryPanel({
  compliance,
}: {
  compliance: ProviderComplianceSummaryView | null;
}) {
  if (!compliance) return null;

  const {
    state,
    verifiedCoverage,
    verifiedEventCount,
    matchedEventCount,
    discrepancyEventCount,
    pendingEventCount,
    unverifiableEventCount,
    periodDeltaUsd,
    periodReportedCostUsd,
    periodVerifiedCostUsd,
    unverifiableReason,
    checkedAt,
  } = compliance;

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">
          Usage Compliance
        </h2>
        <ComplianceBadge state={state} />
      </div>

      {unverifiableReason ? (
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">{unverifiableReason}</p>
      ) : null}

      <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-xs text-gray-500 dark:text-gray-400">Verified coverage</dt>
          <dd className="text-sm tabular-nums text-gray-900 dark:text-gray-100">
            {verifiedCoverage == null ? (
              <span className="text-gray-500 dark:text-gray-400">n/a</span>
            ) : (
              <>
                {formatPercent(verifiedCoverage)}{" "}
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  ({verifiedEventCount} verified
                  {pendingEventCount > 0 ? `, ${pendingEventCount} pending` : ""}
                  {unverifiableEventCount > 0
                    ? `, ${unverifiableEventCount} failed`
                    : ""}
                  )
                </span>
              </>
            )}
          </dd>
        </div>

        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-xs text-gray-500 dark:text-gray-400">Calls matching provider</dt>
          <dd className="text-sm tabular-nums text-gray-900 dark:text-gray-100">
            {matchedEventCount}
            {discrepancyEventCount > 0 ? (
              <span className="ml-1 text-orange-600 dark:text-orange-300">
                / {discrepancyEventCount} disagreeing
              </span>
            ) : null}
          </dd>
        </div>

        {periodReportedCostUsd != null ? (
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-xs text-gray-500 dark:text-gray-400">Self-reported this period</dt>
            <dd className="text-sm tabular-nums text-gray-900 dark:text-gray-100">
              {formatUsd(periodReportedCostUsd)}
            </dd>
          </div>
        ) : null}

        {periodVerifiedCostUsd != null ? (
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-xs text-gray-500 dark:text-gray-400">Provider-verified</dt>
            <dd className="text-sm tabular-nums text-gray-900 dark:text-gray-100">
              {formatUsd(periodVerifiedCostUsd)}
            </dd>
          </div>
        ) : null}

        {periodDeltaUsd != null ? (
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-xs text-gray-500 dark:text-gray-400">Difference</dt>
            <dd
              className={`text-sm tabular-nums ${
                Math.abs(periodDeltaUsd) > 0.01
                  ? "text-orange-600 dark:text-orange-300"
                  : "text-gray-900 dark:text-gray-100"
              }`}
            >
              {formatUsd(periodDeltaUsd)}
            </dd>
          </div>
        ) : null}

        {unverifiableEventCount > 0 ? (
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-xs text-gray-500 dark:text-gray-400">Verification failed</dt>
            <dd className="text-sm tabular-nums text-gray-500 dark:text-gray-400">
              {unverifiableEventCount}
            </dd>
          </div>
        ) : null}
      </dl>

      {checkedAt ? (
        <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
          Last reconciled {new Date(checkedAt).toLocaleString()}
        </p>
      ) : null}
    </section>
  );
}
