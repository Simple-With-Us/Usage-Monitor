/**
 * Pure helpers for multi-step Add/Edit Provider wizard + fixed-fee exclusivity.
 */
export type WizardStepId = "type" | "credentials" | "budget" | "review";
export interface WizardStepDef {
  id: WizardStepId;
  index: number;
  label: string;
  shortLabel: string;
}
export const PROVIDER_WIZARD_STEPS: readonly WizardStepDef[] = [
  { id: "type", index: 1, label: "Type", shortLabel: "Type" },
  { id: "credentials", index: 2, label: "Credentials", shortLabel: "Creds" },
  { id: "budget", index: 3, label: "Budget & Plan", shortLabel: "Budget" },
  { id: "review", index: 4, label: "Review", shortLabel: "Review" },
] as const;
export const PROVIDER_WIZARD_STEP_COUNT = PROVIDER_WIZARD_STEPS.length;
export function wizardStepById(id: WizardStepId): WizardStepDef {
  const step = PROVIDER_WIZARD_STEPS.find((s) => s.id === id);
  if (!step) throw new Error(`Unknown wizard step: ${id}`);
  return step;
}
export function wizardStepAt(index: number): WizardStepDef | undefined {
  return PROVIDER_WIZARD_STEPS.find((s) => s.index === index);
}
export function nextWizardStep(current: WizardStepId): WizardStepId | null {
  const next = wizardStepAt(wizardStepById(current).index + 1);
  return next?.id ?? null;
}
export function prevWizardStep(current: WizardStepId): WizardStepId | null {
  const prev = wizardStepAt(wizardStepById(current).index - 1);
  return prev?.id ?? null;
}
export function isFirstWizardStep(id: WizardStepId): boolean {
  return wizardStepById(id).index === 1;
}
export function isLastWizardStep(id: WizardStepId): boolean {
  return wizardStepById(id).index === PROVIDER_WIZARD_STEP_COUNT;
}
export function formatWizardProgress(id: WizardStepId): string {
  const step = wizardStepById(id);
  return `${step.index}/${PROVIDER_WIZARD_STEP_COUNT}`;
}
export type ProviderWizardTab = "builtin" | "custom" | "generic";
export function validateTypeStep(input: {
  tab: ProviderWizardTab;
  selectedBuiltin: string;
  builtinDisplayName: string;
  customName: string;
  customDisplayName: string;
}): string | null {
  if (input.tab === "builtin") {
    if (!input.selectedBuiltin.trim()) return "Please select a provider";
    if (!input.builtinDisplayName.trim()) return "Display name is required";
    return null;
  }
  if (!input.customName.trim() || !input.customDisplayName.trim()) {
    return "Name and display name are required";
  }
  return null;
}
export function validateCredentialsStep(input: {
  tab: ProviderWizardTab;
  customEndpoint: string;
  missingRequiredConfigLabels: string[];
}): string | null {
  if (input.tab === "custom" && !input.customEndpoint.trim()) {
    return "Endpoint URL is required";
  }
  if (input.tab === "builtin" && input.missingRequiredConfigLabels.length > 0) {
    return `${input.missingRequiredConfigLabels[0]} is required`;
  }
  return null;
}
export function validateBudgetNumberField(
  value: string,
  labelText: string,
  integer = false
): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return `${labelText} must be a non-negative number`;
  }
  if (integer && !Number.isInteger(parsed)) {
    return `${labelText} must be a whole number`;
  }
  return null;
}
export function validateBudgetStep(input: {
  fixedMonthlyCostUsd: string;
  monthlyBudgetUsd: string;
  monthlyRequestLimit: string;
  lowBalanceUsd: string;
  lowCredits: string;
}): string | null {
  return (
    validateBudgetNumberField(input.fixedMonthlyCostUsd, "Fixed monthly cost") ||
    validateBudgetNumberField(input.monthlyBudgetUsd, "Monthly budget") ||
    validateBudgetNumberField(input.monthlyRequestLimit, "Monthly request limit", true) ||
    validateBudgetNumberField(input.lowBalanceUsd, "Low balance alert") ||
    validateBudgetNumberField(input.lowCredits, "Low credit alert", true)
  );
}
export function hasFixedMonthlyCostSet(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  const n = Number(trimmed);
  return Number.isFinite(n) && n > 0;
}
export const FIXED_FEE_SUBSCRIPTION_WARNING =
  "A fixed cost add-on is set. Model this fee either here OR as a Paid service Subscription — not both, or spend will double-count.";
