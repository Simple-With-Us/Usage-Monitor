export interface ProjectCreateInput {
  name: string;
  description: string | null;
  monthlyBudgetUsd: number | null;
}

export interface ProjectUpdateInput {
  name?: string;
  description?: string | null;
  monthlyBudgetUsd?: number | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function cleanString(value: unknown, field: string, max = 200, customRequiredMsg?: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(customRequiredMsg ?? `${field} is required`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) throw new Error(`${field} must be ${max} characters or fewer`);
  return trimmed;
}

function cleanNullableString(value: unknown, field: string, max = 500): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new Error(`${field} must be ${max} characters or fewer`);
  return trimmed;
}

function requireNonNegativeNumber(value: unknown, field: string, customErrorMsg?: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(customErrorMsg ?? `${field} must be a non-negative number`);
  }
  return parsed;
}

export function parseProjectCreateInput(body: unknown): ProjectCreateInput {
  const record = asRecord(body);
  const name = cleanString(record.name, "Project name", 200, "Project name is required");
  const description = cleanNullableString(record.description, "description", 500);

  let monthlyBudgetUsd: number | null = null;
  const rawBudget = record.monthlyBudgetUsd;
  if (rawBudget !== undefined && rawBudget !== null && rawBudget !== "") {
    monthlyBudgetUsd = requireNonNegativeNumber(
      rawBudget,
      "monthlyBudgetUsd",
      "monthlyBudgetUsd must be a positive number"
    );
  }

  return { name, description, monthlyBudgetUsd };
}

export function parseProjectUpdateInput(body: unknown): ProjectUpdateInput {
  const record = asRecord(body);
  const result: ProjectUpdateInput = {};

  if (record.name !== undefined) {
    result.name = cleanString(record.name, "name", 200, "name cannot be empty");
  }

  if (record.description !== undefined) {
    result.description = cleanNullableString(record.description, "description", 500);
  }

  if (record.monthlyBudgetUsd !== undefined) {
    const rawBudget = record.monthlyBudgetUsd;
    if (rawBudget === null || rawBudget === "") {
      result.monthlyBudgetUsd = null;
    } else {
      result.monthlyBudgetUsd = requireNonNegativeNumber(
        rawBudget,
        "monthlyBudgetUsd",
        "monthlyBudgetUsd must be a positive number"
      );
    }
  }

  return result;
}
