import { SUBSCRIPTION_INTERVALS } from "@/lib/subscriptions";

export interface ProviderInput {
  name: string;
  displayName: string;
  type: ProviderType;
  apiKey?: string;
  config?: Record<string, unknown>;
  refreshIntervalMin: number;
  groupId?: string;
  label?: string;
  plan?: ProviderPlanInput;
  allocations?: { projectId: string; percentage: number }[];
}

export const PROVIDER_TYPES = ["builtin", "custom", "generic"] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

export interface ProviderUpdateInput {
  displayName?: string;
  apiKey?: string;
  config?: Record<string, unknown> | null;
  isActive?: boolean;
  refreshIntervalMin?: number;
  groupId?: string | null;
  label?: string | null;
  plan?: ProviderPlanInput;
  allocations?: { projectId: string; percentage: number }[];
}

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
const PROVIDER_TYPE_SET = new Set<string>(PROVIDER_TYPES);

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
  const rawType = cleanOptionalString(body.type) ?? "builtin";
  const type = rawType.toLowerCase();

  if (!name || !displayName) {
    throw new Error("name and displayName are required");
  }
  if (!PROVIDER_TYPE_SET.has(type)) {
    throw new Error(`type must be one of: ${PROVIDER_TYPES.join(", ")}`);
  }

  let config: Record<string, unknown> | undefined;
  if (body.config !== undefined) {
    const parsedConfig = asRecord(body.config);
    if (!parsedConfig) throw new Error("config must be an object");
    config = parsedConfig;
  }

  return {
    name: name.toLowerCase(),
    displayName,
    type: type as ProviderType,
    apiKey: cleanOptionalString(body.apiKey),
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
  const update: ProviderUpdateInput = {};

  if (body.displayName !== undefined) {
    const displayName = cleanOptionalString(body.displayName);
    if (!displayName) throw new Error("displayName cannot be empty");
    update.displayName = displayName;
  }

  if (body.apiKey !== undefined) {
    update.apiKey = cleanOptionalString(body.apiKey);
  }

  if (body.config !== undefined) {
    if (body.config === null) {
      update.config = null;
    } else {
      const config = asRecord(body.config);
      if (!config) throw new Error("config must be an object");
      update.config = config;
    }
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
