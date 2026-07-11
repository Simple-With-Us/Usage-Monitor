const MS_PER_MINUTE = 60 * 1000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;

export const REQUEST_WINDOWS = [
  "calendar_month_to_date",
  "calendar_day_to_date",
  "rolling_30_days",
  "rolling_31_days",
  "minute",
  "provider_defined",
  "billing_cycle_to_date",
  "unknown",
] as const;

export type RequestWindow = (typeof REQUEST_WINDOWS)[number];

export interface RequestProvenance {
  requestUnit?: string | null;
  requestWindow?: string | null;
  requestWindowStart?: Date | string | null;
  requestWindowEnd?: Date | string | null;
}

export interface MonthlyRequestCompatibility {
  compatible: boolean;
  explanation: string;
}

function cleanWindow(value: unknown): string {
  return typeof value === "string"
    ? value.trim().toLowerCase().replace(/[\s-]+/g, "_")
    : "";
}

export function normalizeRequestWindow(value: unknown): RequestWindow {
  switch (cleanWindow(value)) {
    case "month":
    case "monthly":
    case "calendar_month":
    case "calendar_month_to_date":
      return "calendar_month_to_date";
    case "day":
    case "daily":
    case "calendar_day":
    case "calendar_day_to_date":
      return "calendar_day_to_date";
    case "30d":
    case "rolling_30d":
    case "rolling_30_days":
      return "rolling_30_days";
    case "31d":
    case "rolling_31d":
    case "rolling_31_days":
      return "rolling_31_days";
    case "minute":
    case "per_minute":
      return "minute";
    case "provider_defined":
    case "provider_defined_credit_window":
    case "run":
      return "provider_defined";
    case "billing_cycle":
    case "billing_cycle_to_date":
      return "billing_cycle_to_date";
    default:
      return "unknown";
  }
}

export function requestWindowLabel(value: unknown): string {
  switch (normalizeRequestWindow(value)) {
    case "calendar_month_to_date":
      return "current UTC calendar month-to-date";
    case "calendar_day_to_date":
      return "current UTC day-to-date";
    case "rolling_30_days":
      return "rolling 30 days";
    case "rolling_31_days":
      return "rolling 31 days";
    case "minute":
      return "a per-minute rate-limit window";
    case "provider_defined":
      return "a provider-defined window";
    case "billing_cycle_to_date":
      return "a provider billing cycle-to-date";
    case "unknown":
      return "an unknown window";
  }
}

export function parseRequestBoundary(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function deriveRequestWindowBounds(
  window: RequestWindow,
  now = new Date()
): { start: Date | null; end: Date | null } {
  switch (window) {
    case "calendar_month_to_date":
      return {
        start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
        end: now,
      };
    case "calendar_day_to_date":
      return {
        start: new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
        ),
        end: now,
      };
    case "rolling_30_days":
      return { start: new Date(now.getTime() - 30 * MS_PER_DAY), end: now };
    case "rolling_31_days":
      return { start: new Date(now.getTime() - 31 * MS_PER_DAY), end: now };
    case "minute":
      return { start: new Date(now.getTime() - MS_PER_MINUTE), end: now };
    default:
      return { start: null, end: null };
  }
}

export function evaluateMonthlyRequestCompatibility(
  provenance: RequestProvenance,
  now = new Date()
): MonthlyRequestCompatibility {
  const unit = provenance.requestUnit?.trim();
  if (!unit) {
    return {
      compatible: false,
      explanation: "the request-count unit is unknown",
    };
  }

  const window = normalizeRequestWindow(provenance.requestWindow);
  if (
    window !== "calendar_month_to_date" &&
    window !== "billing_cycle_to_date"
  ) {
    return {
      compatible: false,
      explanation: `the count covers ${requestWindowLabel(window)}`,
    };
  }

  const start = parseRequestBoundary(provenance.requestWindowStart);
  const end = parseRequestBoundary(provenance.requestWindowEnd);
  if (!start || !end || end.getTime() < start.getTime()) {
    return {
      compatible: false,
      explanation: "the current-month window boundaries are missing or invalid",
    };
  }

  const expectedStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const clockSkewAllowanceMs = 5 * MS_PER_MINUTE;
  if (window === "billing_cycle_to_date") {
    if (
      start.getTime() > now.getTime() ||
      now.getTime() - start.getTime() > 32 * MS_PER_DAY ||
      end.getTime() < expectedStart ||
      end.getTime() > now.getTime() + clockSkewAllowanceMs
    ) {
      return {
        compatible: false,
        explanation: "the count does not cover the current monthly billing cycle-to-date",
      };
    }
    return {
      compatible: true,
      explanation: "the count covers the current monthly billing cycle-to-date",
    };
  }

  if (
    start.getTime() !== expectedStart ||
    end.getTime() < expectedStart ||
    end.getTime() > now.getTime() + clockSkewAllowanceMs
  ) {
    return {
      compatible: false,
      explanation: "the count does not cover the current UTC calendar month-to-date",
    };
  }

  return {
    compatible: true,
    explanation: "the count covers the current UTC calendar month-to-date",
  };
}
