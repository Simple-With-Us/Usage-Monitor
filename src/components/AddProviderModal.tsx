"use client";

import { useEffect, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import ModalDialog from "@/components/ModalDialog";
import ProviderIntegrationInfo from "@/components/ProviderIntegrationInfo";
import {
  ADDABLE_BUILT_IN_PROVIDERS,
  BUILT_IN_PROVIDERS,
  hasConfiguredProviderField,
  PROVIDER_CATEGORIES,
  type ProviderDefinition,
} from "@/lib/provider-definitions";
import { isMustKeepFundedOptionVisible } from "@/lib/provider-funding-policy";
import {
  FIXED_FEE_SUBSCRIPTION_WARNING,
  PROVIDER_WIZARD_STEPS,
  formatWizardProgress,
  hasFixedMonthlyCostSet,
  isFirstWizardStep,
  isLastWizardStep,
  nextWizardStep,
  prevWizardStep,
  validateBudgetStep,
  validateCredentialsStep,
  validateTypeStep,
  wizardStepById,
  type WizardStepId,
} from "@/lib/provider-wizard";

type BillingMode = "actual" | "estimated" | "manual";

export interface ProviderPlan {
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

export interface ProviderSecretConfigOperation {
  path: string[];
  action: "clear";
}

const GOOGLE_BILLING_CONFIG_FIELDS = [
  "billingDataset",
  "googleProjectId",
  "billingTable",
  "serviceAccountJson",
] as const;

export const CLOUDFLARE_RESOURCE_PROBE_DISCLOSURE =
  "When supplied, each field enables one metadata/readability check for only that resource. These probes do not affect billing, subscriptions, spend, usage, quotas, or PayGo eligibility.";

export function actualUsageBillingPlan(plan: ProviderPlan): ProviderPlan {
  return {
    ...plan,
    billingMode: "actual",
  };
}

export function withoutGoogleBillingConfig(
  config: Record<string, unknown>
): Record<string, unknown> {
  const remaining = { ...config };
  for (const field of GOOGLE_BILLING_CONFIG_FIELDS) delete remaining[field];
  return remaining;
}

export function validateGoogleIntegrationSubmission(input: {
  config: Record<string, unknown>;
  protectedConfigFields?: string[];
  plan: ProviderPlan;
}): ProviderPlan {
  const configured = (key: string) =>
    hasConfiguredProviderField(
      input.config,
      key,
      input.protectedConfigFields ?? []
    );
  const projectConfigured = configured("googleProjectId");
  const serviceAccountConfigured = configured("serviceAccountJson");
  const billingRequested =
    configured("billingDataset") || configured("billingTable");
  // A service account with a billing dataset/table can be a billing-only
  // credential. Without a billing target, the shared credential expresses
  // Monitoring intent and therefore needs the exact Gemini project.
  const monitoringRequested =
    projectConfigured || (serviceAccountConfigured && !billingRequested);

  if (
    projectConfigured &&
    !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(
      String(input.config.googleProjectId).trim()
    )
  ) {
    throw new Error("Exact Gemini project ID is not a valid Google Cloud project ID");
  }
  if (monitoringRequested && !projectConfigured) {
    throw new Error(
      "Exact Gemini project ID is required for Cloud Monitoring"
    );
  }
  if (monitoringRequested && !serviceAccountConfigured) {
    throw new Error(
      "Google service-account JSON is required for Cloud Monitoring"
    );
  }
  if (billingRequested && !configured("billingDataset")) {
    throw new Error(
      "Billing export dataset is required when a billing table is configured"
    );
  }
  if (billingRequested && !serviceAccountConfigured) {
    throw new Error(
      "Google service-account JSON is required for Cloud Billing"
    );
  }

  return billingRequested ? actualUsageBillingPlan(input.plan) : input.plan;
}

interface Provider {
  id?: string;
  name: string;
  displayName: string;
  type: string;
  config?: Record<string, unknown>;
  apiKey?: string;
  secretConfigOperations?: ProviderSecretConfigOperation[];
  label?: string | null;
  refreshIntervalMin?: number;
  keyPreview?: string | null;
  plan?: ProviderPlan | null;
  allocations?: { projectId: string; percentage: number }[];
  secretConfigMeta?: { configured: boolean; fields: string[]; readable: boolean };
  credentialManagement?: {
    source: "infisical";
    scope: "st-primary";
    label: string;
    status: "active" | "revoked";
    alias: boolean;
    readOnlyFields: readonly string[];
  } | null;
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
  const [wizardStep, setWizardStep] = useState<WizardStepId>("type");

  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [allocations, setAllocations] = useState<{ projectId: string; percentage: number }[]>(
    editProvider?.allocations || []
  );

  // Gated on `open` (same convention as the effect below) — this modal is
  // always mounted by the settings page, so an ungated fetch duplicated the
  // page's own /api/projects request on every visit.
  useEffect(() => {
    if (!open) return;
    fetch("/api/projects")
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch projects");
        return res.json();
      })
      .then((data) => setProjects(data))
      .catch((err) => console.error("Error fetching projects:", err));
  }, [open]);

  const [selectedBuiltin, setSelectedBuiltin] = useState(editProvider?.name || "");
  const [builtinDisplayName, setBuiltinDisplayName] = useState(editProvider?.displayName || "");
  const [apiKey, setApiKey] = useState(editProvider?.apiKey || "");
  // Default to visible so a pasted/typed key can be verified. This only ever
  // affects what the user types — the stored key is never placed in this input
  // (edit mode shows a first6…last4 preview below instead).
  const [showApiKey, setShowApiKey] = useState(true);
  const [label, setLabel] = useState(editProvider?.label || "");
  const [refreshIntervalMin, setRefreshIntervalMin] = useState(
    editProvider?.refreshIntervalMin ?? 60
  );
  const [originalConfig, setOriginalConfig] = useState<Record<string, unknown>>(editProvider?.config || {});
  const [extraFields, setExtraFields] = useState<Record<string, string>>(
    stringFieldsFromConfig(editProvider?.config)
  );
  const [disconnectGoogleBilling, setDisconnectGoogleBilling] = useState(false);
  const credentialManaged = editProvider?.credentialManagement ?? null;

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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset form state when modal opens
    setTab(nextTab);
    setError("");
    setSelectedBuiltin(editProvider?.name || "");
    setBuiltinDisplayName(editProvider?.displayName || "");
    setApiKey("");
    setLabel(editProvider?.label || "");
    setRefreshIntervalMin(editProvider?.refreshIntervalMin ?? 60);
    setOriginalConfig(config);
    setExtraFields(stringConfig);
    setDisconnectGoogleBilling(false);
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
    setWizardStep("type");
  }, [editProvider, open]);

  if (!open) return null;

  const validateCurrentWizardStep = (): string | null => {
    if (wizardStep === "type") {
      return validateTypeStep({
        tab,
        selectedBuiltin,
        builtinDisplayName,
        customName,
        customDisplayName,
      });
    }
    if (wizardStep === "credentials") {
      return validateCredentialsStep({
        tab,
        customEndpoint,
        missingRequiredConfigLabels: [],
      });
    }
    if (wizardStep === "budget") {
      return validateBudgetStep({
        fixedMonthlyCostUsd,
        monthlyBudgetUsd,
        monthlyRequestLimit,
        lowBalanceUsd,
        lowCredits,
      });
    }
    return null;
  };

  const goNextStep = () => {
    const stepError = validateCurrentWizardStep();
    if (stepError) {
      setError(stepError);
      return;
    }
    setError("");
    const next = nextWizardStep(wizardStep);
    if (next) setWizardStep(next);
  };

  const goPrevStep = () => {
    setError("");
    const prev = prevWizardStep(wizardStep);
    if (prev) setWizardStep(prev);
  };

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

  const stayFundedVisible =
    tab !== "builtin" || isMustKeepFundedOptionVisible(selectedBuiltin);

  const buildPlan = (): ProviderPlan => ({
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
    // LLM/AI accounts hide the option; do not persist a stale true from a
    // previous provider selection. API still accepts true if re-enabled later.
    mustKeepFunded: stayFundedVisible ? mustKeepFunded : false,
    notes: planNotes.trim() || null,
  });

  const handleSave = async () => {
    setError("");
    setSaving(true);

    try {
      let plan = buildPlan();
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

        let config: Record<string, unknown> = { ...originalConfig };
        let secretConfigOperations: ProviderSecretConfigOperation[] | undefined;
        for (const [key, value] of Object.entries(extraFields)) {
          if (value.trim()) config[key] = value.trim();
          else delete config[key];
        }
        if (selectedDef.name === "cloudflare") {
          const authMode = String(
            config.authMode ?? (originalConfig.accountEmail ? "global_key" : "api_token")
          );
          if (authMode !== "api_token" && authMode !== "global_key") {
            throw new Error("Select a supported Cloudflare authentication mode");
          }
          config.authMode = authMode;
          if (authMode === "api_token") {
            delete config.accountEmail;
          } else if (!String(config.accountEmail ?? "").trim()) {
            throw new Error("Account email is required for a Global API key");
          }
          plan = actualUsageBillingPlan(plan);
        }
        if (selectedDef.name === "google-ai") {
          if (disconnectGoogleBilling) {
            config = withoutGoogleBillingConfig(config);
            secretConfigOperations = [
              { path: ["serviceAccountJson"], action: "clear" },
            ];
          } else {
            plan = validateGoogleIntegrationSubmission({
              config,
              protectedConfigFields:
                editProvider?.secretConfigMeta?.fields ?? [],
              plan,
            });
          }
        }
        if (selectedDef.needsAccountId && !String(config.accountId ?? "").trim()) {
          throw new Error(`${selectedDef.name === "twilio" ? "Account SID" : "Account ID"} is required`);
        }
        for (const field of selectedDef.needsConfig?.fields ?? []) {
          if (
            field.required &&
            !hasConfiguredProviderField(
              config,
              field.key,
              editProvider?.secretConfigMeta?.fields ?? []
            )
          ) {
            throw new Error(`${field.label} is required`);
          }
        }

        if (!builtinDisplayName.trim()) throw new Error("Display name is required");
        await onSave({
          id: editProvider?.id,
          name: selectedDef.name,
          displayName: builtinDisplayName.trim(),
          type: "builtin",
          apiKey:
            selectedDef.usesApiKey === false || credentialManaged
              ? undefined
              : apiKey || undefined,
          config:
            Object.keys(config).length > 0 || disconnectGoogleBilling
              ? config
              : undefined,
          secretConfigOperations,
          label: credentialManaged
            ? editProvider?.label ?? null
            : label.trim() || null,
          refreshIntervalMin,
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
          refreshIntervalMin,
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
          refreshIntervalMin,
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
    <fieldset className="border border-gray-200 rounded-lg p-3 space-y-3 dark:border-gray-700">
      <legend className="text-sm font-medium text-gray-700 px-1 dark:text-gray-200">
        Billing and Limits
      </legend>
      <div>
        <label className="block text-xs text-gray-500 mb-1 dark:text-gray-400">Cost visibility</label>
        <select
          aria-label="Cost visibility"
          value={billingMode}
          onChange={(e) => setBillingMode(e.target.value as BillingMode)}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
        >
          <option value="actual">Actual from provider</option>
          <option value="estimated">Estimated from usage</option>
          <option value="manual">Manual / plan price only</option>
        </select>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-gray-500 mb-1 dark:text-gray-400">
            Fixed cost add-on / mo
          </label>
          <input
            aria-label="Fixed cost add-on per month (not a Subscription)"
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            value={fixedMonthlyCostUsd}
            onChange={(e) => setFixedMonthlyCostUsd(e.target.value)}
            placeholder="49"
            title="Use this OR a Paid service Subscription for the same fee — not both. Both would double-count spend."
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
          />
          <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
            Not a Subscription. Do not also Track a paid service for the same fee.
          </p>
          {hasFixedMonthlyCostSet(fixedMonthlyCostUsd) && (
            <p
              role="status"
              className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] leading-relaxed text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
            >
              {FIXED_FEE_SUBSCRIPTION_WARNING}
            </p>
          )}
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1 dark:text-gray-400">
            Budget / mo
          </label>
          <input
            aria-label="Monthly budget"
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            value={monthlyBudgetUsd}
            onChange={(e) => setMonthlyBudgetUsd(e.target.value)}
            placeholder="100"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
          />
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-gray-500 mb-1 dark:text-gray-400">
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
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1 dark:text-gray-400">
            Renewal date
          </label>
          <input
            aria-label="Renewal date"
            type="date"
            value={renewalDate}
            onChange={(e) => setRenewalDate(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1 dark:text-gray-400">
            Renewal cadence
          </label>
          <select
            aria-label="Renewal cadence"
            value={billingInterval}
            onChange={(e) => setBillingInterval(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
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
          <label className="block text-xs text-gray-500 mb-1 dark:text-gray-400">
            Low balance alert
          </label>
          <input
            aria-label="Low balance alert"
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            value={lowBalanceUsd}
            onChange={(e) => setLowBalanceUsd(e.target.value)}
            placeholder="10"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1 dark:text-gray-400">
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
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
          />
        </div>
      </div>
      {stayFundedVisible ? (
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={mustKeepFunded}
            onChange={(e) => setMustKeepFunded(e.target.checked)}
            className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-900"
          />
          <span className="text-sm text-gray-700 dark:text-gray-200">Must stay funded</span>
        </label>
      ) : null}
      <div>
        <label className="block text-xs text-gray-500 mb-1 dark:text-gray-400">Notes</label>
        <textarea
          aria-label="Billing notes"
          value={planNotes}
          onChange={(e) => setPlanNotes(e.target.value)}
          rows={2}
          placeholder="Plan name, billing owner, pricing caveats"
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
        />
      </div>
    </fieldset>
  );

  const renderSyncCadence = () => (
    <div>
      <label htmlFor="provider-refresh-interval" className="block text-xs font-medium text-gray-500 mb-1 dark:text-gray-400">
        Automatic sync cadence
      </label>
      <select
        id="provider-refresh-interval"
        value={refreshIntervalMin}
        onChange={(event) => setRefreshIntervalMin(Number(event.target.value))}
        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-base sm:text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
      >
        {![15, 60, 360, 1440].includes(refreshIntervalMin) && (
          <option value={refreshIntervalMin}>Every {refreshIntervalMin} minutes (custom)</option>
        )}
        <option value={15}>Every 15 minutes</option>
        <option value={60}>Hourly</option>
        <option value={360}>Every 6 hours</option>
        <option value={1440}>Daily</option>
      </select>
      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
        Use a longer interval for quota-bearing provider endpoints.
      </p>
    </div>
  );

  const renderExtraFields = () => {
    if (!selectedDef) return null;

    type ExtraField = {
      key: string;
      label: string;
      placeholder: string;
      type?: string;
      required?: boolean;
      advanced?: boolean;
      options?: { value: string; label: string }[];
    };
    const fields: ExtraField[] = [];

    if (selectedDef.needsAccountId) {
      if (selectedDef.name === "cloudflare") {
        fields.push({ key: "accountId", label: "Account ID", placeholder: "Cloudflare Account ID" });
        fields.push({
          key: "authMode",
          label: "Authentication",
          placeholder: "",
          type: "select",
          options: [
            { value: "api_token", label: "API token (Billing Read) — recommended" },
            { value: "global_key", label: "Legacy Global API key" },
          ],
        });
        const cloudflareAuthMode =
          extraFields.authMode ||
          (originalConfig.accountEmail ? "global_key" : "api_token");
        if (cloudflareAuthMode === "global_key") {
          fields.push({
            key: "accountEmail",
            label: "Account email (Global API key only)",
            placeholder: "Cloudflare account email",
            type: "email",
          });
        }
        fields.push({ key: "databaseId", label: "D1 database ID", placeholder: "D1 database UUID", advanced: true });
        fields.push({ key: "r2BucketName", label: "R2 bucket name", placeholder: "R2 bucket name", advanced: true });
        fields.push({ key: "kvNamespaceId", label: "KV namespace ID", placeholder: "KV namespace UUID", advanced: true });
        fields.push({ key: "queueId", label: "Queue ID", placeholder: "Queue UUID", advanced: true });
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
    const primaryFields = fields.filter((field) => !field.advanced);
    const advancedFields = fields.filter((field) => field.advanced);

    const renderField = (field: ExtraField) => {
      const configuredSecret =
        editProvider?.secretConfigMeta?.fields.includes(field.key) ?? false;
      const googleBillingFieldDisabled =
        disconnectGoogleBilling &&
        selectedDef.name === "google-ai" &&
        GOOGLE_BILLING_CONFIG_FIELDS.includes(
          field.key as (typeof GOOGLE_BILLING_CONFIG_FIELDS)[number]
        );
      const value =
        field.key === "authMode"
          ? extraFields[field.key] ||
            (originalConfig.accountEmail ? "global_key" : "api_token")
          : extraFields[field.key] || "";
      return (
        <div key={field.key}>
          <label htmlFor={`provider-extra-${field.key}`} className="block text-sm font-medium text-gray-700 mb-1 dark:text-gray-200">
            {field.label}
          </label>
          {field.type === "textarea" ? (
            <textarea
              id={`provider-extra-${field.key}`}
              aria-label={field.label}
              aria-describedby={
                selectedDef.name === "cloudflare" && field.advanced
                  ? "cloudflare-resource-probe-help"
                  : undefined
              }
              required={field.required}
              disabled={googleBillingFieldDisabled}
              value={value}
              onChange={(event) =>
                setExtraFields((previous) => ({ ...previous, [field.key]: event.target.value }))
              }
              placeholder={configuredSecret ? "Configured — paste a replacement only to rotate" : field.placeholder}
              rows={7}
              spellCheck={false}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg font-mono text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:cursor-not-allowed disabled:bg-gray-100 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:disabled:bg-gray-800 dark:disabled:text-gray-400"
            />
          ) : field.type === "select" ? (
            <select
              id={`provider-extra-${field.key}`}
              aria-label={field.label}
              aria-describedby={
                selectedDef.name === "cloudflare" && field.advanced
                  ? "cloudflare-resource-probe-help"
                  : undefined
              }
              disabled={googleBillingFieldDisabled}
              value={value}
              onChange={(event) =>
                setExtraFields((previous) => ({ ...previous, [field.key]: event.target.value }))
              }
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:cursor-not-allowed disabled:bg-gray-100 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:disabled:bg-gray-800 dark:disabled:text-gray-400"
            >
              {field.options?.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          ) : (
            <input
              id={`provider-extra-${field.key}`}
              aria-label={field.label}
              aria-describedby={
                selectedDef.name === "cloudflare" && field.advanced
                  ? "cloudflare-resource-probe-help"
                  : undefined
              }
              type={field.type || "text"}
              required={field.required}
              disabled={googleBillingFieldDisabled}
              value={value}
              onChange={(event) =>
                setExtraFields((previous) => ({ ...previous, [field.key]: event.target.value }))
              }
              placeholder={configuredSecret ? "Configured — leave blank to keep current" : field.placeholder}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:cursor-not-allowed disabled:bg-gray-100 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:disabled:bg-gray-800 dark:disabled:text-gray-400"
            />
          )}
          {configuredSecret && !value && (
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Configured and encrypted; the value is never returned to this form.</p>
          )}
        </div>
      );
    };

    return fields.length > 0 || hasHelp ? (
      <div className="space-y-3">
        {primaryFields.length > 0 && (
          <>
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Extra Configuration</p>
            {primaryFields.map(renderField)}
          </>
        )}
        {advancedFields.length > 0 && (
          <details className="rounded-lg border border-gray-200 px-3 py-2 dark:border-gray-700">
            <summary className="cursor-pointer text-sm font-medium text-gray-600 dark:text-gray-300">
              {selectedDef.name === "cloudflare"
                ? "Optional single-resource metadata probes"
                : "Advanced optional configuration"}
            </summary>
            {selectedDef.name === "cloudflare" && (
              <p
                id="cloudflare-resource-probe-help"
                className="mt-2 text-xs leading-relaxed text-gray-500 dark:text-gray-400"
              >
                {CLOUDFLARE_RESOURCE_PROBE_DISCLOSURE}
              </p>
            )}
            <div className="mt-3 space-y-3">{advancedFields.map(renderField)}</div>
          </details>
        )}
        {selectedDef.name === "google-ai" &&
          editProvider &&
          (Boolean(originalConfig.billingDataset) ||
            Boolean(originalConfig.googleProjectId) ||
            Boolean(originalConfig.billingTable) ||
            (editProvider.secretConfigMeta?.fields.includes(
              "serviceAccountJson"
            ) ?? false)) && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 dark:border-red-900 dark:bg-red-950/40">
              <label className="flex cursor-pointer items-start gap-2">
                <input
                  type="checkbox"
                  checked={disconnectGoogleBilling}
                  onChange={(event) =>
                    setDisconnectGoogleBilling(event.target.checked)
                  }
                  className="mt-0.5 h-4 w-4 rounded border-gray-300 text-red-600 focus:ring-red-500 dark:border-gray-600 dark:bg-gray-900"
                />
                <span>
                  <span className="block text-sm font-medium text-red-800 dark:text-red-300">
                    Disconnect Google Cloud integrations
                  </span>
                  <span className="mt-0.5 block text-xs text-red-700 dark:text-red-300">
                    On save, remove the billing dataset, Gemini project/table,
                    and encrypted service-account JSON. Cloud Billing and Cloud
                    Monitoring will both disconnect. The Gemini API key, manual
                    price, renewal date, and unrelated configuration stay unchanged.
                  </span>
                </span>
              </label>
            </div>
          )}
        {hasHelp && (
          <div className="rounded-lg bg-blue-50 border border-blue-100 p-3 dark:border-blue-900 dark:bg-blue-950/30">
            <p className="text-xs text-blue-800 leading-relaxed dark:text-blue-200">{selectedDef.helpNote}</p>
          </div>
        )}
      </div>
    ) : null;
  };

  const renderAllocations = () => {
    if (projects.length === 0) return null;
    const allocationTotal = allocations.reduce((sum, allocation) => sum + allocation.percentage, 0);
    return (
      <fieldset className="border border-gray-200 rounded-lg p-3 space-y-3 dark:border-gray-700">
        <legend className="text-sm font-medium text-gray-700 px-1 dark:text-gray-200">
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
                className="min-w-0 px-3 py-2 border border-gray-300 rounded-lg text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
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
                  inputMode="decimal"
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
                  className="w-full rounded-lg border border-gray-300 py-2 pl-3 pr-7 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                />
                <span className="pointer-events-none absolute right-2 top-2 text-sm text-gray-500 dark:text-gray-400">%</span>
              </div>
              <button
                type="button"
                aria-label={`Remove allocation ${idx + 1}`}
                onClick={() => {
                  setAllocations((current) => {
                    const newAllocations = current.filter((_, i) => i !== idx);
                    if (newAllocations.length === 0) return newAllocations;
                    
                    const defaultPercentage = Number((100 / newAllocations.length).toFixed(2));
                    return newAllocations.map(item => ({
                      ...item,
                      percentage: defaultPercentage
                    }));
                  });
                }}
                className="min-h-9 min-w-9 rounded text-lg font-bold leading-none text-red-600 hover:bg-red-50 hover:text-red-800 dark:text-red-400 dark:hover:bg-red-950/60 dark:hover:text-red-300"
              >
                &times;
              </button>
            </div>
          ))}
          <p className={`text-xs ${allocationTotal > 100 ? "text-red-600 dark:text-red-400" : "text-gray-500 dark:text-gray-400"}`}>
            {allocationTotal.toFixed(2).replace(/\.00$/, "")}% allocated · {Math.max(0, 100 - allocationTotal).toFixed(2).replace(/\.00$/, "")}% unallocated
          </p>
          <button
            type="button"
            disabled={allocations.length >= projects.length}
            onClick={() => {
              const nextProject = projects.find(
                (project) => !allocations.some((allocation) => allocation.projectId === project.id)
              );
              setAllocations((current) => {
                const newLength = current.length + 1;
                const defaultPercentage = Number((100 / newLength).toFixed(2));
                
                const newAllocations = current.map(item => ({
                  ...item,
                  percentage: defaultPercentage
                }));
                
                newAllocations.push({
                  projectId: nextProject?.id || "",
                  percentage: defaultPercentage
                });
                
                // Adjust the first one to ensure exact 100% sum if there are rounding errors
                const sum = newAllocations.reduce((acc, curr) => acc + curr.percentage, 0);
                if (sum !== 100) {
                  newAllocations[0].percentage = Number((newAllocations[0].percentage + (100 - sum)).toFixed(2));
                }
                
                return newAllocations;
              });
            }}
            className="text-sm text-blue-600 hover:text-blue-800 font-medium mt-1 disabled:cursor-not-allowed disabled:text-gray-400 dark:text-blue-400 dark:hover:text-blue-300 dark:disabled:text-gray-600"
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
          <nav aria-label="Provider setup steps" className="mb-5">
            <ol className="flex flex-wrap items-center gap-1 sm:gap-2">
              {PROVIDER_WIZARD_STEPS.map((step, index) => {
                const active = step.id === wizardStep;
                const done = wizardStepById(wizardStep).index > step.index;
                return (
                  <li key={step.id} className="flex items-center gap-1 sm:gap-2">
                    {index > 0 && (
                      <span aria-hidden="true" className="mx-0.5 h-px w-3 sm:w-5 bg-gray-200 dark:bg-gray-600" />
                    )}
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-medium ${
                        active
                          ? "bg-accent text-white"
                          : done
                            ? "bg-accent-soft text-gray-900 dark:text-gray-100"
                            : "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400"
                      }`}
                      aria-current={active ? "step" : undefined}
                    >
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold bg-white/20">
                        {step.index}
                      </span>
                      <span className="hidden sm:inline">{step.label}</span>
                      <span className="sm:hidden">{step.shortLabel}</span>
                    </span>
                  </li>
                );
              })}
            </ol>
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
              Step {formatWizardProgress(wizardStep)}
              {editProvider ? " · editing existing provider" : ""}
            </p>
          </nav>

          <div className={`flex border-b border-gray-200 mb-6 dark:border-gray-700 ${wizardStep === "type" ? "" : "hidden"}`}>
            <button
              type="button"
              onClick={() => setTab("builtin")}
              disabled={Boolean(editProvider)}
              aria-pressed={tab === "builtin"}
              className={`flex-1 pb-3 text-sm font-medium border-b-2 transition-colors ${
                tab === "builtin"
                  ? "border-blue-500 text-blue-600 dark:text-blue-400"
                  : "border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
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
                  ? "border-blue-500 text-blue-600 dark:text-blue-400"
                  : "border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
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
                  ? "border-blue-500 text-blue-600 dark:text-blue-400"
                  : "border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
              } disabled:cursor-not-allowed disabled:opacity-60`}
            >
              Generic
            </button>
          </div>
          {editProvider && (
            <p className="-mt-4 mb-5 text-xs text-gray-500 dark:text-gray-400">
              Provider type and slug are fixed after creation; editable fields below are persisted.
            </p>
          )}
          {editProvider?.secretConfigMeta?.configured && (
            <div className="-mt-2 mb-5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">
              Protected configuration is stored for {editProvider.secretConfigMeta.fields.join(", ") || "this provider"}.
              Leave hidden values blank to keep them unchanged.
            </div>
          )}

          {tab === "builtin" ? (
            <div className="space-y-4">
              <div>
                <label htmlFor="provider-builtin-name" className="block text-sm font-medium text-gray-700 mb-1 dark:text-gray-200">
                  Provider
                </label>
                <select
                  id="provider-builtin-name"
                  data-dialog-initial-focus
                  value={selectedBuiltin}
                  disabled={Boolean(editProvider)}
                  onChange={(e) => {
                    setSelectedBuiltin(e.target.value);
                    const def = ADDABLE_BUILT_IN_PROVIDERS.find((p) => p.name === e.target.value);
                    setBuiltinDisplayName(def?.displayName || "");
                    setRefreshIntervalMin(def?.defaultRefreshIntervalMin ?? 60);
                    setOriginalConfig({});
                    setExtraFields({});
                    setDisconnectGoogleBilling(false);
                    if (def?.creditBased && editProvider) {
                      // keep existing config
                      setOriginalConfig(editProvider.config || {});
                      setExtraFields(stringFieldsFromConfig(editProvider.config));
                    }
                  }}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:cursor-not-allowed disabled:bg-gray-100 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:disabled:bg-gray-800 dark:disabled:text-gray-400"
                >
                  <option value="">Select a provider...</option>
                  {PROVIDER_CATEGORIES.map((cat) => (
                    <optgroup key={cat} label={cat}>
                      {ADDABLE_BUILT_IN_PROVIDERS.filter((p) => p.category === cat).map(
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
                  <p className="text-xs text-purple-600 mt-1 dark:text-purple-400">
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
                <label htmlFor="provider-builtin-display-name" className="block text-sm font-medium text-gray-700 mb-1 dark:text-gray-200">
                  Display Name
                </label>
                <input
                  id="provider-builtin-display-name"
                  data-dialog-initial-focus
                  type="text"
                  value={builtinDisplayName}
                  onChange={(e) => setBuiltinDisplayName(e.target.value)}
                  placeholder={selectedDef?.displayName || "Provider display name"}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                />
              </div>

              {matchingExisting.length > 0 && (
                <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-3 dark:border-blue-900 dark:bg-blue-950/30">
                  <p className="text-xs font-medium text-blue-700 mb-2 dark:text-blue-300">
                    You already have {matchingExisting.length}{" "}
                    {matchingExisting.length === 1 ? "provider" : "providers"} configured
                    for {selectedDef?.displayName ?? selectedBuiltin}:
                  </p>
                  <ul className="space-y-1">
                    {matchingExisting.map((p) => (
                      <li key={p.id} className="text-xs text-blue-600 flex items-center gap-2 dark:text-blue-300">
                        <code className="bg-blue-100 px-1.5 py-0.5 rounded text-[11px] dark:bg-blue-900/60">
                          {p.keyPreview ?? "(no key preview)"}
                        </code>
                        {p.label && (
                          <span className="text-blue-500 dark:text-blue-400">({p.label})</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {(wizardStep === "credentials" || wizardStep === "review") && selectedDef?.usesApiKey !== false && (
              <div>
                <label htmlFor="provider-builtin-api-key" className="block text-sm font-medium text-gray-700 mb-1 dark:text-gray-200">
                  {selectedDef?.name === "cloudflare"
                    ? ((extraFields.authMode || (originalConfig.accountEmail ? "global_key" : "api_token")) === "global_key"
                        ? "Global API key"
                        : "API token (Account Billing Read)")
                    : selectedDef?.name === "xai"
                      ? "Management API key"
                      : "API Key"}
                </label>
                <div className="relative">
                  <input
                    id="provider-builtin-api-key"
                    type={showApiKey ? "text" : "password"}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    disabled={Boolean(credentialManaged)}
                    placeholder={
                      credentialManaged
                        ? "Managed by Infisical"
                        : editProvider
                          ? "Leave blank to keep current"
                          : selectedDef?.name === "xai"
                            ? "Management API key"
                            : "Your API key"
                    }
                    className="w-full px-3 py-2 pr-10 border border-gray-300 rounded-lg text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:cursor-not-allowed disabled:bg-gray-100 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:disabled:bg-gray-800 dark:disabled:text-gray-400"
                  />
                  {!credentialManaged && (
                    <button
                      type="button"
                      onClick={() => setShowApiKey((v) => !v)}
                      aria-label={showApiKey ? "Hide API key" : "Show API key"}
                      aria-pressed={showApiKey}
                      title={showApiKey ? "Hide API key" : "Show API key"}
                      className="absolute inset-y-0 right-0 flex items-center px-3 text-gray-400 rounded-r-lg hover:text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:text-gray-500 dark:hover:text-gray-300"
                    >
                      {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  )}
                </div>
                {editProvider && !apiKey && editProvider.keyPreview && (
                  <p className="text-xs text-gray-500 mt-1 dark:text-gray-400">
                    Current key:{" "}
                    <code className="bg-gray-100 px-1.5 py-0.5 rounded text-[11px] dark:bg-gray-700">
                      {editProvider.keyPreview}
                    </code>
                  </p>
                )}
                {credentialManaged && (
                  <p className="mt-1 text-xs text-blue-600 dark:text-blue-400">
                    Credential and activation are read-only here and sync from the isolated Socratic primary-account source.
                  </p>
                )}
              </div>
              )}

              {(wizardStep === "credentials" || wizardStep === "review") && (
              <div>
                <label htmlFor="provider-builtin-label" className="block text-xs font-medium text-gray-500 mb-1 dark:text-gray-400">
                  Label (optional)
                </label>
                <input
                  id="provider-builtin-label"
                  type="text"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  disabled={Boolean(credentialManaged)}
                  placeholder="e.g. Socratic Trade, Congress.Trade"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:cursor-not-allowed disabled:bg-gray-100 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:disabled:bg-gray-800 dark:disabled:text-gray-400"
                />
                <p className="text-xs text-gray-400 mt-0.5 dark:text-gray-500">Tag this key to distinguish it from others with the same provider name</p>
              </div>
              )}

              {(wizardStep === "credentials" || wizardStep === "review") && renderExtraFields()}
              {(wizardStep === "budget" || wizardStep === "review") && (
                <>
                  {renderSyncCadence()}
                  {renderAllocations()}
                  {renderBillingFields()}
                </>
              )}
              {wizardStep === "review" && (
                <div className="rounded-lg border border-orange-100 bg-orange-50/60 px-3 py-3 text-sm text-gray-900 dark:border-orange-900/40 dark:bg-orange-950/20 dark:text-gray-100">
                  <p className="font-medium">Review</p>
                  <p className="mt-1 text-xs opacity-90">
                    {builtinDisplayName || selectedBuiltin} · {tab}
                    {label ? ` · ${label}` : ""} · budget{" "}
                    {monthlyBudgetUsd.trim() ? `$${monthlyBudgetUsd}` : "unset"}
                    {fixedMonthlyCostUsd.trim() ? ` · fixed $${fixedMonthlyCostUsd}/mo` : ""}
                  </p>
                </div>
              )}
            </div>
          ) : tab === "custom" ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="provider-custom-name" className="block text-sm font-medium text-gray-700 mb-1 dark:text-gray-200">
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
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:cursor-not-allowed disabled:bg-gray-100 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:disabled:bg-gray-800 dark:disabled:text-gray-400"
                  />
                </div>
                <div>
                  <label htmlFor="provider-custom-display-name" className="block text-sm font-medium text-gray-700 mb-1 dark:text-gray-200">
                    Display Name
                  </label>
                  <input
                    id="provider-custom-display-name"
                    data-dialog-initial-focus
                    type="text"
                    value={customDisplayName}
                    onChange={(e) => setCustomDisplayName(e.target.value)}
                    placeholder="My API"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="provider-custom-api-key" className="block text-sm font-medium text-gray-700 mb-1 dark:text-gray-200">
                  API Key
                </label>
                <div className="relative">
                  <input
                    id="provider-custom-api-key"
                    type={showApiKey ? "text" : "password"}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={editProvider ? "Leave blank to keep current" : "Your API key"}
                    className="w-full px-3 py-2 pr-10 border border-gray-300 rounded-lg text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                  />
                  <button
                    type="button"
                    onClick={() => setShowApiKey((v) => !v)}
                    aria-label={showApiKey ? "Hide API key" : "Show API key"}
                    aria-pressed={showApiKey}
                    title={showApiKey ? "Hide API key" : "Show API key"}
                    className="absolute inset-y-0 right-0 flex items-center px-3 text-gray-400 rounded-r-lg hover:text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:text-gray-500 dark:hover:text-gray-300"
                  >
                    {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                {editProvider && !apiKey && editProvider.keyPreview && (
                  <p className="text-xs text-gray-500 mt-1 dark:text-gray-400">
                    Current key:{" "}
                    <code className="bg-gray-100 px-1.5 py-0.5 rounded text-[11px] dark:bg-gray-700">
                      {editProvider.keyPreview}
                    </code>
                  </p>
                )}
              </div>

              <div>
                <label htmlFor="provider-custom-label" className="block text-xs font-medium text-gray-500 mb-1 dark:text-gray-400">
                  Label (optional)
                </label>
                <input
                  id="provider-custom-label"
                  type="text"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="e.g. Production, Staging"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                />
                <p className="text-xs text-gray-400 mt-0.5 dark:text-gray-500">Tag this key to distinguish it from others</p>
              </div>

              <div>
                <label htmlFor="provider-custom-endpoint" className="block text-sm font-medium text-gray-700 mb-1 dark:text-gray-200">
                  Endpoint URL
                </label>
                <input
                  id="provider-custom-endpoint"
                  type="url"
                  value={customEndpoint}
                  onChange={(e) => setCustomEndpoint(e.target.value)}
                  placeholder="https://api.example.com/usage"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                />
              </div>

              <div>
                <label htmlFor="provider-custom-auth-type" className="block text-sm font-medium text-gray-700 mb-1 dark:text-gray-200">
                  Auth Type
                </label>
                <select
                  id="provider-custom-auth-type"
                  value={customAuthType}
                  onChange={(e) => setCustomAuthType(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                >
                  <option value="bearer">Bearer Token</option>
                  <option value="api-key">API Key</option>
                  <option value="basic">Basic Auth</option>
                </select>
              </div>

              <div>
                <label htmlFor="provider-custom-auth-header" className="block text-sm font-medium text-gray-700 mb-1 dark:text-gray-200">
                  Auth Header Name
                </label>
                <input
                  id="provider-custom-auth-header"
                  type="text"
                  value={customAuthHeader}
                  onChange={(e) => setCustomAuthHeader(e.target.value)}
                  placeholder="Authorization"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                />
              </div>

              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={trackCredits}
                  onChange={(e) => setTrackCredits(e.target.checked)}
                  className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-900"
                />
                <span className="text-sm text-gray-700 dark:text-gray-200">Track credits</span>
              </label>

              <fieldset className="border border-gray-200 rounded-lg p-3 space-y-3 dark:border-gray-700">
                <legend className="text-sm font-medium text-gray-700 px-1 dark:text-gray-200">
                  Response Mapping (JSON paths)
                </legend>
                <div>
                  <label htmlFor="provider-custom-balance-path" className="block text-xs text-gray-500 mb-1 dark:text-gray-400">Balance path</label>
                  <input
                    id="provider-custom-balance-path"
                    type="text"
                    value={customBalancePath}
                    onChange={(e) => setCustomBalancePath(e.target.value)}
                    placeholder="$.balance"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                  />
                </div>
                <div>
                  <label htmlFor="provider-custom-cost-path" className="block text-xs text-gray-500 mb-1 dark:text-gray-400">Cost path</label>
                  <input
                    id="provider-custom-cost-path"
                    type="text"
                    value={customCostPath}
                    onChange={(e) => setCustomCostPath(e.target.value)}
                    placeholder="$.cost"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                  />
                </div>
                <div>
                  <label htmlFor="provider-custom-requests-path" className="block text-xs text-gray-500 mb-1 dark:text-gray-400">Requests path</label>
                  <input
                    id="provider-custom-requests-path"
                    type="text"
                    value={customRequestsPath}
                    onChange={(e) => setCustomRequestsPath(e.target.value)}
                    placeholder="$.requests"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                  />
                </div>
                {trackCredits && (
                  <div>
                    <label htmlFor="provider-custom-credits-path" className="block text-xs text-gray-500 mb-1 dark:text-gray-400">Credits path</label>
                    <input
                      id="provider-custom-credits-path"
                      type="text"
                      value={customCreditsPath}
                      onChange={(e) => setCustomCreditsPath(e.target.value)}
                      placeholder="$.credits"
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                    />
                  </div>
                )}
              </fieldset>

              {(wizardStep === "budget" || wizardStep === "review") && (
                <>
                  {renderSyncCadence()}
                  {renderAllocations()}
                  {renderBillingFields()}
                </>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="provider-generic-name" className="block text-sm font-medium text-gray-700 mb-1 dark:text-gray-200">
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
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:cursor-not-allowed disabled:bg-gray-100 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:disabled:bg-gray-800 dark:disabled:text-gray-400"
                  />
                </div>
                <div>
                  <label htmlFor="provider-generic-display-name" className="block text-sm font-medium text-gray-700 mb-1 dark:text-gray-200">
                    Display Name
                  </label>
                  <input
                    id="provider-generic-display-name"
                    data-dialog-initial-focus
                    type="text"
                    value={customDisplayName}
                    onChange={(e) => setCustomDisplayName(e.target.value)}
                    placeholder="My Service"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="provider-generic-label" className="block text-xs font-medium text-gray-500 mb-1 dark:text-gray-400">
                  Label (optional)
                </label>
                <input
                  id="provider-generic-label"
                  type="text"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="e.g. Production, Staging"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                />
              </div>

              {(wizardStep === "budget" || wizardStep === "review") && (
                <>
                  {renderSyncCadence()}
                  {renderAllocations()}
                  {renderBillingFields()}
                </>
              )}
            </div>
          )}

          {error && (
            <p role="alert" className="mt-4 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2 dark:text-red-300 dark:bg-red-950/60">
              {error}
            </p>
          )}

          <div className="mt-6 flex flex-wrap gap-3 justify-between">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="min-h-11 px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors dark:text-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600"
            >
              Cancel
            </button>
            <div className="flex flex-wrap gap-3 justify-end">
              {!isFirstWizardStep(wizardStep) && (
                <button
                  type="button"
                  onClick={goPrevStep}
                  disabled={saving}
                  className="min-h-11 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 dark:text-gray-200 dark:bg-gray-800 dark:border-gray-600"
                >
                  Back
                </button>
              )}
              {!isLastWizardStep(wizardStep) ? (
                <button
                  type="button"
                  onClick={goNextStep}
                  disabled={saving}
                  className="min-h-11 px-4 py-2 text-sm font-medium text-white bg-accent rounded-lg hover:opacity-90 disabled:opacity-50"
                >
                  Next
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving}
                  className="min-h-11 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {saving ? "Saving..." : editProvider ? "Update" : "Add Provider"}
                </button>
              )}
            </div>
          </div>
    </ModalDialog>
  );
}
