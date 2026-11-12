/* eslint-disable react-hooks/exhaustive-deps */
"use client";

import { useEffect, useState } from "react";
import ModalDialog from "@/components/ModalDialog";
import { startDateForStatusTransition, toDateInputValue } from "@/lib/subscription-form";
import type { ExternalBillingRecord } from "@/components/ExternalBillingDetails";
import {
  externalBillingFreshnessWindowMs,
  formatExternalBillingAmount,
  isExternalBillingLinkCandidate,
  normalizeExternalBillingCadence,
} from "@/lib/external-billing-link";

export interface SubscriptionProviderOption {
  id: string;
  name: string;
  displayName: string;
  refreshIntervalMin?: number;
  externalBilling?: ExternalBillingRecord[];
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
  canceledAt?: string | null;
  effectiveStatus?: string;
  notes: string | null;
  externalBillingSource?: string | null;
  externalBillingId?: string | null;
  /** When true, owner edits (including pause) permanently relinquish auto-management. */
  externalBillingManaged?: boolean | null;
  activationMode?: "repurchase" | "resume";
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
  const [canceledAt, setCanceledAt] = useState(todayIso());
  const [notes, setNotes] = useState("");
  const [activationDateReset, setActivationDateReset] = useState(false);
  const [externalBillingKey, setExternalBillingKey] = useState("");
  const [activationMode, setActivationMode] = useState<"repurchase" | "resume">("repurchase");

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
    setCanceledAt(editSubscription?.canceledAt ? editSubscription.canceledAt.slice(0, 10) : todayIso());
    setNotes(editSubscription?.notes || "");
    setExternalBillingKey(
      editSubscription?.externalBillingSource && editSubscription.externalBillingId
        ? `${encodeURIComponent(editSubscription.externalBillingSource)}|${encodeURIComponent(editSubscription.externalBillingId)}`
        : ""
    );
    setActivationMode("repurchase");
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

      const [encodedSource, encodedId] = externalBillingKey.split("|");
      const externalBillingSource = encodedSource ? decodeURIComponent(encodedSource) : null;
      const externalBillingId = encodedId ? decodeURIComponent(encodedId) : null;
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
        canceledAt: status === "canceled" ? canceledAt : null,
        notes: notes.trim() || null,
        externalBillingSource,
        externalBillingId,
        activationMode,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const inputClass =
    "w-full px-3 py-2 border border-gray-300 rounded-lg text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100";
  const labelClass = "block text-sm font-medium text-gray-700 mb-1 dark:text-gray-200";

  const handleStatusChange = (nextStatus: string) => {
    const nextStartDate = startDateForStatusTransition({
      currentStatus: status,
      nextStatus,
      currentStartDate: startDate,
    });
    if (nextStatus === "active" && status !== "active") {
      setStartDate(nextStartDate);
      setActivationDateReset(true);
      setActivationMode("repurchase");
    }
    setStatus(nextStatus);
  };

  const selectedStatus = STATUS_OPTIONS.find((option) => option.value === status);
  const isActivating = status === "active" && editSubscription?.status !== "active";
  const canResumeExistingTerm =
    isActivating &&
    (editSubscription?.status === "paused" || editSubscription?.status === "canceled");
  const pausingManaged =
    Boolean(editSubscription?.externalBillingManaged) &&
    status === "paused" &&
    editSubscription?.status !== "paused";
  const editingManagedLinked =
    Boolean(editSubscription?.externalBillingManaged) ||
    Boolean(
      editSubscription?.externalBillingSource &&
        editSubscription?.externalBillingId &&
        (status === "paused" || status === "canceled") &&
        editSubscription?.status === "active"
    );
  const selectedProvider = providers.find((provider) => provider.id === providerId);
  const isLinkCandidate = (record: ExternalBillingRecord) =>
    isExternalBillingLinkCandidate(record, {
      staleAfterMs: externalBillingFreshnessWindowMs(
        selectedProvider?.refreshIntervalMin ?? 60
      ),
    });
  const billingRecords =
    selectedProvider?.externalBilling?.filter(
      (record) => {
        if (isLinkCandidate(record)) return true;
        if (!record.externalId || !editSubscription?.externalBillingSource || !editSubscription.externalBillingId) {
          return false;
        }
        return (
          record.source === editSubscription.externalBillingSource &&
          record.externalId === editSubscription.externalBillingId
        );
      }
    ) ?? [];
  if (
    providerId === editSubscription?.providerId &&
    editSubscription.externalBillingSource &&
    editSubscription.externalBillingId &&
    !billingRecords.some(
      (record) =>
        record.source === editSubscription.externalBillingSource &&
        record.externalId === editSubscription.externalBillingId
    )
  ) {
    billingRecords.push({
      source: editSubscription.externalBillingSource,
      externalId: editSubscription.externalBillingId,
      kind: "subscription",
      serviceName: editSubscription.externalBillingId,
      planName: "No longer reported by provider",
      status: null,
      amountUsd: null,
      currency: null,
      billingInterval: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      nextRenewalAt: null,
      requestLimit: null,
      requestLimitWindow: null,
      spendLimitUsd: null,
      spendLimitWindow: null,
      usageQuantity: null,
      remainingQuantity: null,
      usageUnit: null,
      rollupRole: "canonical",
      dateKind: null,
      syncedAt: "",
    });
  }
  const selectedLinkedBillingRecord = billingRecords.find(
    (record) =>
      `${encodeURIComponent(record.source)}|${encodeURIComponent(record.externalId ?? "")}` ===
      externalBillingKey
  );
  const providerControlsSchedule = Boolean(externalBillingKey);

  return (
    <ModalDialog
      title={editSubscription ? "Edit Subscription" : "Add Subscription"}
      onClose={onClose}
      closeDisabled={saving}
    >
          {error && (
            <div role="alert" className="mb-4 p-3 bg-red-50 text-red-700 text-sm rounded-lg dark:bg-red-950/60 dark:text-red-300">{error}</div>
          )}

          {editSubscription?.effectiveStatus === "expired" && (
            <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200">
              This term ended. Notes-only edits preserve its history. Enabling Auto-renews starts a new term now, anchored to current provider billing data when linked; for a one-term repurchase, unlink this record and track the new term separately.
            </div>
          )}

          {pausingManaged && (
            <div role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
              This plan is auto-managed from the provider&apos;s billing records. Pausing
              <strong> permanently converts it to owner-managed</strong>: the monitor will no longer
              reconcile, pause, or reprice it from billing syncs. Future charges stop until you
              reactivate it.
            </div>
          )}
          {!pausingManaged && editingManagedLinked && editSubscription?.externalBillingManaged && (
            <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200">
              Auto-managed from provider billing. Any owner edit permanently relinquishes auto-management.
            </div>
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
                <select id="subscription-provider" value={providerId} onChange={(e) => {
                  setProviderId(e.target.value);
                  setExternalBillingKey("");
                }} className={inputClass}>
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

            {billingRecords.length > 0 && (
              <div>
                <label htmlFor="subscription-external-billing" className={labelClass}>
                  Provider billing record (optional)
                </label>
                <select
                  id="subscription-external-billing"
                  value={externalBillingKey}
                  onChange={(event) => {
                    const key = event.target.value;
                    setExternalBillingKey(key);
                    const [source, externalId] = key
                      .split("|")
                      .map((part) => (part ? decodeURIComponent(part) : ""));
                    const record = billingRecords.find(
                      (candidate) =>
                        candidate.source === source &&
                        candidate.externalId === externalId
                    );
                    if (!record || !isLinkCandidate(record)) return;

                    const cadence = normalizeExternalBillingCadence(
                      record.billingInterval
                    );
                    setCostUsd(String(record.amountUsd));
                    setCurrency(record.currency!.trim().toUpperCase());
                    setInterval(cadence!);
                    setIntervalCount("1");
                    setStatus("active");
                    if (record.currentPeriodStart) {
                      setStartDate(record.currentPeriodStart.slice(0, 10));
                      setActivationDateReset(false);
                    }
                    if (!name.trim()) {
                      setName(
                        record.serviceName ||
                          record.planName ||
                          record.externalId ||
                          "Paid service"
                      );
                    }
                  }}
                  className={inputClass}
                >
                  <option value="">Not linked — count as a separate manual cost</option>
                  {billingRecords.map((record) => {
                    const value = `${encodeURIComponent(record.source)}|${encodeURIComponent(record.externalId!)}`;
                    const amount = record.amountUsd == null
                      ? ""
                      : ` · ${formatExternalBillingAmount(record.amountUsd, record.currency)}`;
                    const noLongerCompatible = !isLinkCandidate(record);
                    const noLongerReported = !record.syncedAt;
                    return (
                      <option key={value} value={value}>
                        {record.serviceName || record.planName || record.externalId}{amount} · {record.source}
                        {noLongerReported
                          ? " · no longer reported"
                          : noLongerCompatible
                            ? " · existing link no longer dedupe-compatible"
                            : ""}
                      </option>
                    );
                  })}
                </select>
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  Selecting a compatible record fills its amount, cadence, active status, and current-period start so the budget engine can dedupe that exact fixed charge safely.
                </p>
              </div>
            )}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="subscription-cost" className={labelClass}>Cost per period</label>
                <input
                  id="subscription-cost"
                  type="number"
                  inputMode="decimal"
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
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Budget and telemetry totals are normalized to USD.</p>
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
                  {isActivating && activationMode === "repurchase"
                    ? "Activation date"
                    : providerControlsSchedule
                      ? "Start date (provider-linked)"
                      : "Start date"}
                </label>
                <input
                  id="subscription-start-date"
                  type="date"
                  value={startDate}
                  onChange={(e) => {
                    setStartDate(e.target.value);
                    setActivationDateReset(false);
                  }}
                  disabled={
                    providerControlsSchedule ||
                    (canResumeExistingTerm && activationMode === "resume")
                  }
                  className={inputClass}
                />
                {providerControlsSchedule && (
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    The provider billing period controls this date. Unlink the record to edit the schedule manually.
                  </p>
                )}
                {isActivating && activationMode === "repurchase" && (
                  <p className={`mt-1 text-xs ${activationDateReset ? "text-emerald-700 dark:text-emerald-400" : "text-gray-500 dark:text-gray-400"}`}>
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
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{selectedStatus?.help}</p>
              </div>
            </div>

            {status === "canceled" && (
              <div className="mt-3">
                <label htmlFor="subscription-canceled-date" className={labelClass}>
                  Effective Canceled Date
                </label>
                <input
                  id="subscription-canceled-date"
                  type="date"
                  value={canceledAt}
                  onChange={(e) => setCanceledAt(e.target.value)}
                  className={inputClass}
                />
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  Specify the date this subscription was canceled to prevent synthetic charges after that day.
                </p>
              </div>
            )}

            {canResumeExistingTerm && (
              <fieldset className="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
                <legend className="px-1 text-sm font-medium text-gray-700 dark:text-gray-200">Reactivation billing</legend>
                <label className="mt-1 flex items-start gap-2 text-sm text-gray-700 dark:text-gray-200">
                  <input
                    type="radio"
                    name="activation-mode"
                    value="repurchase"
                    checked={activationMode === "repurchase"}
                    onChange={() => {
                      setActivationMode("repurchase");
                      setStartDate(todayIso());
                      setActivationDateReset(true);
                    }}
                  />
                  <span><strong>Repurchase now</strong> — start a new paid term and post a charge now.</span>
                </label>
                <label className="mt-2 flex items-start gap-2 text-sm text-gray-700 dark:text-gray-200">
                  <input
                    type="radio"
                    name="activation-mode"
                    value="resume"
                    checked={activationMode === "resume"}
                    onChange={() => {
                      setActivationMode("resume");
                      if (editSubscription?.startDate) {
                        setStartDate(editSubscription.startDate.slice(0, 10));
                      }
                      setActivationDateReset(false);
                    }}
                  />
                  <span><strong>Resume paid-through term</strong> — align to the linked provider period, or keep the existing manual cadence, and wait until renewal to charge.</span>
                </label>
              </fieldset>
            )}

            <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200">
              <input
                type="checkbox"
                checked={autoRenew}
                onChange={(e) => {
                  const checked = e.target.checked;
                  setAutoRenew(checked);
                  if (
                    checked &&
                    editSubscription?.effectiveStatus === "expired" &&
                    selectedLinkedBillingRecord?.currentPeriodStart &&
                    isLinkCandidate(selectedLinkedBillingRecord)
                  ) {
                    setStartDate(
                      selectedLinkedBillingRecord.currentPeriodStart.slice(0, 10)
                    );
                  }
                }}
                className="rounded border-gray-300 dark:border-gray-600 dark:bg-gray-900"
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

          <div className="mt-6 flex flex-wrap items-center justify-end gap-3 pt-6 border-t border-gray-100 dark:border-gray-700">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="min-h-11 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 dark:text-gray-200 dark:bg-gray-800 dark:border-gray-600 dark:hover:bg-gray-700"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || providers.length === 0}
              className="min-h-11 px-4 py-2 text-sm font-medium text-white bg-blue-600 border border-transparent rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save Subscription"}
            </button>
          </div>
    </ModalDialog>
  );
}
