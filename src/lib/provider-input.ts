import { SUBSCRIPTION_INTERVALS } from "@/lib/subscriptions";

export interface ProviderInput {
  name: string;
  displayName: string;
  type: string;
  apiKey?: string;
  config?: Record<string, unknown>;
  refreshIntervalMin: number;
  groupId?: string;
  billingAccountId?: string;
  label?: string;
  plan?: ProviderPlanInput;
  allocations?: { projectId: string; percentage: number }[];
}

export interface ProviderUpdateInput {
  displayName?: string;
  apiKey?: string | null;
  config?: Record<string, unknown> | null;
  secretConfigOperations?: ProviderSecretConfigOperationInput[];
  isActive?: boolean;
  refreshIntervalMin?: number;
  groupId?: string | null;
  billingAccountId?: string | null;
  label?: string | null;
  plan?: ProviderPlanInput;
  allocations?: { projectId: string; percentage: number }[];
}

export interface ProviderSecretConfigOperationInput {
  path: string[];
  action: "clear";
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
const GOOGLE_SERVICE_ACCOUNT_SECRET_PATH = "serviceAccountJson";
const MAX_BILLING_ACCOUNT_ID_LENGTH = 256;

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

function isSafePathSegment(segment: unknown): segment is string {
  if (typeof segment !== "string" || !segment) return false;
  if (segment === "__proto__" || segment === "constructor" || segment === "prototype") return false;
  return true;
}

function parseBillingAccountId(
  value: unknown
): string | null | undefined {
  const cleaned = cleanNullableString(value);
  if (cleaned == null) return cleaned;
  if (cleaned.length > MAX_BILLING_ACCOUNT_ID_LENGTH) {
    throw new Error(
      `billingAccountId must be at most ${MAX_BILLING_ACCOUNT_ID_LENGTH} characters`
    );
  }
  if (/\p{Cc}/u.test(cleaned)) {
    throw new Error("billingAccountId cannot contain control characters");
  }
  return cleaned;
}

function parseSecretConfigOperations(
  value: unknown
): ProviderSecretConfigOperationInput[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error("secretConfigOperations must be an array");
  }

  const seenPaths = new Set<string>();
  return value.map((raw, index) => {
    const operation = asRecord(raw);
    if (!operation) {
      throw new Error(`secretConfigOperations[${index}] must be an object`);
    }
    
    if (!Array.isArray(operation.path) || operation.path.length === 0) {
      throw new Error(`secretConfigOperations[${index}].path must be a non-empty array`);
    }
    
    for (const segment of operation.path) {
      if (!isSafePathSegment(segment)) {
        throw new Error(`secretConfigOperations[${index}] contains an unsafe or invalid path segment`);
      }
    }
    
    if (operation.action !== "clear") {
      throw new Error(
        `secretConfigOperations[${index}].action only supports clear`
      );
    }
    if (operation.value !== undefined) {
      throw new Error(
        `secretConfigOperations[${index}].value must be omitted for clear`
      );
    }
    
    const pathKey = JSON.stringify(operation.path);
    if (seenPaths.has(pathKey)) {
      throw new Error("secretConfigOperations contains a duplicate path");
    }
    seenPaths.add(pathKey);
    
    return {
      path: operation.path as string[],
      action: "clear" as const,
    };
  });
}

/**
 * Self-burning probe adapters (each poll costs quota). Floor refresh so a
 * mis-set 1-minute interval cannot burn the daily allowance (Wave E / E20).
 * Keys are provider `name` values (case-insensitive).
 */
export const SELF_BURNING_PROBE_MIN_REFRESH_MIN: Readonly<
  Record<string, number>
> = {
  twelvedata: 60,
  // Catalog name is `unusual-whales`; normalizeProbeKey strips separators.
  unusualwhales: 60,
};

/** Collapse case/separator differences so catalog names match floor keys. */
export function normalizeProbeProviderKey(providerName: string): string {
  return providerName.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function parseRefreshInterval(
  value: unknown,
  fallback = 60,
  providerName?: string
): number {
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
  const floorKey = providerName ? normalizeProbeProviderKey(providerName) : "";
  const floor = SELF_BURNING_PROBE_MIN_REFRESH_MIN[floorKey];
  if (floor != null && parsed < floor) {
    throw new Error(
      `refreshIntervalMin for ${floorKey} must be at least ${floor} minutes (each poll consumes provider quota)`
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
  const allocations = value.map((a, index) => {
    if (!a || typeof a !== "object") throw new Error(`allocations[${index}] must be an object`);
    
    const obj = a as Record<string, unknown>;
    const projectId = cleanOptionalString(obj.projectId);
    if (!projectId) throw new Error(`allocations[${index}].projectId must be a non-empty string`);
    
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
    const parsedConfig = asRecord(body.config);
    if (!parsedConfig) throw new Error("config must be an object");
    config = parsedConfig;
  }

  if (body.secretConfigOperations !== undefined) {
    throw new Error(
      "secretConfigOperations are only supported when updating a provider"
    );
  }

  return {
    name: name.toLowerCase(),
    displayName,
    type,
    apiKey: cleanOptionalString(body.apiKey),
    config,
    refreshIntervalMin: parseRefreshInterval(
      body.refreshIntervalMin,
      60,
      name
    ),
    groupId: cleanOptionalString(body.groupId),
    billingAccountId: parseBillingAccountId(body.billingAccountId) ?? undefined,
    label: cleanOptionalString(body.label),
    plan: parseProviderPlanInput(body.plan),
    allocations: parseAllocationsInput(body.allocations),
  };
}

export function parseProviderUpdateInput(
  body: Record<string, unknown>,
  /** Existing provider name for self-burning probe floors (Wave E / E20). */
  existingProviderName?: string
): ProviderUpdateInput {
  const update: ProviderUpdateInput = {};

  if (body.displayName !== undefined) {
    const displayName = cleanOptionalString(body.displayName);
    if (!displayName) throw new Error("displayName cannot be empty");
    update.displayName = displayName;
  }

  if (body.apiKey !== undefined) {
    if (body.apiKey === null || body.apiKey === "") {
      update.apiKey = null;
    } else {
      update.apiKey = cleanOptionalString(body.apiKey);
    }
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

  update.secretConfigOperations = parseSecretConfigOperations(
    body.secretConfigOperations
  );
  if (update.config === null && update.secretConfigOperations?.length) {
    throw new Error(
      "secretConfigOperations cannot be combined with config: null"
    );
  }

  if (body.isActive !== undefined) {
    if (typeof body.isActive !== "boolean") {
      throw new Error("isActive must be a boolean");
    }
    update.isActive = body.isActive;
  }

  if (body.refreshIntervalMin !== undefined) {
    update.refreshIntervalMin = parseRefreshInterval(
      body.refreshIntervalMin,
      60,
      existingProviderName
    );
  }

  if (body.groupId !== undefined) {
    update.groupId = cleanNullableString(body.groupId) ?? null;
  }

  if (body.billingAccountId !== undefined) {
    update.billingAccountId = parseBillingAccountId(body.billingAccountId) ?? null;
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
