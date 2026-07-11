export interface ProjectCreateInput {
  name: string;
  nameKey: string;
  description: string | null;
  monthlyBudgetUsd: number | null;
}

export interface ProjectUpdateInput {
  name?: string;
  nameKey?: string;
  description?: string | null;
  monthlyBudgetUsd?: number | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function requiredName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Project name is required");
  }
  const name = value.trim();
  if (name.length > 120) {
    throw new Error("Project name must be 120 characters or fewer");
  }
  return name;
}

function optionalDescription(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") {
    throw new Error("description must be a string");
  }
  const description = value.trim();
  if (description.length > 500) {
    throw new Error("description must be 500 characters or fewer");
  }
  return description || null;
}

function optionalBudget(value: unknown): number | null {
  if (value == null || value === "") return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error("monthlyBudgetUsd must be a non-negative finite number or null");
  }
  return value;
}

export function parseProjectCreateInput(value: unknown): ProjectCreateInput {
  const body = asRecord(value);
  const name = requiredName(body.name);
  return {
    name,
    nameKey: name.toLowerCase(),
    description: optionalDescription(body.description),
    monthlyBudgetUsd: optionalBudget(body.monthlyBudgetUsd),
  };
}

export function parseProjectUpdateInput(value: unknown): ProjectUpdateInput {
  const body = asRecord(value);
  const update: ProjectUpdateInput = {};
  if (body.name !== undefined) {
    update.name = requiredName(body.name);
    update.nameKey = update.name.toLowerCase();
  }
  if (body.description !== undefined) {
    update.description = optionalDescription(body.description);
  }
  if (body.monthlyBudgetUsd !== undefined) {
    update.monthlyBudgetUsd = optionalBudget(body.monthlyBudgetUsd);
  }
  return update;
}
