import { SUBSCRIPTION_INTERVALS } from "@/lib/subscriptions";
import {
  assertSafeProviderConfigKey,
  isSecretConfigKey,
  normalizeProviderConfigInput,
  type ProviderCredentialAction,
  type ProviderSecretConfigOperation,
} from "@/lib/provider-secret-config";

export interface ProviderInput {
  name: string;
  displayName: string;
  type: string;
  apiKey?: string;
  config?: Record<string, unknown>;
  refreshIntervalMin: number;
  groupId?: string;
  label?: string;
  plan?: ProviderPlanInput;
  allocations?: { projectId: string; percentage: number }[];
}

export interface ProviderUpdateInput {
  displayName?: string;
  apiKeyOperation: ApiKeyOperation;
  config?: Record<string, unknown> | null;
  secretConfigOperations?: ProviderSecretConfigOperation[];
  isActive?: boolean;
  refreshIntervalMin?: number;
  groupId?: string | null;
  label?: string | null;
  plan?: ProviderPlanInput;
  allocations?: { projectId: string; percentage: number }[];
}

export type ApiKeyOperation =
  | { action: "preserve" }
  | { action: "clear" }
  | { action: "replace"; value: string };

export interface ProviderPlanInput {
  billingMode?: "actual" | "estimated" | "manual";
  fixedMonthlyCostUsd?: number | null;
  monthlyBudgetUsd?: number | null;
  monthlyRequestLimit?: number | null;
  lowBalanceUsd?: number | null;
  lowCredits?: number | null;
  renewalDate?: Date | null;
  billingInterval?: string | null;
  mustKeepFunded?: boolean;
  notes?: string | null;
}

const MAX_REFRESH_INTERVAL_MIN = 60 * 24 * 7;
const BILLING_MODES = new Set(["actual", "estimated", "manual"]);
const BILLING_INTERVALS = new Set(SUBSCRIPTION_INTERVALS);
const MAX_API_KEY_LENGTH = 16_384;
const MAX_SECRET_CONFIG_OPERATIONS = 50;
const MAX_SECRET_VALUE_LENGTH = 4_096;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function cleanOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function cleanNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return cleanOptionalString(value);
}

function parseApiKeyValue(value: unknown, required: boolean): string | undefined {
  if (value == null || value === "") {
    if (required) throw new Error("apiKey is required when apiKeyAction is replace");
    return undefined;
  }
  if (typeof value !== "string") throw new Error("apiKey must be a string");
  const apiKey = value.trim();
  if (!apiKey) {
    if (required) throw new Error("apiKey is required when apiKeyAction is replace");
    return undefined;
  }
  if (apiKey.length > MAX_API_KEY_LENGTH) {
    throw new Error(`apiKey must be ${MAX_API_KEY_LENGTH} characters or fewer`);
  }
  return apiKey;
}

function parseApiKeyOperation(body: Record<string, unknown>): ApiKeyOperation {
  const rawAction = body.apiKeyAction;
  if (rawAction === undefined) {
    const value = parseApiKeyValue(body.apiKey, false);
    return value ? { action: "replace", value } : { action: "preserve" };
  }
  if (
    typeof rawAction !== "string" ||
    !(["preserve", "replace", "clear"] as ProviderCredentialAction[]).includes(
      rawAction as ProviderCredentialAction
    )
  ) {
    throw new Error("apiKeyAction must be preserve, replace, or clear");
  }
  if (rawAction === "replace") {
    return { action: "replace", value: parseApiKeyValue(body.apiKey, true)! };
  }
  if (parseApiKeyValue(body.apiKey, false)) {
    throw new Error(`apiKey must be omitted when apiKeyAction is ${rawAction}`);
  }
  return { action: rawAction as "preserve" | "clear" };
}

function parseSecretConfigOperations(
  value: unknown
): ProviderSecretConfigOperation[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error("secretConfigOperations must be an array");
  }
  if (value.length > MAX_SECRET_CONFIG_OPERATIONS) {
    throw new Error(
      `secretConfigOperations must contain ${MAX_SECRET_CONFIG_OPERATIONS} items or fewer`
    );
  }
  const seen = new Set<string>();
  return value.map((raw, index) => {
    const operation = asRecord(raw);
    if (!operation) {
      throw new Error(`secretConfigOperations[${index}] must be an object`);
    }
    if (
      !Array.isArray(operation.path) ||
      operation.path.length < 1 ||
      operation.path.length > 6 ||
      operation.path.some((segment) => typeof segment !== "string")
    ) {
      throw new Error(
        `secretConfigOperations[${index}].path must contain 1 to 6 string segments`
      );
    }
    const path = operation.path as string[];
    path.forEach((segment, pathIndex) =>
      assertSafeProviderConfigKey(
        segment,
        `secretConfigOperations[${index}].path[${pathIndex}]`
      )
    );
    if (!path.some(isSecretConfigKey)) {
      throw new Error(
        `secretConfigOperations[${index}].path must identify a protected config field`
      );
    }
    const protectedIndex = path.findIndex(isSecretConfigKey);
    const protectedContainer = path[protectedIndex]
      .replace(/[_-]/g, "")
      .toLowerCase();
    if (
      protectedIndex < path.length - 1 &&
      protectedContainer !== "extraheaders"
    ) {
      throw new Error(
        `secretConfigOperations[${index}].path cannot descend below a scalar protected field`
      );
    }
    const pathKey = JSON.stringify(path);
    if (seen.has(pathKey)) {
      throw new Error(`secretConfigOperations contains duplicate path ${path.join(".")}`);
    }
    seen.add(pathKey);

    const action = operation.action;
    if (action !== "preserve" && action !== "replace" && action !== "clear") {
      throw new Error(
        `secretConfigOperations[${index}].action must be preserve, replace, or clear`
      );
    }
    if (action === "replace") {
      if (protectedContainer === "extraheaders" && protectedIndex === path.length - 1) {
        throw new Error(
          `secretConfigOperations[${index}] must replace an individual extraHeaders entry`
        );
      }
      if (typeof operation.value !== "string" || !operation.value.trim()) {
        throw new Error(
          `secretConfigOperations[${index}].value is required for replace`
        );
      }
      const replacement = operation.value.trim();
      if (replacement.length > MAX_SECRET_VALUE_LENGTH) {
        throw new Error(
          `secretConfigOperations[${index}].value must be ${MAX_SECRET_VALUE_LENGTH} characters or fewer`
        );
      }
      return { path, action, value: replacement };
    }
    if (operation.value !== undefined) {
      throw new Error(
        `secretConfigOperations[${index}].value must be omitted for ${action}`
      );
    }
    return { path, action };
  });
}

function parseRefreshInterval(value: unknown, fallback = 60): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error("refreshIntervalMin must be an integer");
  }
  if (parsed < 1 || parsed > MAX_REFRESH_INTERVAL_MIN) {
    throw new Error(
      `refreshIntervalMin must be between 1 and ${MAX_REFRESH_INTERVAL_MIN}`
    );
  }
  return parsed;
}

function parseNullableNumber(
  value: unknown,
  field: string,
  integer = false
): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;

  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${field} must be a number`);
  }
  if (parsed < 0) {
    throw new Error(`${field} cannot be negative`);
  }
  if (integer && !Number.isInteger(parsed)) {
    throw new Error(`${field} must be an integer`);
  }

  return parsed;
}

function parseNullableDate(value: unknown, field: string): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string") throw new Error(`${field} must be a date string`);

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${field} must be a valid date`);
  }

  return parsed;
}

function parseProviderPlanInput(value: unknown): ProviderPlanInput | undefined {
  if (value === undefined || value === null) return undefined;

  const body = asRecord(value);
  if (!body) throw new Error("plan must be an object");

  const plan: ProviderPlanInput = {};

  if (body.billingMode !== undefined) {
    if (typeof body.billingMode !== "string" || !BILLING_MODES.has(body.billingMode)) {
      throw new Error("billingMode must be actual, estimated, or manual");
    }
    plan.billingMode = body.billingMode as ProviderPlanInput["billingMode"];
  }

  const fixedMonthlyCostUsd = parseNullableNumber(
    body.fixedMonthlyCostUsd,
    "fixedMonthlyCostUsd"
  );
  if (fixedMonthlyCostUsd !== undefined) {
    plan.fixedMonthlyCostUsd = fixedMonthlyCostUsd;
  }

  const monthlyBudgetUsd = parseNullableNumber(
    body.monthlyBudgetUsd,
    "monthlyBudgetUsd"
  );
  if (monthlyBudgetUsd !== undefined) {
    plan.monthlyBudgetUsd = monthlyBudgetUsd;
  }

  const monthlyRequestLimit = parseNullableNumber(
    body.monthlyRequestLimit,
    "monthlyRequestLimit",
    true
  );
  if (monthlyRequestLimit !== undefined) {
    plan.monthlyRequestLimit = monthlyRequestLimit;
  }

  const lowBalanceUsd = parseNullableNumber(body.lowBalanceUsd, "lowBalanceUsd");
  if (lowBalanceUsd !== undefined) {
    plan.lowBalanceUsd = lowBalanceUsd;
  }

  const lowCredits = parseNullableNumber(body.lowCredits, "lowCredits");
  if (lowCredits !== undefined) {
    plan.lowCredits = lowCredits;
  }

  const renewalDate = parseNullableDate(body.renewalDate, "renewalDate");
  if (renewalDate !== undefined) {
    plan.renewalDate = renewalDate;
  }

  if (body.billingInterval !== undefined) {
    if (body.billingInterval === null || body.billingInterval === "") {
      plan.billingInterval = null;
    } else if (
      typeof body.billingInterval !== "string" ||
      !BILLING_INTERVALS.has(body.billingInterval as (typeof SUBSCRIPTION_INTERVALS)[number])
    ) {
      throw new Error("billingInterval must be weekly, monthly, quarterly, or annual");
    } else {
      plan.billingInterval = body.billingInterval;
    }
  }

  if (body.mustKeepFunded !== undefined) {
    if (typeof body.mustKeepFunded !== "boolean") {
      throw new Error("mustKeepFunded must be a boolean");
    }
    plan.mustKeepFunded = body.mustKeepFunded;
  }

  if (body.notes !== undefined) {
    plan.notes = cleanNullableString(body.notes) ?? null;
  }

  return plan;
}

function parseAllocationsInput(value: unknown): { projectId: string; percentage: number }[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error("allocations must be an array");

  let totalPercentage = 0;
  const seenProjectIds = new Set<string>();
  const allocations = value.map((a, index) => {
    if (!a || typeof a !== "object") throw new Error(`allocations[${index}] must be an object`);
    
    const obj = a as Record<string, unknown>;
    const projectId = cleanOptionalString(obj.projectId);
    if (!projectId) throw new Error(`allocations[${index}].projectId must be a non-empty string`);
    if (seenProjectIds.has(projectId)) {
      throw new Error(`allocations contains duplicate projectId ${projectId}`);
    }
    seenProjectIds.add(projectId);
    
    const percentage = typeof obj.percentage === "number" ? obj.percentage : Number(obj.percentage);
    if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
      throw new Error(`allocations[${index}].percentage must be a number between 0 and 100`);
    }

    totalPercentage += percentage;
    return { projectId, percentage };
  });

  if (allocations.length > 0 && totalPercentage > 100) {
    throw new Error("sum of allocation percentages cannot exceed 100");
  }

  return allocations;
}

export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    const record = asRecord(body);
    if (!record) throw new Error("Request body must be a JSON object");
    return record;
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error("Invalid JSON request body");
  }
}

export function parseProviderCreateInput(body: Record<string, unknown>): ProviderInput {
  const name = cleanOptionalString(body.name);
  const displayName = cleanOptionalString(body.displayName);
  const type = cleanOptionalString(body.type) ?? "builtin";

  if (!name || !displayName) {
    throw new Error("name and displayName are required");
  }

  let config: Record<string, unknown> | undefined;
  if (body.config !== undefined) {
    config = normalizeProviderConfigInput(body.config);
  }
  if (body.apiKeyAction !== undefined || body.secretConfigOperations !== undefined) {
    throw new Error(
      "apiKeyAction and secretConfigOperations are only supported when updating a provider"
    );
  }

  return {
    name: name.toLowerCase(),
    displayName,
    type,
    apiKey: parseApiKeyValue(body.apiKey, false),
    config,
    refreshIntervalMin: parseRefreshInterval(body.refreshIntervalMin),
    groupId: cleanOptionalString(body.groupId),
    label: cleanOptionalString(body.label),
    plan: parseProviderPlanInput(body.plan),
    allocations: parseAllocationsInput(body.allocations),
  };
}

export function parseProviderUpdateInput(
  body: Record<string, unknown>
): ProviderUpdateInput {
  const update: ProviderUpdateInput = {
    apiKeyOperation: parseApiKeyOperation(body),
  };

  if (body.displayName !== undefined) {
    const displayName = cleanOptionalString(body.displayName);
    if (!displayName) throw new Error("displayName cannot be empty");
    update.displayName = displayName;
  }

  if (body.config !== undefined) {
    if (body.config === null) {
      update.config = null;
    } else {
      update.config = normalizeProviderConfigInput(body.config);
    }
  }

  update.secretConfigOperations = parseSecretConfigOperations(
    body.secretConfigOperations
  );
  if (update.config === null && update.secretConfigOperations?.length) {
    throw new Error(
      "secretConfigOperations cannot be combined with config: null (which clears all config)"
    );
  }

  if (body.isActive !== undefined) {
    if (typeof body.isActive !== "boolean") {
      throw new Error("isActive must be a boolean");
    }
    update.isActive = body.isActive;
  }

  if (body.refreshIntervalMin !== undefined) {
    update.refreshIntervalMin = parseRefreshInterval(body.refreshIntervalMin);
  }

  if (body.groupId !== undefined) {
    update.groupId = cleanNullableString(body.groupId) ?? null;
  }

  if (body.label !== undefined) {
    update.label = cleanNullableString(body.label) ?? null;
  }

  if (body.plan !== undefined) {
    update.plan = parseProviderPlanInput(body.plan);
  }

  if (body.allocations !== undefined) {
    update.allocations = parseAllocationsInput(body.allocations);
  }

  return update;
}
