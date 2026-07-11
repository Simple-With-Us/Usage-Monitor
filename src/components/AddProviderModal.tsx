"use client";

import { useEffect, useState } from "react";
import ModalDialog from "@/components/ModalDialog";
import ProviderIntegrationInfo from "@/components/ProviderIntegrationInfo";
import {
  BUILT_IN_PROVIDERS,
  PROVIDER_CATEGORIES,
  type ProviderDefinition,
} from "@/lib/provider-definitions";

type BillingMode = "actual" | "estimated" | "manual";

interface ProviderPlan {
  billingMode: BillingMode;
  fixedMonthlyCostUsd: number | null;
  monthlyBudgetUsd: number | null;
  monthlyRequestLimit: number | null;
  lowBalanceUsd: number | null;
  lowCredits: number | null;
  renewalDate: string | null;
  billingInterval: string | null;
  mustKeepFunded: boolean;
  notes: string | null;
}

interface Provider {
  id?: string;
  name: string;
  displayName: string;
  type: string;
  config?: Record<string, unknown>;
  apiKey?: string;
  label?: string | null;
  keyPreview?: string | null;
  plan?: ProviderPlan | null;
  allocations?: { projectId: string; percentage: number }[];
  secretConfigMeta?: { configured: boolean; fields: string[]; readable: boolean };
}

interface AddProviderModalProps {
  open: boolean;
  onClose: () => void;
  onSave: (provider: Provider) => Promise<void>;
  editProvider?: Provider | null;
  existingProviders?: Provider[];
}

type Tab = "builtin" | "custom" | "generic";

function planNumber(value: number | null | undefined): string {
  return value == null ? "" : String(value);
}

function dateInputValue(value: string | null | undefined): string {
  if (!value) return "";
  return value.slice(0, 10);
}

function stringFieldsFromConfig(config: Record<string, unknown> | undefined): Record<string, string> {
  if (!config) return {};
  return Object.fromEntries(
    Object.entries(config).flatMap(([key, value]) =>
      typeof value === "string" ? [[key, value]] : []
    )
  );
}

export default function AddProviderModal({
  open,
  onClose,
  onSave,
  editProvider,
  existingProviders = [],
}: AddProviderModalProps) {
  const [tab, setTab] = useState<Tab>(
    editProvider?.type === "custom" ? "custom" : editProvider?.type === "generic" ? "generic" : "builtin"
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [allocations, setAllocations] = useState<{ projectId: string; percentage: number }[]>(
    editProvider?.allocations || []
  );

  useEffect(() => {
    fetch("/api/projects")
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch projects");
        return res.json();
      })
      .then((data) => setProjects(data))
      .catch((err) => console.error("Error fetching projects:", err));
  }, []);

  const [selectedBuiltin, setSelectedBuiltin] = useState(editProvider?.name || "");
  const [builtinDisplayName, setBuiltinDisplayName] = useState(editProvider?.displayName || "");
  const [apiKey, setApiKey] = useState(editProvider?.apiKey || "");
  const [label, setLabel] = useState(editProvider?.label || "");
  const [originalConfig, setOriginalConfig] = useState<Record<string, unknown>>(editProvider?.config || {});
  const [extraFields, setExtraFields] = useState<Record<string, string>>(
    stringFieldsFromConfig(editProvider?.config)
  );

  const selectedDef: ProviderDefinition | undefined = BUILT_IN_PROVIDERS.find(
    (provider) => provider.name === selectedBuiltin
  );

  const matchingExisting = existingProviders.filter(
    (p) => p.name === selectedBuiltin && p.id !== editProvider?.id
  );

  // Custom fields
  const [customName, setCustomName] = useState(
    tab !== "builtin" ? editProvider?.name || "" : ""
  );
  const [customDisplayName, setCustomDisplayName] = useState(
    tab !== "builtin" ? editProvider?.displayName || "" : ""
  );
  const [customEndpoint, setCustomEndpoint] = useState(
    (editProvider?.config as Record<string, string>)?.endpoint || ""
  );
  const [customAuthType, setCustomAuthType] = useState(
    (editProvider?.config as Record<string, string>)?.authType || "bearer"
  );
  const [customAuthHeader, setCustomAuthHeader] = useState(
    (editProvider?.config as Record<string, string>)?.authHeaderName || "Authorization"
  );
  const [customBalancePath, setCustomBalancePath] = useState(
    (editProvider?.config as Record<string, string>)?.balancePath || "$.balance"
  );
  const [customCostPath, setCustomCostPath] = useState(
    (editProvider?.config as Record<string, string>)?.costPath || "$.cost"
  );
  const [customRequestsPath, setCustomRequestsPath] = useState(
    (editProvider?.config as Record<string, string>)?.requestsPath || "$.requests"
  );
  const [trackCredits, setTrackCredits] = useState(
    !!(editProvider?.config as Record<string, string>)?.creditsPath
  );
  const [customCreditsPath, setCustomCreditsPath] = useState(
    (editProvider?.config as Record<string, string>)?.creditsPath || "$.credits"
  );
  const [billingMode, setBillingMode] = useState<BillingMode>(
    editProvider?.plan?.billingMode ?? "manual"
  );
  const [fixedMonthlyCostUsd, setFixedMonthlyCostUsd] = useState(
    planNumber(editProvider?.plan?.fixedMonthlyCostUsd)
  );
  const [monthlyBudgetUsd, setMonthlyBudgetUsd] = useState(
    planNumber(editProvider?.plan?.monthlyBudgetUsd)
  );
  const [monthlyRequestLimit, setMonthlyRequestLimit] = useState(
    planNumber(editProvider?.plan?.monthlyRequestLimit)
  );
  const [lowBalanceUsd, setLowBalanceUsd] = useState(
    planNumber(editProvider?.plan?.lowBalanceUsd)
  );
  const [lowCredits, setLowCredits] = useState(
    planNumber(editProvider?.plan?.lowCredits)
  );
  const [renewalDate, setRenewalDate] = useState(
    dateInputValue(editProvider?.plan?.renewalDate)
  );
  const [billingInterval, setBillingInterval] = useState(
    editProvider?.plan?.billingInterval ?? "monthly"
  );
  const [mustKeepFunded, setMustKeepFunded] = useState(
    editProvider?.plan?.mustKeepFunded ?? false
  );
  const [planNotes, setPlanNotes] = useState(editProvider?.plan?.notes ?? "");

  useEffect(() => {
    if (!open) return;

    const config = editProvider?.config || {};
    const stringConfig = stringFieldsFromConfig(config);
    const nextTab: Tab = editProvider?.type === "custom" ? "custom" : editProvider?.type === "generic" ? "generic" : "builtin";
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset form state when modal opens
    setTab(nextTab);
    setError("");
    setSelectedBuiltin(editProvider?.name || "");
    setBuiltinDisplayName(editProvider?.displayName || "");
    setApiKey("");
    setLabel(editProvider?.label || "");
    setOriginalConfig(config);
    setExtraFields(stringConfig);
    setCustomName(nextTab !== "builtin" ? editProvider?.name || "" : "");
    setCustomDisplayName(nextTab !== "builtin" ? editProvider?.displayName || "" : "");
    setCustomEndpoint(stringConfig.endpoint || "");
    setCustomAuthType(stringConfig.authType || "bearer");
    setCustomAuthHeader(stringConfig.authHeaderName || "Authorization");
    setCustomBalancePath(stringConfig.balancePath || "$.balance");
    setCustomCostPath(stringConfig.costPath || "$.cost");
    setCustomRequestsPath(stringConfig.requestsPath || "$.requests");
    setTrackCredits(Boolean(stringConfig.creditsPath));
    setCustomCreditsPath(stringConfig.creditsPath || "$.credits");
    setBillingMode(editProvider?.plan?.billingMode ?? "manual");
    setFixedMonthlyCostUsd(planNumber(editProvider?.plan?.fixedMonthlyCostUsd));
    setMonthlyBudgetUsd(planNumber(editProvider?.plan?.monthlyBudgetUsd));
    setMonthlyRequestLimit(planNumber(editProvider?.plan?.monthlyRequestLimit));
    setLowBalanceUsd(planNumber(editProvider?.plan?.lowBalanceUsd));
    setLowCredits(planNumber(editProvider?.plan?.lowCredits));
    setRenewalDate(dateInputValue(editProvider?.plan?.renewalDate));
    setBillingInterval(editProvider?.plan?.billingInterval ?? "monthly");
    setMustKeepFunded(editProvider?.plan?.mustKeepFunded ?? false);
    setPlanNotes(editProvider?.plan?.notes ?? "");
    setAllocations(editProvider?.allocations || []);
  }, [editProvider, open]);

  if (!open) return null;

  const parseNumberField = (value: string, labelText: string, integer = false) => {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error(`${labelText} must be a non-negative number`);
    }
    if (integer && !Number.isInteger(parsed)) {
      throw new Error(`${labelText} must be a whole number`);
    }
    return parsed;
  };

  const buildPlan = () => ({
    billingMode,
    fixedMonthlyCostUsd: parseNumberField(
      fixedMonthlyCostUsd,
      "Fixed monthly cost"
    ),
    monthlyBudgetUsd: parseNumberField(monthlyBudgetUsd, "Monthly budget"),
    monthlyRequestLimit: parseNumberField(
      monthlyRequestLimit,
      "Monthly request limit",
      true
    ),
    lowBalanceUsd: parseNumberField(lowBalanceUsd, "Low balance alert"),
    lowCredits: parseNumberField(lowCredits, "Low credit alert"),
    renewalDate: renewalDate || null,
    billingInterval,
    mustKeepFunded,
    notes: planNotes.trim() || null,
  });

  const handleSave = async () => {
    setError("");
    setSaving(true);

    try {
      const plan = buildPlan();
      const allocationProjectIds = allocations.map((allocation) => allocation.projectId);
      if (allocationProjectIds.some((projectId) => !projectId)) {
        throw new Error("Select a project for every allocation");
      }
      if (new Set(allocationProjectIds).size !== allocationProjectIds.length) {
        throw new Error("Each project can only be allocated once");
      }
      if (allocations.some((allocation) => allocation.percentage <= 0 || allocation.percentage > 100)) {
        throw new Error("Allocation percentages must be greater than 0 and no more than 100");
      }
      const allocationTotal = allocations.reduce((sum, allocation) => sum + allocation.percentage, 0);
      if (allocationTotal > 100) {
        throw new Error("Project allocations cannot exceed 100%");
      }
      const allocationPayload = editProvider != null || allocations.length > 0 ? allocations : undefined;

      if (tab === "builtin") {
        if (!selectedDef) {
          setError("Please select a provider");
          setSaving(false);
          return;
        }

        const config: Record<string, unknown> = { ...originalConfig };
        for (const [key, value] of Object.entries(extraFields)) {
          if (value.trim()) config[key] = value.trim();
          else delete config[key];
        }
        if (selectedDef.needsAccountId && !String(config.accountId ?? "").trim()) {
          throw new Error(`${selectedDef.name === "twilio" ? "Account SID" : "Account ID"} is required`);
        }
        for (const field of selectedDef.needsConfig?.fields ?? []) {
          if (field.required && !String(config[field.key] ?? "").trim()) {
            throw new Error(`${field.label} is required`);
          }
        }

        if (!builtinDisplayName.trim()) throw new Error("Display name is required");
        await onSave({
          id: editProvider?.id,
          name: selectedDef.name,
          displayName: builtinDisplayName.trim(),
          type: "builtin",
          apiKey: selectedDef.usesApiKey === false ? undefined : apiKey || undefined,
          config: Object.keys(config).length > 0 ? config : undefined,
          label: label.trim() || null,
          plan,
          allocations: allocationPayload,
        });
      } else if (tab === "custom") {
        if (!customName.trim() || !customDisplayName.trim() || !customEndpoint.trim()) {
          setError("Name, display name, and endpoint are required");
          setSaving(false);
          return;
        }

        const config: Record<string, string> = {
          endpoint: customEndpoint,
          authType: customAuthType,
          authHeaderName: customAuthHeader,
          balancePath: customBalancePath,
          costPath: customCostPath,
          requestsPath: customRequestsPath,
        };
        if (trackCredits) {
          config.creditsPath = customCreditsPath;
        }

        await onSave({
          id: editProvider?.id,
          name: editProvider?.name ?? customName.trim().toLowerCase().replace(/\s+/g, "-"),
          displayName: customDisplayName.trim(),
          type: "custom",
          apiKey: apiKey || undefined,
          config,
          label: label.trim() || null,
          plan,
          allocations: allocationPayload,
        });
      } else if (tab === "generic") {
        if (!customName.trim() || !customDisplayName.trim()) {
          setError("Name and display name are required");
          setSaving(false);
          return;
        }

        await onSave({
          id: editProvider?.id,
          name: editProvider?.name ?? customName.trim().toLowerCase().replace(/\s+/g, "-"),
          displayName: customDisplayName.trim(),
          type: "generic",
          label: label.trim() || null,
          plan,
          allocations: allocationPayload,
        });
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const renderBillingFields = () => (
    <fieldset className="border border-gray-200 rounded-lg p-3 space-y-3">
      <legend className="text-sm font-medium text-gray-700 px-1">
        Billing and Limits
      </legend>
      <div>
        <label className="block text-xs text-gray-500 mb-1">Cost visibility</label>
        <select
          aria-label="Cost visibility"
          value={billingMode}
          onChange={(e) => setBillingMode(e.target.value as BillingMode)}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        >
          <option value="actual">Actual from provider</option>
          <option value="estimated">Estimated from usage</option>
          <option value="manual">Manual / plan price only</option>
        </select>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-gray-500 mb-1">
            Plan price / mo
          </label>
          <input
            aria-label="Plan price per month"
            type="number"
            min="0"
            step="0.01"
            value={fixedMonthlyCostUsd}
            onChange={(e) => setFixedMonthlyCostUsd(e.target.value)}
            placeholder="49"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">
            Budget / mo
          </label>
          <input
            aria-label="Monthly budget"
            type="number"
            min="0"
            step="0.01"
            value={monthlyBudgetUsd}
            onChange={(e) => setMonthlyBudgetUsd(e.target.value)}
            placeholder="100"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-gray-500 mb-1">
            Request limit / mo
          </label>
          <input
            aria-label="Monthly request limit"
            type="number"
            min="0"
            step="1"
            value={monthlyRequestLimit}
            onChange={(e) => setMonthlyRequestLimit(e.target.value)}
            placeholder="100000"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">
            Renewal date
          </label>
          <input
            aria-label="Renewal date"
            type="date"
            value={renewalDate}
            onChange={(e) => setRenewalDate(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">
            Renewal cadence
          </label>
          <select
            aria-label="Renewal cadence"
            value={billingInterval}
            onChange={(e) => setBillingInterval(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          >
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
            <option value="quarterly">Quarterly</option>
            <option value="annual">Annual</option>
          </select>
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-gray-500 mb-1">
            Low balance alert
          </label>
          <input
            aria-label="Low balance alert"
            type="number"
            min="0"
            step="0.01"
            value={lowBalanceUsd}
            onChange={(e) => setLowBalanceUsd(e.target.value)}
            placeholder="10"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">
            Low credit alert
          </label>
          <input
            aria-label="Low credit alert"
            type="number"
            min="0"
            step="1"
            value={lowCredits}
            onChange={(e) => setLowCredits(e.target.value)}
            placeholder="1000"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>
      </div>
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={mustKeepFunded}
          onChange={(e) => setMustKeepFunded(e.target.checked)}
          className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
        />
        <span className="text-sm text-gray-700">Must stay funded</span>
      </label>
      <div>
        <label className="block text-xs text-gray-500 mb-1">Notes</label>
        <textarea
          aria-label="Billing notes"
          value={planNotes}
          onChange={(e) => setPlanNotes(e.target.value)}
          rows={2}
          placeholder="Plan name, billing owner, pricing caveats"
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        />
      </div>
    </fieldset>
  );

  const renderExtraFields = () => {
    if (!selectedDef) return null;

    const fields: { key: string; label: string; placeholder: string; type?: string; required?: boolean }[] = [];

    if (selectedDef.needsAccountId) {
      if (selectedDef.name === "cloudflare") {
        fields.push({ key: "accountId", label: "Account ID", placeholder: "Cloudflare Account ID" });
        fields.push({ key: "accountEmail", label: "Account Email", placeholder: "Cloudflare Account Email", type: "email" });
        fields.push({ key: "databaseId", label: "D1 Database ID (optional)", placeholder: "D1 database UUID" });
        fields.push({ key: "r2BucketName", label: "R2 Bucket Name (optional)", placeholder: "R2 bucket name" });
        fields.push({ key: "kvNamespaceId", label: "KV Namespace ID (optional)", placeholder: "KV namespace UUID" });
        fields.push({ key: "queueId", label: "Queue ID (optional)", placeholder: "Queue UUID" });
      } else if (selectedDef.name === "twilio") {
        fields.push({ key: "accountId", label: "Account SID", placeholder: "Twilio Account SID" });
      }
    }

    if (selectedDef.needsOrgSlug) {
      fields.push({ key: "orgSlug", label: "Organization Slug", placeholder: "Sentry org slug" });
    }

    if (selectedDef.needsOrgId) {
      fields.push({ key: "orgId", label: "Organization ID", placeholder: "Anthropic Organization ID" });
    }

    if (selectedDef.needsConfig) {
      fields.push(...selectedDef.needsConfig.fields);
    }

    const hasHelp = !!selectedDef.helpNote;

    return fields.length > 0 || hasHelp ? (
      <div className="space-y-3">
        {fields.length > 0 && (
          <>
            <p className="text-xs font-medium text-gray-500">Extra Configuration</p>
            {fields.map((f) => (
              <div key={f.key}>
                <label htmlFor={`provider-extra-${f.key}`} className="block text-sm font-medium text-gray-700 mb-1">
                  {f.label}
                </label>
                <input
                  id={`provider-extra-${f.key}`}
                  aria-label={f.label}
                  type={f.type || "text"}
                  required={f.required}
                  value={extraFields[f.key] || ""}
                  onChange={(e) =>
                    setExtraFields((prev) => ({ ...prev, [f.key]: e.target.value }))
                  }
                  placeholder={f.placeholder}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
            ))}
          </>
        )}
        {hasHelp && (
          <div className="rounded-lg bg-blue-50 border border-blue-100 p-3">
            <p className="text-xs text-blue-800 leading-relaxed">{selectedDef.helpNote}</p>
          </div>
        )}
      </div>
    ) : null;
  };

  const renderAllocations = () => {
    if (projects.length === 0) return null;
    const allocationTotal = allocations.reduce((sum, allocation) => sum + allocation.percentage, 0);
    return (
      <fieldset className="border border-gray-200 rounded-lg p-3 space-y-3">
        <legend className="text-sm font-medium text-gray-700 px-1">
          Project Allocations
        </legend>
        <div className="space-y-2">
          {allocations.map((alloc, idx) => (
            <div key={`${alloc.projectId}-${idx}`} className="grid grid-cols-[minmax(0,1fr)_5rem_auto] items-center gap-2">
              <select
                aria-label={`Project for allocation ${idx + 1}`}
                value={alloc.projectId}
                onChange={(e) => {
                  const projectId = e.target.value;
                  setAllocations((current) =>
                    current.map((item, itemIndex) =>
                      itemIndex === idx ? { ...item, projectId } : item
                    )
                  );
                }}
                className="min-w-0 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">Select project...</option>
                {projects.map((p) => (
                  <option
                    key={p.id}
                    value={p.id}
                    disabled={p.id !== alloc.projectId && allocations.some((item) => item.projectId === p.id)}
                  >
                    {p.name}
                  </option>
                ))}
              </select>
              <div className="relative">
                <input
                  aria-label={`Percentage for allocation ${idx + 1}`}
                  type="number"
                  min="0.01"
                  max="100"
                  step="0.01"
                  value={alloc.percentage || ""}
                  onChange={(e) => {
                    const percentage = Number(e.target.value);
                    setAllocations((current) =>
                      current.map((item, itemIndex) =>
                        itemIndex === idx ? { ...item, percentage } : item
                      )
                    );
                  }}
                  placeholder="0"
                  className="w-full rounded-lg border border-gray-300 py-2 pl-3 pr-7 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <span className="pointer-events-none absolute right-2 top-2 text-sm text-gray-500">%</span>
              </div>
              <button
                type="button"
                aria-label={`Remove allocation ${idx + 1}`}
                onClick={() => setAllocations((current) => current.filter((_, i) => i !== idx))}
                className="min-h-9 min-w-9 rounded text-lg font-bold leading-none text-red-600 hover:bg-red-50 hover:text-red-800"
              >
                &times;
              </button>
            </div>
          ))}
          <p className={`text-xs ${allocationTotal > 100 ? "text-red-600" : "text-gray-500"}`}>
            {allocationTotal.toFixed(2).replace(/\.00$/, "")}% allocated · {Math.max(0, 100 - allocationTotal).toFixed(2).replace(/\.00$/, "")}% unallocated
          </p>
          <button
            type="button"
            disabled={allocations.length >= projects.length}
            onClick={() => {
              const nextProject = projects.find(
                (project) => !allocations.some((allocation) => allocation.projectId === project.id)
              );
              setAllocations((current) => [
                ...current,
                { projectId: nextProject?.id || "", percentage: 0 },
              ]);
            }}
            className="text-sm text-blue-600 hover:text-blue-800 font-medium mt-1 disabled:cursor-not-allowed disabled:text-gray-400"
          >
            + Add Project
          </button>
        </div>
      </fieldset>
    );
  };

  return (
    <ModalDialog
      title={editProvider ? "Edit Provider" : "Add Provider"}
      onClose={onClose}
      closeDisabled={saving}
    >
          <div className="flex border-b border-gray-200 mb-6">
            <button
              type="button"
              onClick={() => setTab("builtin")}
              disabled={Boolean(editProvider)}
              aria-pressed={tab === "builtin"}
              className={`flex-1 pb-3 text-sm font-medium border-b-2 transition-colors ${
                tab === "builtin"
                  ? "border-blue-500 text-blue-600"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              } disabled:cursor-not-allowed disabled:opacity-60`}
            >
              Built-in
            </button>
            <button
              type="button"
              onClick={() => setTab("custom")}
              disabled={Boolean(editProvider)}
              aria-pressed={tab === "custom"}
              className={`flex-1 pb-3 text-sm font-medium border-b-2 transition-colors ${
                tab === "custom"
                  ? "border-blue-500 text-blue-600"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              } disabled:cursor-not-allowed disabled:opacity-60`}
            >
              Custom
            </button>
            <button
              type="button"
              onClick={() => setTab("generic")}
              disabled={Boolean(editProvider)}
              aria-pressed={tab === "generic"}
              className={`flex-1 pb-3 text-sm font-medium border-b-2 transition-colors ${
                tab === "generic"
                  ? "border-blue-500 text-blue-600"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              } disabled:cursor-not-allowed disabled:opacity-60`}
            >
              Generic
            </button>
          </div>
          {editProvider && (
            <p className="-mt-4 mb-5 text-xs text-gray-500">
              Provider type and slug are fixed after creation; editable fields below are persisted.
            </p>
          )}
          {editProvider?.secretConfigMeta?.configured && (
            <div className="-mt-2 mb-5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
              Protected configuration is stored for {editProvider.secretConfigMeta.fields.join(", ") || "this provider"}.
              Leave hidden values blank to keep them unchanged.
            </div>
          )}

          {tab === "builtin" ? (
            <div className="space-y-4">
              <div>
                <label htmlFor="provider-builtin-name" className="block text-sm font-medium text-gray-700 mb-1">
                  Provider
                </label>
                <select
                  id="provider-builtin-name"
                  data-dialog-initial-focus
                  value={selectedBuiltin}
                  disabled={Boolean(editProvider)}
                  onChange={(e) => {
                    setSelectedBuiltin(e.target.value);
                    const def = BUILT_IN_PROVIDERS.find((p) => p.name === e.target.value);
                    setBuiltinDisplayName(def?.displayName || "");
                    setOriginalConfig({});
                    setExtraFields({});
                    if (def?.creditBased && editProvider) {
                      // keep existing config
                      setOriginalConfig(editProvider.config || {});
                      setExtraFields(stringFieldsFromConfig(editProvider.config));
                    }
                  }}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:cursor-not-allowed disabled:bg-gray-100"
                >
                  <option value="">Select a provider...</option>
                  {PROVIDER_CATEGORIES.map((cat) => (
                    <optgroup key={cat} label={cat}>
                      {BUILT_IN_PROVIDERS.filter((p) => p.category === cat).map(
                        (p) => (
                          <option key={p.name} value={p.name}>
                            {p.displayName}
                            {p.creditBased ? " (credits)" : ""}
                          </option>
                        )
                      )}
                    </optgroup>
                  ))}
                </select>
                {selectedDef?.creditBased && (
                  <p className="text-xs text-purple-600 mt-1">
                    Credit-based provider — credits tracking enabled
                  </p>
                )}
                {selectedDef && (
                  <ProviderIntegrationInfo
                    providerName={selectedDef.name}
                    providerType="builtin"
                    displayName={selectedDef.displayName}
                    variant="button"
                    className="mt-2"
                  />
                )}
              </div>

              <div>
                <label htmlFor="provider-builtin-display-name" className="block text-sm font-medium text-gray-700 mb-1">
                  Display Name
                </label>
                <input
                  id="provider-builtin-display-name"
                  data-dialog-initial-focus
                  type="text"
                  value={builtinDisplayName}
                  onChange={(e) => setBuiltinDisplayName(e.target.value)}
                  placeholder={selectedDef?.displayName || "Provider display name"}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>

              {matchingExisting.length > 0 && (
                <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-3">
                  <p className="text-xs font-medium text-blue-700 mb-2">
                    You already have {matchingExisting.length}{" "}
                    {matchingExisting.length === 1 ? "provider" : "providers"} configured
                    for {selectedDef?.displayName ?? selectedBuiltin}:
                  </p>
                  <ul className="space-y-1">
                    {matchingExisting.map((p) => (
                      <li key={p.id} className="text-xs text-blue-600 flex items-center gap-2">
                        <code className="bg-blue-100 px-1.5 py-0.5 rounded text-[11px]">
                          {p.keyPreview ?? "(no key preview)"}
                        </code>
                        {p.label && (
                          <span className="text-blue-500">({p.label})</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {selectedDef?.usesApiKey !== false && (
              <div>
                <label htmlFor="provider-builtin-api-key" className="block text-sm font-medium text-gray-700 mb-1">
                  API Key
                </label>
                <input
                  id="provider-builtin-api-key"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={editProvider ? "Leave blank to keep current" : "Your API key"}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
                {editProvider && !apiKey && editProvider.keyPreview && (
                  <p className="text-xs text-gray-500 mt-1">
                    Current key:{" "}
                    <code className="bg-gray-100 px-1.5 py-0.5 rounded text-[11px]">
                      {editProvider.keyPreview}
                    </code>
                  </p>
                )}
              </div>
              )}

              <div>
                <label htmlFor="provider-builtin-label" className="block text-xs font-medium text-gray-500 mb-1">
                  Label (optional)
                </label>
                <input
                  id="provider-builtin-label"
                  type="text"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="e.g. Agentic Trading, Congress.Trade"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
                <p className="text-xs text-gray-400 mt-0.5">Tag this key to distinguish it from others with the same provider name</p>
              </div>

              {renderExtraFields()}

              {renderAllocations()}
              {renderBillingFields()}
            </div>
          ) : tab === "custom" ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="provider-custom-name" className="block text-sm font-medium text-gray-700 mb-1">
                    Name (slug)
                  </label>
                  <input
                    id="provider-custom-name"
                    data-dialog-initial-focus
                    type="text"
                    value={customName}
                    onChange={(e) => setCustomName(e.target.value)}
                    disabled={Boolean(editProvider)}
                    placeholder="my-api"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:cursor-not-allowed disabled:bg-gray-100"
                  />
                </div>
                <div>
                  <label htmlFor="provider-custom-display-name" className="block text-sm font-medium text-gray-700 mb-1">
                    Display Name
                  </label>
                  <input
                    id="provider-custom-display-name"
                    data-dialog-initial-focus
                    type="text"
                    value={customDisplayName}
                    onChange={(e) => setCustomDisplayName(e.target.value)}
                    placeholder="My API"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="provider-custom-api-key" className="block text-sm font-medium text-gray-700 mb-1">
                  API Key
                </label>
                <input
                  id="provider-custom-api-key"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={editProvider ? "Leave blank to keep current" : "Your API key"}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
                {editProvider && !apiKey && editProvider.keyPreview && (
                  <p className="text-xs text-gray-500 mt-1">
                    Current key:{" "}
                    <code className="bg-gray-100 px-1.5 py-0.5 rounded text-[11px]">
                      {editProvider.keyPreview}
                    </code>
                  </p>
                )}
              </div>

              <div>
                <label htmlFor="provider-custom-label" className="block text-xs font-medium text-gray-500 mb-1">
                  Label (optional)
                </label>
                <input
                  id="provider-custom-label"
                  type="text"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="e.g. Production, Staging"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
                <p className="text-xs text-gray-400 mt-0.5">Tag this key to distinguish it from others</p>
              </div>

              <div>
                <label htmlFor="provider-custom-endpoint" className="block text-sm font-medium text-gray-700 mb-1">
                  Endpoint URL
                </label>
                <input
                  id="provider-custom-endpoint"
                  type="url"
                  value={customEndpoint}
                  onChange={(e) => setCustomEndpoint(e.target.value)}
                  placeholder="https://api.example.com/usage"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>

              <div>
                <label htmlFor="provider-custom-auth-type" className="block text-sm font-medium text-gray-700 mb-1">
                  Auth Type
                </label>
                <select
                  id="provider-custom-auth-type"
                  value={customAuthType}
                  onChange={(e) => setCustomAuthType(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                >
                  <option value="bearer">Bearer Token</option>
                  <option value="api-key">API Key</option>
                  <option value="basic">Basic Auth</option>
                </select>
              </div>

              <div>
                <label htmlFor="provider-custom-auth-header" className="block text-sm font-medium text-gray-700 mb-1">
                  Auth Header Name
                </label>
                <input
                  id="provider-custom-auth-header"
                  type="text"
                  value={customAuthHeader}
                  onChange={(e) => setCustomAuthHeader(e.target.value)}
                  placeholder="Authorization"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>

              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={trackCredits}
                  onChange={(e) => setTrackCredits(e.target.checked)}
                  className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                />
                <span className="text-sm text-gray-700">Track credits</span>
              </label>

              <fieldset className="border border-gray-200 rounded-lg p-3 space-y-3">
                <legend className="text-sm font-medium text-gray-700 px-1">
                  Response Mapping (JSON paths)
                </legend>
                <div>
                  <label htmlFor="provider-custom-balance-path" className="block text-xs text-gray-500 mb-1">Balance path</label>
                  <input
                    id="provider-custom-balance-path"
                    type="text"
                    value={customBalancePath}
                    onChange={(e) => setCustomBalancePath(e.target.value)}
                    placeholder="$.balance"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
                <div>
                  <label htmlFor="provider-custom-cost-path" className="block text-xs text-gray-500 mb-1">Cost path</label>
                  <input
                    id="provider-custom-cost-path"
                    type="text"
                    value={customCostPath}
                    onChange={(e) => setCustomCostPath(e.target.value)}
                    placeholder="$.cost"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
                <div>
                  <label htmlFor="provider-custom-requests-path" className="block text-xs text-gray-500 mb-1">Requests path</label>
                  <input
                    id="provider-custom-requests-path"
                    type="text"
                    value={customRequestsPath}
                    onChange={(e) => setCustomRequestsPath(e.target.value)}
                    placeholder="$.requests"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
                {trackCredits && (
                  <div>
                    <label htmlFor="provider-custom-credits-path" className="block text-xs text-gray-500 mb-1">Credits path</label>
                    <input
                      id="provider-custom-credits-path"
                      type="text"
                      value={customCreditsPath}
                      onChange={(e) => setCustomCreditsPath(e.target.value)}
                      placeholder="$.credits"
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    />
                  </div>
                )}
              </fieldset>

              {renderAllocations()}
              {renderBillingFields()}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="provider-generic-name" className="block text-sm font-medium text-gray-700 mb-1">
                    Name (slug)
                  </label>
                  <input
                    id="provider-generic-name"
                    data-dialog-initial-focus
                    type="text"
                    value={customName}
                    onChange={(e) => setCustomName(e.target.value)}
                    disabled={Boolean(editProvider)}
                    placeholder="my-service"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:cursor-not-allowed disabled:bg-gray-100"
                  />
                </div>
                <div>
                  <label htmlFor="provider-generic-display-name" className="block text-sm font-medium text-gray-700 mb-1">
                    Display Name
                  </label>
                  <input
                    id="provider-generic-display-name"
                    data-dialog-initial-focus
                    type="text"
                    value={customDisplayName}
                    onChange={(e) => setCustomDisplayName(e.target.value)}
                    placeholder="My Service"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="provider-generic-label" className="block text-xs font-medium text-gray-500 mb-1">
                  Label (optional)
                </label>
                <input
                  id="provider-generic-label"
                  type="text"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="e.g. Production, Staging"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>

              {renderAllocations()}
              {renderBillingFields()}
            </div>
          )}

          {error && (
            <p role="alert" className="mt-4 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          <div className="mt-6 flex flex-wrap gap-3 justify-end">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? "Saving..." : editProvider ? "Update" : "Add Provider"}
            </button>
          </div>
    </ModalDialog>
  );
}
