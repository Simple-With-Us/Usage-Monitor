/* eslint-disable react-hooks/set-state-in-effect */
"use client";

import { useEffect, useState } from "react";
import ModalDialog from "@/components/ModalDialog";
import { startDateForStatusTransition, toDateInputValue } from "@/lib/subscription-form";

export interface SubscriptionProviderOption {
  id: string;
  name: string;
  displayName: string;
}

export interface SubscriptionProjectOption {
  id: string;
  name: string;
}

export interface SubscriptionFormValue {
  id?: string;
  providerId: string;
  projectId: string | null;
  name: string;
  description: string | null;
  costUsd: number;
  currency: string;
  interval: string;
  intervalCount: number;
  anchorDay: number | null;
  startDate: string;
  autoRenew: boolean;
  status: string;
  notes: string | null;
}

interface AddSubscriptionModalProps {
  open: boolean;
  onClose: () => void;
  onSave: (subscription: SubscriptionFormValue) => Promise<void>;
  editSubscription?: SubscriptionFormValue | null;
  providers: SubscriptionProviderOption[];
  projects: SubscriptionProjectOption[];
}

const INTERVALS = ["weekly", "monthly", "quarterly", "annual"] as const;
const STATUS_OPTIONS = [
  { value: "considering", label: "Considering", help: "Planning only; no costs are posted." },
  { value: "active", label: "Active", help: "Posts one charge per elapsed billing period." },
  { value: "paused", label: "Paused", help: "Temporarily stops new charges." },
  { value: "canceled", label: "Canceled", help: "Stops new charges and records cancellation." },
] as const;

function todayIso(): string {
  return toDateInputValue(new Date());
}

export default function AddSubscriptionModal({
  open,
  onClose,
  onSave,
  editSubscription,
  providers,
  projects,
}: AddSubscriptionModalProps) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const [providerId, setProviderId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [costUsd, setCostUsd] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [interval, setInterval] = useState("monthly");
  const [intervalCount, setIntervalCount] = useState("1");
  const [anchorDay, setAnchorDay] = useState("");
  const [startDate, setStartDate] = useState(todayIso());
  const [autoRenew, setAutoRenew] = useState(true);
  const [status, setStatus] = useState("considering");
  const [notes, setNotes] = useState("");
  const [activationDateReset, setActivationDateReset] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError("");
    setProviderId(editSubscription?.providerId || providers[0]?.id || "");
    setProjectId(editSubscription?.projectId || "");
    setName(editSubscription?.name || "");
    setDescription(editSubscription?.description || "");
    setCostUsd(editSubscription?.costUsd != null ? String(editSubscription.costUsd) : "");
    setCurrency(editSubscription?.currency || "USD");
    setInterval(editSubscription?.interval || "monthly");
    setIntervalCount(editSubscription?.intervalCount ? String(editSubscription.intervalCount) : "1");
    setAnchorDay(editSubscription?.anchorDay != null ? String(editSubscription.anchorDay) : "");
    setStartDate(editSubscription?.startDate ? editSubscription.startDate.slice(0, 10) : todayIso());
    setAutoRenew(editSubscription?.autoRenew ?? true);
    setStatus(editSubscription?.status || "considering");
    setNotes(editSubscription?.notes || "");
    setActivationDateReset(false);
  }, [editSubscription, open, providers]);

  if (!open) return null;

  const handleSave = async () => {
    setError("");
    setSaving(true);
    try {
      if (!providerId) throw new Error("A provider is required");
      if (!name.trim()) throw new Error("A subscription name is required");
      const cost = Number(costUsd);
      if (!Number.isFinite(cost) || cost < 0) throw new Error("Cost must be a non-negative number");
      const count = Number(intervalCount);
      if (!Number.isInteger(count) || count < 1) throw new Error("Every N must be a positive integer");
      const anchor = anchorDay ? Number(anchorDay) : null;
      if (anchor != null && (!Number.isInteger(anchor) || anchor < 1 || anchor > 31)) {
        throw new Error("Renewal day must be between 1 and 31");
      }
      if (currency !== "USD") {
        throw new Error("Convert the invoice amount to USD before saving; budget totals are USD-only");
      }
      if (!startDate) throw new Error("A start date is required");

      await onSave({
        id: editSubscription?.id,
        providerId,
        projectId: projectId || null,
        name: name.trim(),
        description: description.trim() || null,
        costUsd: cost,
        currency: currency.trim().toUpperCase() || "USD",
        interval,
        intervalCount: count,
        anchorDay: anchor,
        startDate,
        autoRenew,
        status,
        notes: notes.trim() || null,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const inputClass =
    "w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500";
  const labelClass = "block text-sm font-medium text-gray-700 mb-1";

  const handleStatusChange = (nextStatus: string) => {
    const nextStartDate = startDateForStatusTransition({
      currentStatus: status,
      nextStatus,
      currentStartDate: startDate,
    });
    if (nextStatus === "active" && status !== "active") {
      setStartDate(nextStartDate);
      setActivationDateReset(true);
    }
    setStatus(nextStatus);
  };

  const selectedStatus = STATUS_OPTIONS.find((option) => option.value === status);
  const isActivating = status === "active" && editSubscription?.status !== "active";

  return (
    <ModalDialog
      title={editSubscription ? "Edit Subscription" : "Add Subscription"}
      onClose={onClose}
      closeDisabled={saving}
    >
          {error && (
            <div role="alert" className="mb-4 p-3 bg-red-50 text-red-700 text-sm rounded-lg">{error}</div>
          )}

          <div className="space-y-4">
            <div>
              <label htmlFor="subscription-name" className={labelClass}>Name</label>
              <input
                id="subscription-name"
                data-dialog-initial-focus
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., Claude Max plan"
                className={inputClass}
              />
            </div>

            <div>
              <label htmlFor="subscription-description" className={labelClass}>Description (optional)</label>
              <textarea
                id="subscription-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                placeholder="What this plan includes"
                className={inputClass}
              />
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="subscription-provider" className={labelClass}>Provider</label>
                <select id="subscription-provider" value={providerId} onChange={(e) => setProviderId(e.target.value)} className={inputClass}>
                  {providers.length === 0 && <option value="">No providers</option>}
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.displayName}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="subscription-project" className={labelClass}>Project (optional)</label>
                <select id="subscription-project" value={projectId} onChange={(e) => setProjectId(e.target.value)} className={inputClass}>
                  <option value="">Unattributed</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="subscription-cost" className={labelClass}>Cost per period</label>
                <input
                  id="subscription-cost"
                  type="number"
                  min="0"
                  step="0.01"
                  value={costUsd}
                  onChange={(e) => setCostUsd(e.target.value)}
                  placeholder="e.g., 20"
                  className={inputClass}
                />
              </div>
              <div>
                <label htmlFor="subscription-currency" className={labelClass}>Currency</label>
                <select
                  id="subscription-currency"
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value)}
                  className={inputClass}
                >
                  {currency !== "USD" && <option value={currency}>{currency} (convert before saving)</option>}
                  <option value="USD">USD</option>
                </select>
                <p className="mt-1 text-xs text-gray-500">Budget and telemetry totals are normalized to USD.</p>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div>
                <label htmlFor="subscription-interval-count" className={labelClass}>Every N</label>
                <input
                  id="subscription-interval-count"
                  type="number"
                  min="1"
                  step="1"
                  value={intervalCount}
                  onChange={(e) => setIntervalCount(e.target.value)}
                  className={inputClass}
                />
              </div>
              <div>
                <label htmlFor="subscription-interval" className={labelClass}>Interval</label>
                <select id="subscription-interval" value={interval} onChange={(e) => setInterval(e.target.value)} className={inputClass}>
                  {INTERVALS.map((i) => (
                    <option key={i} value={i}>
                      {i}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="subscription-anchor-day" className={labelClass}>Renewal day</label>
                <input
                  id="subscription-anchor-day"
                  type="number"
                  min="1"
                  max="31"
                  step="1"
                  value={anchorDay}
                  onChange={(e) => setAnchorDay(e.target.value)}
                  placeholder="auto"
                  className={inputClass}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="subscription-start-date" className={labelClass}>
                  {isActivating ? "Activation date" : "Start date"}
                </label>
                <input
                  id="subscription-start-date"
                  type="date"
                  value={startDate}
                  onChange={(e) => {
                    setStartDate(e.target.value);
                    setActivationDateReset(false);
                  }}
                  className={inputClass}
                />
                {isActivating && (
                  <p className={`mt-1 text-xs ${activationDateReset ? "text-emerald-700" : "text-gray-500"}`}>
                    Reset to today to avoid charging evaluation time. Change it only to the actual purchase date.
                  </p>
                )}
              </div>
              <div>
                  <label htmlFor="subscription-status" className={labelClass}>Status</label>
                  <select id="subscription-status" value={status} onChange={(e) => handleStatusChange(e.target.value)} className={inputClass}>
                    {STATUS_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 text-xs text-gray-500">{selectedStatus?.help}</p>
              </div>
            </div>

            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={autoRenew}
                onChange={(e) => setAutoRenew(e.target.checked)}
                className="rounded border-gray-300"
              />
              Auto-renews
            </label>

            <div>
              <label htmlFor="subscription-notes" className={labelClass}>Notes (optional)</label>
              <textarea
                id="subscription-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                className={inputClass}
              />
            </div>
          </div>

          <div className="mt-6 flex flex-wrap items-center justify-end gap-3 pt-6 border-t border-gray-100">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || providers.length === 0}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 border border-transparent rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save Subscription"}
            </button>
          </div>
    </ModalDialog>
  );
}
