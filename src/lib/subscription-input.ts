import {
  initialCycle,
  isSubscriptionInterval,
  isSubscriptionStatus,
  type SubscriptionInterval,
  type SubscriptionStatus,
} from "@/lib/subscriptions";

// Validation/normalization for the subscription CRUD routes. Pure — foreign-key
// existence (providerId, projectId) is checked in the route against the DB.

export interface SubscriptionCreateInput {
  providerId: string;
  projectId: string | null;
  name: string;
  description: string | null;
  costUsd: number;
  currency: string;
  interval: SubscriptionInterval;
  intervalCount: number;
  anchorDay: number | null;
  startDate: Date;
  currentPeriodStart: Date;
  nextRenewalAt: Date;
  autoRenew: boolean;
  status: SubscriptionStatus;
  notes: string | null;
  // Env-var knob name -> string value implied by this plan tier, overriding
  // the provider's free-tier ProviderPlan.knobEnv when present. Null when the
  // caller didn't supply one (falls back to the provider's free tier).
  knobEnv: Record<string, string> | null;
}

// Fields a caller may change. Schedule fields (interval/intervalCount/anchorDay/
// startDate) are surfaced separately so the route can recompute the cycle only
// when one actually changes.
export interface SubscriptionUpdateInput {
  providerId?: string;
  projectId?: string | null;
  name?: string;
  description?: string | null;
  costUsd?: number;
  currency?: string;
  autoRenew?: boolean;
  status?: SubscriptionStatus;
  notes?: string | null;
  interval?: SubscriptionInterval;
  intervalCount?: number;
  anchorDay?: number | null;
  startDate?: Date;
  knobEnv?: Record<string, string> | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function cleanString(value: unknown, field: string, max = 200): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new Error(`${field} must be ${max} characters or fewer`);
  return trimmed;
}

function cleanNullableString(value: unknown, field: string, max = 500): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value.trim().slice(0, max);
}

function requireNonNegativeNumber(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${field} must be a non-negative number`);
  }
  return parsed;
}

function parseInterval(value: unknown): SubscriptionInterval {
  if (value === undefined || value === null || value === "") return "monthly";
  if (typeof value !== "string" || !isSubscriptionInterval(value)) {
    throw new Error("interval must be weekly, monthly, quarterly, or annual");
  }
  return value;
}

function parseIntervalCount(value: unknown): number {
  if (value === undefined || value === null || value === "") return 1;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 366) {
    throw new Error("intervalCount must be an integer between 1 and 366");
  }
  return parsed;
}

function parseAnchorDay(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 31) {
    throw new Error("anchorDay must be an integer between 1 and 31");
  }
  return parsed;
}

function parseDate(value: unknown, field: string, fallback: () => Date): Date {
  if (value === undefined || value === null || value === "") return fallback();
  if (typeof value !== "string") throw new Error(`${field} must be an ISO date string`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${field} must be a valid date`);
  return date;
}

function parseStatus(value: unknown): SubscriptionStatus {
  if (value === undefined || value === null || value === "") return "active";
  if (typeof value !== "string" || !isSubscriptionStatus(value)) {
    throw new Error("status must be active, paused, canceled, or considering");
  }
  return value;
}

function parseCurrency(value: unknown): "USD" {
  const currency = (cleanNullableString(value, "currency", 8) ?? "USD").toUpperCase();
  if (currency !== "USD") {
    throw new Error("currency must be USD until authoritative FX conversion is configured");
  }
  return "USD";
}

// A flat map of env-var knob name -> string value (e.g.
// {"PROVIDER_QUOTA_TIINGO_PER_HOUR": "10000"}). Every value must be a string
// so it round-trips directly into an env var — no numbers/booleans/nesting.
function parseKnobEnv(value: unknown, field: string): Record<string, string> | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be a JSON object mapping knob names to string values`);
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== "string") {
      throw new Error(`${field}.${key} must be a string value`);
    }
    result[key] = entry;
  }
  return result;
}

export function parseSubscriptionCreateInput(
  body: unknown,
  now: Date = new Date()
): SubscriptionCreateInput {
  const record = asRecord(body);

  const providerId = cleanString(record.providerId, "providerId");
  const name = cleanString(record.name, "name");
  const costUsd = requireNonNegativeNumber(record.costUsd, "costUsd");
  const interval = parseInterval(record.interval);
  const intervalCount = parseIntervalCount(record.intervalCount);
  const anchorDay = parseAnchorDay(record.anchorDay);
  const startDate = parseDate(record.startDate, "startDate", () => now);
  const projectId =
    record.projectId === undefined || record.projectId === null || record.projectId === ""
      ? null
      : cleanString(record.projectId, "projectId");

  const { currentPeriodStart, nextRenewalAt } = initialCycle({
    startDate,
    interval,
    intervalCount,
    anchorDay,
  });

  return {
    providerId,
    projectId,
    name,
    description: cleanNullableString(record.description, "description"),
    costUsd,
    currency: parseCurrency(record.currency),
    interval,
    intervalCount,
    anchorDay,
    startDate,
    currentPeriodStart,
    nextRenewalAt,
    autoRenew: record.autoRenew === undefined ? true : Boolean(record.autoRenew),
    status: parseStatus(record.status),
    notes: cleanNullableString(record.notes, "notes"),
    knobEnv: parseKnobEnv(record.knobEnv, "knobEnv"),
  };
}

export function parseSubscriptionUpdateInput(body: unknown): SubscriptionUpdateInput {
  const record = asRecord(body);
  const update: SubscriptionUpdateInput = {};

  if (record.providerId !== undefined) {
    update.providerId = cleanString(record.providerId, "providerId");
  }
  if (record.projectId !== undefined) {
    update.projectId =
      record.projectId === null || record.projectId === ""
        ? null
        : cleanString(record.projectId, "projectId");
  }
  if (record.name !== undefined) update.name = cleanString(record.name, "name");
  if (record.description !== undefined) {
    update.description = cleanNullableString(record.description, "description");
  }
  if (record.costUsd !== undefined) update.costUsd = requireNonNegativeNumber(record.costUsd, "costUsd");
  if (record.currency !== undefined) {
    update.currency = parseCurrency(record.currency);
  }
  if (record.autoRenew !== undefined) update.autoRenew = Boolean(record.autoRenew);
  if (record.status !== undefined) update.status = parseStatus(record.status);
  if (record.notes !== undefined) update.notes = cleanNullableString(record.notes, "notes");
  if (record.interval !== undefined) update.interval = parseInterval(record.interval);
  if (record.intervalCount !== undefined) update.intervalCount = parseIntervalCount(record.intervalCount);
  if (record.anchorDay !== undefined) update.anchorDay = parseAnchorDay(record.anchorDay);
  if (record.startDate !== undefined) {
    update.startDate = parseDate(record.startDate, "startDate", () => new Date());
  }
  if (record.knobEnv !== undefined) update.knobEnv = parseKnobEnv(record.knobEnv, "knobEnv");

  return update;
}
