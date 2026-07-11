import crypto from "crypto";

const MAX_EVENTS = 100;
const MAX_METADATA_KEYS = 50;
const MAX_METADATA_STRING_LENGTH = 500;
// 100 events * 50 metadata entries * (80-byte key + 500-byte value), plus
// event fields and JSON framing, fits below 4 MiB. The route enforces this
// before decoding so the parser's field limits cannot be bypassed with a huge
// body that is mostly discarded after allocation.
export const MAX_USAGE_TELEMETRY_BODY_BYTES = 4 * 1024 * 1024;

const metricTypes = new Set(["usage", "cost", "quota", "tier", "health", "balance", "limit", "quota_sync", "credit_balance", "subscription"]);
const units = new Set([
  "request",
  "call",
  "token",
  "credit",
  "usd",
  "page",
  "job",
  "document",
  "row",
  "byte",
]);
const billingModes = new Set(["actual", "estimated", "manual"]);
const confidences = new Set(["actual", "estimated", "manual"]);
const limitWindows = new Set(["minute", "day", "month", "run"]);

export interface ParsedUsageTelemetryEvent {
  sourceApp: string;
  environment?: string;
  provider: string;
  service?: string;
  // Producer-supplied project name/key. Resolved to a Project.id at ingest
  // (see project-resolver.ts). Deliberately NOT part of the idempotency basis
  // — the derived-key algorithm is a byte-for-byte contract shared with the
  // congress-trading-shared package, so adding a field would rekey every
  // existing event. Two events identical except for `project` therefore share
  // a key; that collision is acceptable versus breaking cross-app dedupe.
  project?: string;
  label?: string;
  keyRef?: string;
  billingMode: string;
  metricType: string;
  quantity?: number;
  unit?: string;
  costUsd?: number;
  requests?: number;
  credits?: number;
  limit?: number;
  limitWindow?: string;
  tier?: string;
  confidence: string;
  windowStart?: Date;
  windowEnd?: Date;
  occurredAt: Date;
  metadata?: Record<string, string | number | boolean | null>;
  idempotencyKey: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a JSON object");
  }
  return value as Record<string, unknown>;
}

function readString(
  record: Record<string, unknown>,
  key: string,
  options: { required?: boolean; max?: number } = {}
): string | undefined {
  const raw = record[key];
  if (raw == null || raw === "") {
    if (options.required) throw new Error(`${key} is required`);
    return undefined;
  }
  if (typeof raw !== "string") throw new Error(`${key} must be a string`);
  const value = raw.trim();
  if (!value) {
    if (options.required) throw new Error(`${key} is required`);
    return undefined;
  }
  if (options.max && value.length > options.max) {
    throw new Error(`${key} must be ${options.max} characters or fewer`);
  }
  return value;
}

function readEnum(
  record: Record<string, unknown>,
  key: string,
  allowed: Set<string>,
  fallback: string
): string {
  const value = readString(record, key, { max: 80 });
  if (value == null) return fallback;
  if (!allowed.has(value)) throw new Error(`${key} is not supported`);
  return value;
}

function readOptionalEnum(
  record: Record<string, unknown>,
  key: string,
  allowed: Set<string>
): string | undefined {
  const value = readString(record, key, { max: 80 });
  if (value == null) return undefined;
  if (!allowed.has(value)) throw new Error(`${key} is not supported`);
  return value;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const raw = record[key];
  if (raw == null || raw === "") return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    throw new Error(`${key} must be a non-negative finite number`);
  }
  return raw;
}

function readInteger(record: Record<string, unknown>, key: string): number | undefined {
  const value = readNumber(record, key);
  if (value == null) return undefined;
  if (!Number.isInteger(value)) throw new Error(`${key} must be an integer`);
  return value;
}

function readDate(record: Record<string, unknown>, key: string): Date | undefined {
  const value = readString(record, key, { max: 80 });
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${key} must be an ISO date`);
  return date;
}

function readMetadata(
  record: Record<string, unknown>
): Record<string, string | number | boolean | null> | undefined {
  const raw = record.metadata;
  if (raw == null) return undefined;
  const metadata = asRecord(raw);
  const entries = Object.entries(metadata).slice(0, MAX_METADATA_KEYS);
  const clean: Record<string, string | number | boolean | null> = {};

  for (const [key, value] of entries) {
    const cleanKey = key.trim().slice(0, 80);
    if (!cleanKey) continue;
    if (value == null || typeof value === "boolean") {
      clean[cleanKey] = value ?? null;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      clean[cleanKey] = value;
    } else if (typeof value === "string") {
      clean[cleanKey] = value.slice(0, MAX_METADATA_STRING_LENGTH);
    }
  }

  return Object.keys(clean).length ? clean : undefined;
}

// Length-prefixes each field before joining, so two fields that straddle a
// delimiter character (e.g. provider="b|c" + keyRef="" vs provider="b" +
// keyRef="c") can never hash to the same basis string. Each field is encoded
// as `<utf8-byte-length>:<value>` (a la netstrings), which is unambiguous
// because the length prefix tells the reader exactly where the value ends -
// no value can contain a byte sequence that gets misread as a boundary.
// CONTRACT: this MUST stay byte-for-byte identical to the client-side
// algorithm in the congress-trading-shared package's usageTelemetry.ts.
function encodeIdempotencyField(value: string): string {
  return `${Buffer.byteLength(value, "utf8")}:${value}`;
}

function deriveIdempotencyKey(
  record: Record<string, unknown>,
  resolved: {
    sourceApp: string;
    provider: string;
    metricType: string;
    keyRef?: string;
    environment?: string;
    service?: string;
    label?: string;
    quantity?: number;
    costUsd?: number;
    requests?: number;
    credits?: number;
  }
): string {
  const explicit = readString(record, "idempotencyKey", { max: 200 });
  if (explicit) return explicit;

  // CONTRACT: must stay byte-for-byte identical to
  // `@jaywedgeworth22/congress-trading-shared`'s deriveUsageTelemetryIdempotencyKey.
  // Basis = sourceApp + provider + metricType + keyRef + occurredAt (5 fields).
  // Distinct same-timestamp rows must send an explicit idempotencyKey from the
  // client — do not expand this basis without bumping both repos together.
  const rawOccurredAt = readString(record, "occurredAt", { max: 80 });
  if (rawOccurredAt) {
    const basisFields = [
      resolved.sourceApp,
      resolved.provider,
      resolved.metricType,
      resolved.keyRef ?? "",
      rawOccurredAt,
    ];
    return crypto
      .createHash("sha256")
      .update(basisFields.map(encodeIdempotencyField).join(""))
      .digest("hex");
  }

  // No stable basis to dedupe on (no explicit key, no occurredAt supplied) -
  // fall back to a random key, which means no idempotency guarantee for this event.
  return crypto.randomUUID();
}

function parseEvent(value: unknown): ParsedUsageTelemetryEvent {
  const record = asRecord(value);
  const occurredAt = readDate(record, "occurredAt") ?? new Date();
  const sourceApp = readString(record, "sourceApp", { required: true, max: 80 })!;
  const provider = readString(record, "provider", { required: true, max: 80 })!;
  const metricType = readEnum(record, "metricType", metricTypes, "usage");
  const keyRef = readString(record, "keyRef", { max: 160 });
  const environment = readString(record, "environment", { max: 80 });
  const service = readString(record, "service", { max: 120 });
  const label = readString(record, "label", { max: 160 });
  const quantity = readNumber(record, "quantity");
  const costUsd = readNumber(record, "costUsd");
  const requests = readInteger(record, "requests");
  const credits = readNumber(record, "credits");

  return {
    sourceApp,
    environment,
    provider,
    service,
    project: readString(record, "project", { max: 120 }),
    label,
    keyRef,
    billingMode: readEnum(record, "billingMode", billingModes, "estimated"),
    metricType,
    quantity,
    unit: readOptionalEnum(record, "unit", units),
    costUsd,
    requests,
    credits,
    limit: readNumber(record, "limit"),
    limitWindow: readOptionalEnum(record, "limitWindow", limitWindows),
    tier: readString(record, "tier", { max: 80 }),
    confidence: readEnum(record, "confidence", confidences, "estimated"),
    windowStart: readDate(record, "windowStart"),
    windowEnd: readDate(record, "windowEnd"),
    occurredAt,
    metadata: readMetadata(record),
    idempotencyKey: deriveIdempotencyKey(record, {
      sourceApp,
      provider,
      metricType,
      keyRef,
      environment,
      service,
      label,
      quantity,
      costUsd,
      requests,
      credits,
    }),
  };
}

export function parseUsageTelemetryBatch(value: unknown): ParsedUsageTelemetryEvent[] {
  const record = asRecord(value);
  const rawEvents = Array.isArray(record.events) ? record.events : [record];
  if (rawEvents.length === 0) throw new Error("events must not be empty");
  if (rawEvents.length > MAX_EVENTS) {
    throw new Error(`events must include ${MAX_EVENTS} or fewer items`);
  }
  return rawEvents.map(parseEvent);
}
