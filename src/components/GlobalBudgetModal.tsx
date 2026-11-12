"use client";

import { useEffect, useState } from "react";
import { formatCurrency } from "@/lib/format";

export interface GlobalBudgetModalProps {
  open: boolean;
  onClose: () => void;
  /** Current explicit override (null = using suggestion). */
  globalMonthlyBudgetUsd: number | null;
  suggestedGlobalBudgetUsd: number | null;
  projectBudgetCount: number;
  onSaved: (next: {
    globalMonthlyBudgetUsd: number | null;
    suggestedGlobalBudgetUsd: number | null;
    effectiveGlobalBudgetUsd: number | null;
    globalBudgetSource: "override" | "suggested" | "none";
    projectBudgetCount: number;
  }) => void;
}

export default function GlobalBudgetModal({
  open,
  onClose,
  globalMonthlyBudgetUsd,
  suggestedGlobalBudgetUsd,
  projectBudgetCount,
  onSaved,
}: GlobalBudgetModalProps) {
  const [amount, setAmount] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (globalMonthlyBudgetUsd != null && globalMonthlyBudgetUsd > 0) {
      setAmount(String(globalMonthlyBudgetUsd));
    } else if (suggestedGlobalBudgetUsd != null) {
      setAmount(String(suggestedGlobalBudgetUsd));
    } else {
      setAmount("");
    }
  }, [open, globalMonthlyBudgetUsd, suggestedGlobalBudgetUsd]);

  if (!open) return null;

  async function save(value: number | null) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/global-budget", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ globalMonthlyBudgetUsd: value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || `Save failed (${res.status})`);
      }
      onSaved({
        globalMonthlyBudgetUsd: data.globalMonthlyBudgetUsd ?? null,
        suggestedGlobalBudgetUsd: data.suggestedGlobalBudgetUsd ?? null,
        effectiveGlobalBudgetUsd: data.effectiveGlobalBudgetUsd ?? null,
        globalBudgetSource: data.globalBudgetSource ?? "none",
        projectBudgetCount: data.projectBudgetCount ?? projectBudgetCount,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="global-budget-title"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-5 shadow-xl dark:border-gray-700 dark:bg-gray-900"
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          id="global-budget-title"
          className="text-lg font-semibold text-gray-900 dark:text-gray-100"
        >
          Global Budget
        </h2>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Portfolio monthly spend cap for the Overview meter. Freeform — it may
          differ from the sum of project or provider budgets.
        </p>

        {suggestedGlobalBudgetUsd != null && (
          <p className="mt-3 rounded-lg bg-accent-soft px-3 py-2 text-sm text-gray-800 dark:text-gray-100">
            Suggested from {projectBudgetCount} project budget
            {projectBudgetCount === 1 ? "" : "s"}:{" "}
            <span className="font-semibold tabular-nums">
              {formatCurrency(suggestedGlobalBudgetUsd)}
            </span>
            <button
              type="button"
              className="ml-2 font-medium text-accent underline-offset-2 hover:underline"
              onClick={() => setAmount(String(suggestedGlobalBudgetUsd))}
            >
              Use suggestion
            </button>
          </p>
        )}

        <label className="mt-4 block text-sm font-medium text-gray-700 dark:text-gray-200">
          Monthly amount (USD)
          <input
            type="number"
            min={0}
            step="0.01"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 py-2 text-base tabular-nums focus:outline-none focus:ring-2 focus:ring-accent dark:border-gray-600 dark:bg-gray-950 dark:text-gray-100"
            placeholder="e.g. 2500"
          />
        </label>

        {error && (
          <p className="mt-2 text-sm text-red-600 dark:text-red-400" role="alert">
            {error}
          </p>
        )}

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            className="min-h-11 rounded-lg px-4 text-sm font-medium text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
            onClick={onClose}
            disabled={saving}
          >
            Cancel
          </button>
          <button
            type="button"
            className="min-h-11 rounded-lg px-4 text-sm font-medium text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
            disabled={saving}
            onClick={() => void save(null)}
          >
            Clear override
          </button>
          <button
            type="button"
            className="min-h-11 rounded-lg bg-accent px-4 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            disabled={saving}
            onClick={() => {
              const n = amount.trim() === "" ? null : Number(amount);
              if (n != null && (!Number.isFinite(n) || n < 0)) {
                setError("Enter a non-negative number");
                return;
              }
              void save(n);
            }}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
