"use client";

import { ChevronDown, Pencil, RefreshCw, Search, Trash2 } from "lucide-react";
import { Fragment, useCallback, useEffect, useState, type FormEvent } from "react";
import {
  DeleteOwnerExpensesResponseSchema,
  EditOwnerExpenseResponseSchema,
  OwnerExpenseAuditListSchema,
  OwnerExpenseErrorSchema,
  PostedExpensesResponseSchema,
  type OwnerExpenseAuditEntry,
  type PostedExpense,
} from "@/lib/owner-expense-quarantine-schema";

const PAGE_LIMIT = 200;
const KINDS = ["one_time", "subscription", "prepaid", "usage"] as const;

function formatMoney(value: number | null): string {
  if (value === null) return "$—";
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

function formatDay(iso: string): string {
  return iso.slice(0, 10);
}

function shortKey(key: string): string {
  return `${key.slice(0, 26)}…${key.slice(-6)}`;
}

function categoryClasses(category: PostedExpense["category"]): string {
  if (category === "Tech") {
    return "bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300";
  }
  if (category === "Other") {
    return "bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300";
  }
  return "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300";
}

interface Filters {
  q: string;
  category: string;
  sort: string;
  order: "asc" | "desc";
  from: string;
  to: string;
}

const EMPTY_FILTERS: Filters = {
  q: "",
  category: "",
  sort: "occurredAt",
  order: "desc",
  from: "",
  to: "",
};

function buildQuery(filters: Filters, cursor: string | null): string {
  const params = new URLSearchParams({
    limit: String(PAGE_LIMIT),
    totals: "1",
    sort: filters.sort,
    order: filters.order,
  });
  if (filters.q.trim()) params.set("q", filters.q.trim());
  if (filters.category) params.set("category", filters.category);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (cursor) params.set("cursor", cursor);
  return params.toString();
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = OwnerExpenseErrorSchema.safeParse(json);
    throw new Error(failure.success ? failure.data.error : `Request failed (${response.status})`);
  }
  return json;
}

export default function PostedExpensesCard() {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [expenses, setExpenses] = useState<PostedExpense[] | null>(null);
  const [totals, setTotals] = useState<{ count: number; totalUsd: number; Tech: number; Other: number; uncategorized: number } | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmingBulk, setConfirmingBulk] = useState(false);
  const [confirmingKey, setConfirmingKey] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<OwnerExpenseAuditEntry[] | null>(null);

  const load = useCallback(
    async (next: Filters, cursor: string | null, append: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const json = await fetchJson(`/api/owner-expenses?${buildQuery(next, cursor)}`);
        const parsed = PostedExpensesResponseSchema.safeParse(json);
        if (!parsed.success) throw new Error("Could not read the expenses response");
        setExpenses((previous) =>
          append && previous ? [...previous, ...parsed.data.expenses] : parsed.data.expenses
        );
        setNextCursor(parsed.data.hasMore ? parsed.data.nextCursor : null);
        if (parsed.data.totals) {
          setTotals({
            count: parsed.data.totals.count,
            totalUsd: parsed.data.totals.totalUsd,
            Tech: parsed.data.totals.byCategory.Tech,
            Other: parsed.data.totals.byCategory.Other,
            uncategorized: parsed.data.totals.byCategory.uncategorized,
          });
        }
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "Could not load expenses");
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    void load(EMPTY_FILTERS, null, false);
  }, [load]);

  const loadHistory = useCallback(async () => {
    try {
      const json = await fetchJson("/api/owner-expenses/audit?limit=100");
      const parsed = OwnerExpenseAuditListSchema.safeParse(json);
      if (parsed.success) setHistory(parsed.data.entries);
    } catch {
      // History is advisory; a failed fetch must not break the card.
    }
  }, []);

  useEffect(() => {
    if (historyOpen) void loadHistory();
  }, [historyOpen, loadHistory]);

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSelected(new Set());
    setConfirmingBulk(false);
    setConfirmingKey(null);
    void load(filters, null, false);
  }

  function toggleSelected(key: string) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function deleteKeys(keys: string[]) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const json = await fetchJson("/api/owner-expenses", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idempotencyKeys: keys }),
      });
      const parsed = DeleteOwnerExpensesResponseSchema.safeParse(json);
      if (!parsed.success) throw new Error("Could not read the delete response");
      setNotice(
        parsed.data.deleted === 1
          ? "Expense deleted and tombstoned — a re-forward of the same receipt will not bring it back."
          : `${parsed.data.deleted} expenses deleted and tombstoned — re-forwards of the same receipts will not bring them back.`
      );
      setSelected(new Set());
      setConfirmingBulk(false);
      setConfirmingKey(null);
      await load(filters, null, false);
      if (historyOpen) await loadHistory();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Could not delete");
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit(event: FormEvent<HTMLFormElement>, expense: PostedExpense) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const form = new FormData(event.currentTarget);
    const occurred = String(form.get("occurredOn") ?? "");
    const payload: Record<string, unknown> = {
      idempotencyKey: expense.idempotencyKey,
      provider: String(form.get("provider") ?? "").trim(),
      amountUsd: Number(form.get("amountUsd")),
      occurredAt: occurred ? new Date(`${occurred}T12:00:00.000Z`).toISOString() : expense.occurredAt,
      kind: String(form.get("kind") ?? expense.kind),
      label: String(form.get("label") ?? "").trim(),
      notes: String(form.get("notes") ?? "").trim() || null,
      confidence: String(form.get("confidence") ?? expense.confidence),
    };
    try {
      const json = await fetchJson("/api/owner-expenses", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const parsed = EditOwnerExpenseResponseSchema.safeParse(json);
      if (!parsed.success) throw new Error("Could not read the edit response");
      setNotice(
        parsed.data.rekeyed
          ? "Expense updated. Its identity changed, so the old entry was tombstoned — a re-forward of the original receipt will not restore the old values."
          : "Expense updated."
      );
      setEditingKey(null);
      await load(filters, null, false);
      if (historyOpen) await loadHistory();
    } catch (editError) {
      setError(editError instanceof Error ? editError.message : "Could not save the edit");
    } finally {
      setBusy(false);
    }
  }

  const allPageSelected =
    expenses !== null && expenses.length > 0 && expenses.every((expense) => selected.has(expense.idempotencyKey));

  return (
    <section aria-labelledby="posted-expenses-heading" className="rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
      <div className="flex items-start justify-between gap-4 px-5 py-4">
        <div className="min-w-0">
          <h3 id="posted-expenses-heading" className="text-sm font-semibold text-gray-900 dark:text-gray-100">Posted Expenses</h3>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Every owner-recorded expense on the ledger.  Edits and deletes are written to the History below; a delete also tombstones the entry so a re-forwarded receipt can never resurrect it.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load(filters, null, false)}
          className="flex min-h-11 items-center gap-1 rounded-lg px-2 text-xs font-medium text-blue-600 hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-blue-300 dark:hover:bg-blue-950/30"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
        </button>
      </div>

      <form onSubmit={applyFilters} className="flex flex-wrap items-end gap-2 px-5 pb-4">
        <label className="flex min-w-44 flex-1 flex-col gap-1 text-xs text-gray-500 dark:text-gray-400">
          Search
          <span className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" aria-hidden="true" />
            <input
              type="search"
              value={filters.q}
              onChange={(event) => setFilters({ ...filters, q: event.target.value })}
              placeholder="Vendor, label, or notes"
              className="w-full rounded-lg border border-gray-300 bg-white py-2 pl-8 pr-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
            />
          </span>
        </label>
        <label className="flex flex-col gap-1 text-xs text-gray-500 dark:text-gray-400">
          Category
          <select
            value={filters.category}
            onChange={(event) => setFilters({ ...filters, category: event.target.value })}
            className="rounded-lg border border-gray-300 bg-white px-2 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
          >
            <option value="">All</option>
            <option value="tech">Tech</option>
            <option value="other">Other</option>
            <option value="uncategorized">Uncategorized</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-gray-500 dark:text-gray-400">
          From
          <input
            type="date"
            value={filters.from}
            onChange={(event) => setFilters({ ...filters, from: event.target.value })}
            className="rounded-lg border border-gray-300 bg-white px-2 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-gray-500 dark:text-gray-400">
          To
          <input
            type="date"
            value={filters.to}
            onChange={(event) => setFilters({ ...filters, to: event.target.value })}
            className="rounded-lg border border-gray-300 bg-white px-2 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-gray-500 dark:text-gray-400">
          Sort
          <select
            value={filters.sort}
            onChange={(event) => setFilters({ ...filters, sort: event.target.value })}
            className="rounded-lg border border-gray-300 bg-white px-2 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
          >
            <option value="occurredAt">Date</option>
            <option value="amountUsd">Amount</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-gray-500 dark:text-gray-400">
          Order
          <select
            value={filters.order}
            onChange={(event) => setFilters({ ...filters, order: event.target.value as Filters["order"] })}
            className="rounded-lg border border-gray-300 bg-white px-2 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
          >
            <option value="desc">Newest / highest first</option>
            <option value="asc">Oldest / lowest first</option>
          </select>
        </label>
        <button
          type="submit"
          className="min-h-11 rounded-lg bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        >
          Apply
        </button>
      </form>

      {totals && (
        <div className="flex flex-wrap gap-x-6 gap-y-1 border-t border-gray-100 px-5 py-3 text-xs text-gray-600 dark:border-gray-700 dark:text-gray-300">
          <span><strong className="text-gray-900 dark:text-gray-100">{totals.count}</strong> expenses</span>
          <span>Total <strong className="text-gray-900 dark:text-gray-100">{formatMoney(totals.totalUsd)}</strong></span>
          <span>Tech <strong className="text-gray-900 dark:text-gray-100">{formatMoney(totals.Tech)}</strong></span>
          <span>Other <strong className="text-gray-900 dark:text-gray-100">{formatMoney(totals.Other)}</strong></span>
          <span>Uncategorized <strong className="text-gray-900 dark:text-gray-100">{formatMoney(totals.uncategorized)}</strong></span>
        </div>
      )}

      {error && (
        <p role="alert" className="mx-5 mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">{error}</p>
      )}
      {notice && (
        <p className="mx-5 mb-3 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">{notice}</p>
      )}

      {selected.size > 0 && (
        <div className="mx-5 mb-3 flex flex-wrap items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <span>{selected.size} selected</span>
          {confirmingBulk ? (
            <>
              <span>Delete permanently?  Each entry is tombstoned and cannot be re-posted from its receipt.</span>
              <button type="button" disabled={busy} onClick={() => void deleteKeys([...selected])} className="rounded-md bg-red-600 px-2 py-1 font-medium text-white hover:bg-red-700 disabled:opacity-50">Confirm delete</button>
              <button type="button" onClick={() => setConfirmingBulk(false)} className="rounded-md px-2 py-1 font-medium hover:bg-amber-100 dark:hover:bg-amber-900/40">Cancel</button>
            </>
          ) : (
            <button type="button" onClick={() => setConfirmingBulk(true)} className="flex items-center gap-1 rounded-md px-2 py-1 font-medium hover:bg-amber-100 dark:hover:bg-amber-900/40">
              <Trash2 className="h-3.5 w-3.5" /> Delete selected
            </button>
          )}
        </div>
      )}

      <div className="overflow-x-auto px-2 pb-2">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead>
            <tr className="text-xs uppercase tracking-wide text-gray-400">
              <th scope="col" className="px-3 py-2">
                <input
                  type="checkbox"
                  aria-label="Select all shown expenses"
                  checked={allPageSelected}
                  onChange={() =>
                    setSelected(allPageSelected ? new Set() : new Set((expenses ?? []).map((expense) => expense.idempotencyKey)))
                  }
                />
              </th>
              <th scope="col" className="px-3 py-2">Date</th>
              <th scope="col" className="px-3 py-2">Expense</th>
              <th scope="col" className="px-3 py-2">Category</th>
              <th scope="col" className="px-3 py-2 text-right">Amount</th>
              <th scope="col" className="px-3 py-2"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {(expenses ?? []).map((expense) => (
              <Fragment key={expense.idempotencyKey}>
                <tr className="border-t border-gray-100 align-top dark:border-gray-700">
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      aria-label={`Select ${expense.vendor} ${formatMoney(expense.amountUsd)}`}
                      checked={selected.has(expense.idempotencyKey)}
                      onChange={() => toggleSelected(expense.idempotencyKey)}
                    />
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-gray-600 dark:text-gray-300">{formatDay(expense.occurredAt)}</td>
                  <td className="px-3 py-2">
                    <div className="font-medium text-gray-900 dark:text-gray-100">{expense.vendor}</div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">{expense.label}</div>
                    {expense.notes && <div className="max-w-md truncate text-xs text-gray-400" title={expense.notes}>{expense.notes}</div>}
                    <div className="text-[11px] text-gray-400">{expense.kind} · {shortKey(expense.idempotencyKey)}</div>
                  </td>
                  <td className="px-3 py-2">
                    <span className={`rounded-full px-2 py-1 text-xs font-medium ${categoryClasses(expense.category)}`}>
                      {expense.category ?? "Uncategorized"}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right font-medium text-gray-900 dark:text-gray-100">{formatMoney(expense.amountUsd)}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => setEditingKey(editingKey === expense.idempotencyKey ? null : expense.idempotencyKey)}
                      className="mr-1 rounded-md px-2 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-blue-950/30"
                    >
                      <Pencil className="mr-1 inline h-3.5 w-3.5" /> Edit
                    </button>
                    {confirmingKey === expense.idempotencyKey ? (
                      <>
                        <button type="button" disabled={busy} onClick={() => void deleteKeys([expense.idempotencyKey])} className="mr-1 rounded-md bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50">Confirm</button>
                        <button type="button" onClick={() => setConfirmingKey(null)} className="rounded-md px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700">Cancel</button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmingKey(expense.idempotencyKey)}
                        className="rounded-md px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-950/30"
                      >
                        <Trash2 className="mr-1 inline h-3.5 w-3.5" /> Delete
                      </button>
                    )}
                  </td>
                </tr>
                {editingKey === expense.idempotencyKey && (
                  <tr className="border-t border-gray-100 bg-gray-50 dark:border-gray-700 dark:bg-gray-900/40">
                    <td colSpan={6} className="px-3 py-3">
                      <form onSubmit={(event) => void saveEdit(event, expense)} className="flex flex-wrap items-end gap-2">
                        <label className="flex flex-col gap-1 text-xs text-gray-500 dark:text-gray-400">
                          Vendor
                          <input name="provider" defaultValue={expense.vendor} required className="rounded-lg border border-gray-300 bg-white px-2 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100" />
                        </label>
                        <label className="flex flex-col gap-1 text-xs text-gray-500 dark:text-gray-400">
                          Amount (USD)
                          <input name="amountUsd" type="number" step="0.01" defaultValue={expense.amountUsd ?? 0} required className="w-28 rounded-lg border border-gray-300 bg-white px-2 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100" />
                        </label>
                        <label className="flex flex-col gap-1 text-xs text-gray-500 dark:text-gray-400">
                          Date
                          <input name="occurredOn" type="date" defaultValue={formatDay(expense.occurredAt)} required className="rounded-lg border border-gray-300 bg-white px-2 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100" />
                        </label>
                        <label className="flex flex-col gap-1 text-xs text-gray-500 dark:text-gray-400">
                          Kind
                          <select name="kind" defaultValue={expense.kind} className="rounded-lg border border-gray-300 bg-white px-2 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100">
                            {KINDS.map((kind) => (
                              <option key={kind} value={kind}>{kind}</option>
                            ))}
                          </select>
                        </label>
                        <label className="flex min-w-52 flex-1 flex-col gap-1 text-xs text-gray-500 dark:text-gray-400">
                          Label
                          <input name="label" defaultValue={expense.label ?? ""} required className="rounded-lg border border-gray-300 bg-white px-2 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100" />
                        </label>
                        <label className="flex min-w-52 flex-[2] flex-col gap-1 text-xs text-gray-500 dark:text-gray-400">
                          Notes (category rides here, e.g. “Category: Tech”)
                          <input name="notes" defaultValue={expense.notes ?? ""} className="rounded-lg border border-gray-300 bg-white px-2 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100" />
                        </label>
                        <label className="flex flex-col gap-1 text-xs text-gray-500 dark:text-gray-400">
                          Confidence
                          <select name="confidence" defaultValue={expense.confidence} className="rounded-lg border border-gray-300 bg-white px-2 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100">
                            <option value="actual">actual</option>
                            <option value="estimated">estimated</option>
                          </select>
                        </label>
                        <button type="submit" disabled={busy} className="min-h-11 rounded-lg bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">Save</button>
                        <button type="button" onClick={() => setEditingKey(null)} className="min-h-11 rounded-lg px-3 text-sm font-medium text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700">Cancel</button>
                      </form>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {expenses !== null && expenses.length === 0 && (
              <tr className="border-t border-gray-100 dark:border-gray-700">
                <td colSpan={6} className="px-3 py-6 text-center text-sm text-gray-500 dark:text-gray-400">No posted expenses match.</td>
              </tr>
            )}
            {expenses === null && (
              <tr className="border-t border-gray-100 dark:border-gray-700">
                <td colSpan={6} className="px-3 py-6 text-center text-sm text-gray-500 dark:text-gray-400">Loading…</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {nextCursor && (
        <div className="px-5 pb-4">
          <button
            type="button"
            disabled={loading}
            onClick={() => void load(filters, nextCursor, true)}
            className="min-h-11 rounded-lg border border-gray-300 px-4 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            Load more
          </button>
        </div>
      )}

      <div className="border-t border-gray-100 px-5 py-3 dark:border-gray-700">
        <button
          type="button"
          aria-expanded={historyOpen}
          onClick={() => setHistoryOpen(!historyOpen)}
          className="flex min-h-11 items-center gap-1 rounded-lg px-2 text-xs font-medium text-blue-600 hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-blue-300 dark:hover:bg-blue-950/30"
        >
          History — edits and deletes
          <ChevronDown className={`h-3.5 w-3.5 transition-transform ${historyOpen ? "rotate-180" : ""}`} />
        </button>
        {historyOpen && (
          <ul className="space-y-2 pb-2 pt-1">
            {(history ?? []).map((entry) => (
              <li key={entry.id} className="rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600 dark:bg-gray-900/40 dark:text-gray-300">
                <span className={`mr-2 rounded-full px-2 py-0.5 font-medium ${entry.action === "delete" ? "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300" : "bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300"}`}>
                  {entry.action}
                </span>
                <strong className="text-gray-900 dark:text-gray-100">{entry.before.vendor}</strong>{" "}
                {formatMoney(entry.before.amountUsd)} · {formatDay(entry.before.occurredAt)} · {entry.before.label}
                {entry.action === "edit" && entry.after && (
                  <span> → {entry.after.vendor} {formatMoney(entry.after.amountUsd)} · {formatDay(entry.after.occurredAt)} · {entry.after.label}</span>
                )}
                <span className="block text-gray-400">{new Date(entry.createdAt).toLocaleString()} · {shortKey(entry.idempotencyKey)}{entry.resultingKey ? ` → ${shortKey(entry.resultingKey)}` : ""}</span>
              </li>
            ))}
            {history !== null && history.length === 0 && (
              <li className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">No edits or deletes recorded yet.</li>
            )}
            {history === null && (
              <li className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">Loading…</li>
            )}
          </ul>
        )}
      </div>
    </section>
  );
}
