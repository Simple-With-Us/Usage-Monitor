"use client";

import { formatCurrency } from "@/lib/format";

export interface ProjectedRenewalRow {
  subscriptionId: string;
  providerId: string;
  name: string;
  chargeUsd: number;
  chargeAt: string;
  autoRenew: boolean;
  providerDisplayName?: string;
}

export interface ProjectedCostBreakdownModalProps {
  open: boolean;
  onClose: () => void;
  totalProjectedUsd: number;
  fixedAccruedUsd: number;
  projectedVariableUsd: number;
  knownRenewalsUsd: number;
  renewals: ProjectedRenewalRow[];
  mtdMonthLabel: string;
}

function formatChargeDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });
  } catch {
    return iso;
  }
}

export default function ProjectedCostBreakdownModal({
  open,
  onClose,
  totalProjectedUsd,
  fixedAccruedUsd,
  projectedVariableUsd,
  knownRenewalsUsd,
  renewals,
  mtdMonthLabel,
}: ProjectedCostBreakdownModalProps) {
  if (!open) return null;

  const sorted = [...renewals].sort(
    (a, b) => new Date(a.chargeAt).getTime() - new Date(b.chargeAt).getTime()
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="projected-breakdown-title"
      onClick={onClose}
    >
      <div
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-gray-200 bg-white p-5 shadow-xl dark:border-gray-700 dark:bg-gray-900"
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          id="projected-breakdown-title"
          className="text-lg font-semibold text-gray-900 dark:text-gray-100"
        >
          Projected costs · {mtdMonthLabel}
        </h2>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          End-of-month estimate: extrapolated variable usage plus fixed charges
          already accrued and known remaining bills this UTC month.
        </p>

        <p className="mt-4 text-2xl font-bold tabular-nums text-gray-900 dark:text-gray-100">
          {formatCurrency(totalProjectedUsd)}
        </p>

        <ul className="mt-4 space-y-2 text-sm">
          <li className="flex justify-between gap-3 border-b border-gray-100 py-2 dark:border-gray-800">
            <span className="text-gray-600 dark:text-gray-300">
              Variable usage (extrapolated)
            </span>
            <span className="font-medium tabular-nums text-gray-900 dark:text-gray-100">
              {formatCurrency(projectedVariableUsd)}
            </span>
          </li>
          <li className="flex justify-between gap-3 border-b border-gray-100 py-2 dark:border-gray-800">
            <span className="text-gray-600 dark:text-gray-300">
              Fixed accrued MTD
            </span>
            <span className="font-medium tabular-nums text-gray-900 dark:text-gray-100">
              {formatCurrency(fixedAccruedUsd)}
            </span>
          </li>
          <li className="flex justify-between gap-3 border-b border-gray-100 py-2 dark:border-gray-800">
            <span className="text-gray-600 dark:text-gray-300">
              Known renewals remaining
            </span>
            <span className="font-medium tabular-nums text-gray-900 dark:text-gray-100">
              {formatCurrency(knownRenewalsUsd)}
            </span>
          </li>
        </ul>

        <h3 className="mt-5 text-sm font-semibold text-gray-900 dark:text-gray-100">
          Scheduled Charges This Month
        </h3>
        {sorted.length === 0 ? (
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
            No remaining subscription renewals with a known date this month.
            Add or enable Subscriptions (auto-renew or next bill date) so Grok,
            ROIC, etc. show here before they hit the card.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-gray-100 dark:divide-gray-800">
            {sorted.map((row) => (
              <li
                key={`${row.subscriptionId}-${row.chargeAt}`}
                className="flex flex-wrap items-baseline justify-between gap-2 py-2.5 text-sm"
              >
                <div className="min-w-0">
                  <p className="font-medium text-gray-900 dark:text-gray-100">
                    {row.name}
                  </p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {row.providerDisplayName ?? "Provider"} ·{" "}
                    {formatChargeDate(row.chargeAt)} UTC
                    {row.autoRenew ? "" : " · one-term"}
                  </p>
                </div>
                <span className="tabular-nums font-semibold text-gray-900 dark:text-gray-100">
                  {formatCurrency(row.chargeUsd)}
                </span>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-5 flex justify-end">
          <button
            type="button"
            className="min-h-11 rounded-lg bg-accent px-4 text-sm font-medium text-white hover:opacity-90"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
