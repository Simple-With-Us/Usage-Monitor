import { z } from "zod";

import {
  PLAN_METADATA_STRING_LIMITS,
  quotaMetadataRecordSchema,
  truncatePlanText,
} from "@/lib/quota-plan-metadata";
import crypto from "crypto";
import {
  deriveUsageTelemetryV2IdempotencyKey,
  UsageTelemetryV2BatchSchema,
  UsageTelemetryV2EventSchema,
  type UsageTelemetryV2Batch,
} from "@jaywedgeworth22/congress-trading-shared";

import { AI_METADATA_KEY_LIST, canonicalAiMetadata } from "@/lib/ai-usage-metadata";
import { enrichQuotaIngestMetadata } from "@/lib/quota-ingest-metadata";

const MAX_EVENTS = 100;
const MAX_METADATA_KEYS = 50;
const MAX_METADATA_STRING_LENGTH = 500;
// These keys are monitor-owned persistence fields. Producer metadata must not
// be able to impersonate validated shared-contract fields, especially cost
// coverage authority consumed by money-path reporting.
const RESERVED_V2_METADATA_KEYS = new Set([
  "_usageTelemetrySchemaVersion",
  "_producerEventId",
  "_producerInstanceId",
  "_botFleetReceiptCredential",
  "_providerConnectionRef",
  "_billingAccountRef",
  "_coverageDeclared",
  "_coverageScope",
  "_coverageMode",
  "_coverageRelationship",
  "_coverageReportThrough",
  // Server-side LiteLLM cost-derivation stamps (pricing/derive-ingest-cost.ts).
  // Producers must not be able to forge a monitor-computed estimate.
  "_derivedCostUsd",
  "_derivedCostPricingKey",
  "_derivedCostSnapshot",
  "_derivedCostIncomplete",
  // Canonical AI usage (ai-usage-metadata.ts, UM-1592).  Set only from the
  // validated shared-contract `ai` block or the server-side legacy mapping,
  // because cost derivation prices from them.
  ...AI_METADATA_KEY_LIST,
]);
// 100 events * 50 metadata entries * (80-byte key + 500-byte value), plus
// the bounded plan-field exceptions, event fields and JSON framing, fits
// below 4 MiB.  The route enforces this
// before decoding so the parser's field limits cannot be bypassed with a huge
// body that is mostly discarded after allocation.
export const MAX_USAGE_TELEMETRY_BODY_BYTES = 4 * 1024 * 1024;
// Negative costUsd is scoped to metricType "subscription" (see readNumber's
// allowNegative use in parseEvent below), but any USAGE_INGEST_TOKEN holder
// can post that shape, and this monitor is single-owner with no per-caller
// scoping. An unbounded negative amount is unbounded spend-erasure / budget-
// alert suppression. Bound the magnitude a single manual/estimated correction
// event may carry. This is the maximum allowed magnitude, INCLUSIVE: exactly
// -MAX_NEGATIVE_SUBSCRIPTION_COST_USD is accepted, anything more negative is
// rejected. $1000 comfortably covers the largest realistic single Apple/App
// Store subscription-tier proration this owner-directed manual-adjustment
// channel is meant for, while bounding the blast radius of a leaked or
// misused token to a single ingest call.
export const MAX_NEGATIVE_SUBSCRIPTION_COST_USD = 1000;
// Aggregate companion to the per-event bound above: without it a single batch
// of MAX_EVENTS x -MAX_NEGATIVE_SUBSCRIPTION_COST_USD events (each
// individually legal) could erase $100,000 of reported spend in one call.
// Bound the SUM of negative subscription costUsd magnitudes across one parsed
// batch. Like the per-event bound this is INCLUSIVE: a batch summing to
// exactly -MAX_NEGATIVE_SUBSCRIPTION_BATCH_COST_USD is accepted, anything
// more negative rejects the whole batch. $2,000 covers every realistic
// multi-event manual correction (the largest real one to date summed
// -$123.31) while capping one call's erasure at 2x the per-event bound.
// Positive amounts and non-subscription metricTypes (which reject negatives
// per event anyway) never count toward the sum. A trailing-30-day cumulative
// bound backed by already-persisted rows lives in external-usage-events.ts
// (MAX_NEGATIVE_SUBSCRIPTION_WINDOW_COST_USD) — this one is pure parse-time.
export const MAX_NEGATIVE_SUBSCRIPTION_BATCH_COST_USD = 2000;
export const MAX_FUTURE_OCCURRED_AT_SKEW_MS = 5 * 60 * 1_000;

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

function cleanProducerMetadata(
  metadata: Record<string, unknown>
): Record<string, string | number | boolean | null> | undefined {
  const entries = Object.entries(metadata).slice(0, MAX_METADATA_KEYS);
  const clean: Record<string, string | number | boolean | null> = {};

  for (const [key, value] of entries) {
    // Code-point-safe like the values below: a producer key holding a lone
    // surrogate is persisted verbatim and JSON.stringify then emits it as an
    // escape Foundation's JSONDecoder rejects, costing the client the whole
    // usage-event payload.
    const cleanKey = truncatePlanText(key.trim(), 80);
    if (!cleanKey || RESERVED_V2_METADATA_KEYS.has(cleanKey)) continue;
    if (value == null || typeof value === "boolean") {
      clean[cleanKey] = value ?? null;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      clean[cleanKey] = value;
    } else if (typeof value === "string") {
      const bound = Object.hasOwn(PLAN_METADATA_STRING_LIMITS, cleanKey)
        ? PLAN_METADATA_STRING_LIMITS[cleanKey] : MAX_METADATA_STRING_LENGTH;
      clean[cleanKey] = truncatePlanText(value, bound);
    }
  }

  return Object.keys(clean).length ? clean : undefined;
}

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
  // Provider-side call/generation identifier (e.g. an OpenRouter completion
  // response's `id`), used by the monitor-side verification worker (a later
  // wave — see /Users/jay/apps/DESIGN-usage-compliance-classifier.md §3c).
  // Deliberately NOT part of the idempotency-key basis — see
  // deriveIdempotencyKey's CONTRACT comment below.
  providerRequestId?: string;
  idempotencyKey: string;
}

function v2Metadata(
  batch: UsageTelemetryV2Batch,
  event: UsageTelemetryV2Batch["events"][number]
): Record<string, string | number | boolean | null> | undefined {
  const producerMetadata = cleanProducerMetadata(event.metadata ?? {}) ?? {};
  const metadata: Record<string, string | number | boolean | null> = {
    ...producerMetadata,
    ...(canonicalAiMetadata({
      unit: event.unit,
      quantity: event.quantity,
      label: event.label,
      metadata: producerMetadata,
      ai: event.ai,
    }) ?? {}),
    _usageTelemetrySchemaVersion: 2,
    _producerEventId: event.eventId,
  };
  if (batch.producerInstanceId) metadata._producerInstanceId = batch.producerInstanceId;
  if (event.providerConnectionRef) metadata._providerConnectionRef = event.providerConnectionRef;
  if (event.billingAccountRef) metadata._billingAccountRef = event.billingAccountRef;
  if (event.coverage) {
    metadata._coverageDeclared = true;
    metadata._coverageScope = event.coverage.scope;
    metadata._coverageMode = event.coverage.mode;
    metadata._coverageRelationship = event.coverage.relationship;
    if (event.coverage.reportThrough) metadata._coverageReportThrough = event.coverage.reportThrough;
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

/** Parse the shared v2 wire authority into the monitor-owned persistence input. */

/**
 * One event-level validation failure inside an otherwise valid v2 batch.
 * `issues` is a bounded, human-readable summary (never the raw Zod blob).
 */
export interface UsageTelemetryV2EventRejection {
  index: number;
  eventId?: string;
  issues: string[];
}

export interface ParsedUsageTelemetryV2Batch {
  /** Valid events, in submission order, ready for persistence. */
  events: ParsedUsageTelemetryEvent[];
  /** Total number of rejected events (may exceed `rejections.length`). */
  rejected: number;
  /**
   * Per-event rejection detail, capped at MAX_V2_BATCH_REJECTIONS_REPORTED
   * entries so a fully poisoned batch cannot echo an unbounded response.
   */
  rejections: UsageTelemetryV2EventRejection[];
}

// Cap on the rejection detail echoed in the ACK body. The `rejected` COUNT is
// always exact; only the per-event detail array is bounded.
export const MAX_V2_BATCH_REJECTIONS_REPORTED = 10;

const MAX_V2_REJECTION_ISSUES_PER_EVENT = 5;

// A known-valid placeholder event used to validate the batch ENVELOPE
// (schemaVersion/producerId/producerInstanceId, plus strict-key checking)
// through the shared batch schema without also validating real events. This
// keeps envelope strictness byte-for-byte shared while letting individual
// events fail per-event validation below.
const V2_ENVELOPE_PROBE_EVENT = {
  eventId: "__usage_monitor_envelope_probe__",
  provider: "__usage_monitor_envelope_probe__",
} as const;

function summarizeV2Issues(error: {
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>;
}): string[] {
  return error.issues
    .slice(0, MAX_V2_REJECTION_ISSUES_PER_EVENT)
    .map((issue) =>
      `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`.slice(0, 200)
    );
}

function finalizeQuotaIngestEvent(
  event: ParsedUsageTelemetryEvent,
  options: { producerInstanceId?: string | null; ingestTime?: Date } = {},
): ParsedUsageTelemetryEvent {
  if (event.metricType !== "quota") return event;
  return {
    ...event,
    metadata: enrichQuotaIngestMetadata(event, options),
  };
}

// The shared v2 schema validates scalars but truncates every string at 500.
// Retain only the typed CodeCaps extension after that event passes validation.
// Match the shared first-50/key-normalization behavior, including collisions.

/** Raw inbound event carrying a validated record-shaped `metadata` field. */
const rawEventMetadataSchema = z
  .object({ metadata: quotaMetadataRecordSchema })
  .partial();

/**
 * The bounded plan-metadata extension that may merge back into the parsed
 * event.  Only these keys, as bounded strings, cross the boundary — anything
 * else fails validation and the optional extension is dropped, never the event.
 */
const planMetadataExtensionSchema = z
  .object({
    planDetectedName: z.string().max(PLAN_METADATA_STRING_LIMITS.planDetectedName),
    planUserName: z.string().max(PLAN_METADATA_STRING_LIMITS.planUserName),
    planUserCostUsd: z.string().max(PLAN_METADATA_STRING_LIMITS.planUserCostUsd),
    planUserRenewalDateText: z
      .string()
      .max(PLAN_METADATA_STRING_LIMITS.planUserRenewalDateText),
    planUserSubtitle: z.string().max(PLAN_METADATA_STRING_LIMITS.planUserSubtitle),
  })
  .partial();

// Not the trust boundary: `event` already passed UsageTelemetryV2EventSchema and
// `raw` is that same event's input, so a failed safeParse below is a defensive
// branch.  It degrades (the optional extension is dropped, the event is kept)
// instead of throwing: a throw would turn one odd metadata blob into a 400 for
// the whole batch and lose its billing events, and this module rejects bad
// events one at a time (see `rejections`), never by failing the batch.
function restoreBoundedPlanMetadata(
  event: UsageTelemetryV2Batch["events"][number],
  raw: unknown,
): UsageTelemetryV2Batch["events"][number] {
  const rawParsed = rawEventMetadataSchema.safeParse(raw);
  if (!rawParsed.success) return event;
  const metadata = rawParsed.data.metadata;
  if (!metadata) return event;
  const extension: Record<string, string> = {};
  for (const [rawKey, value] of Object.entries(metadata).slice(0, MAX_METADATA_KEYS)) {
    const key = truncatePlanText(rawKey.trim(), 80);
    const bound = Object.hasOwn(PLAN_METADATA_STRING_LIMITS, key)
      ? PLAN_METADATA_STRING_LIMITS[key] : undefined;
    if (bound === undefined) continue;
    if (typeof value === "string") extension[key] = truncatePlanText(value, bound);
    else delete extension[key];
  }
  // Only schema-validated values reach the persisted event.
  const parsed = planMetadataExtensionSchema.safeParse(extension);
  if (!parsed.success) return event;
  return { ...event, metadata: { ...event.metadata, ...parsed.data } };
}

async function mapV2Event(
  batch: UsageTelemetryV2Batch,
  event: UsageTelemetryV2Batch["events"][number],
  ingestTime = new Date(),
  rawEvent?: unknown,
): Promise<ParsedUsageTelemetryEvent> {
  event = restoreBoundedPlanMetadata(event, rawEvent);
  const occurredAt = event.occurredAt ? new Date(event.occurredAt) : ingestTime;
  return finalizeQuotaIngestEvent(
    {
      sourceApp: batch.producerId,
      environment: event.environment,
      provider: event.provider,
      service: event.service,
      project: event.project,
      label: event.label,
      keyRef: event.producerKeyRef,
      billingMode: event.billingMode,
      metricType: event.metricType,
      quantity: event.quantity,
      unit: event.unit,
      costUsd: event.costUsd,
      requests: event.requests,
      credits: event.credits,
      limit: event.limit,
      limitWindow: event.limitWindow,
      tier: event.tier,
      confidence: event.confidence,
      windowStart: event.windowStart ? new Date(event.windowStart) : undefined,
      windowEnd: event.windowEnd ? new Date(event.windowEnd) : undefined,
      occurredAt,
      metadata: v2Metadata(batch, event),
      providerRequestId: event.providerRequestId,
      idempotencyKey: await deriveUsageTelemetryV2IdempotencyKey({
        producerId: batch.producerId,
        eventId: event.eventId,
      }),
    },
    { producerInstanceId: batch.producerInstanceId, ingestTime },
  );
}

/**
 * Validates a v2 batch through the shared schema, per event. One poison event
 * no longer fails the whole batch: valid events are returned for persistence
 * and each invalid event is counted in `rejected` with bounded detail in
 * `rejections`, so the route can ACK `rejected: N` (X5). ENVELOPE failures
 * (bad/missing producerId, wrong schemaVersion, non-array events, unknown
 * top-level keys) still throw, preserving the route's 400 invalid_request.
 */
function isFutureOccurredAt(occurredAtIso?: string, now = Date.now()): boolean {
  if (!occurredAtIso) return false;
  const date = new Date(occurredAtIso);
  return !Number.isNaN(date.getTime()) && date.getTime() > now + MAX_FUTURE_OCCURRED_AT_SKEW_MS;
}

export async function parseUsageTelemetryV2Batch(
  value: unknown
): Promise<ParsedUsageTelemetryV2Batch> {
  const now = Date.now();
  // Fast path: the entire batch (envelope + every event) is valid.
  const whole = UsageTelemetryV2BatchSchema.safeParse(value);
  if (whole.success && !whole.data.events.some((e) => isFutureOccurredAt(e.occurredAt, now))) {
    return {
      events: await Promise.all(
        whole.data.events.map((event, index) => mapV2Event(
          whole.data, event, new Date(now), (value as { events: unknown[] }).events[index],
        ))
      ),
      rejected: 0,
      rejections: [],
    };
  }

  // The batch failed somewhere. Decide whether the failure is at the envelope
  // level (still a hard 400) or confined to individual events (per-event
  // rejection). The envelope probe runs the strict shared batch schema over
  // the same top-level fields with a known-valid placeholder event, so strict
  // unknown-key and producerId/schemaVersion checks are unchanged.
  const record = asRecord(value);
  const rawEvents = record.events;
  if (!Array.isArray(rawEvents) || rawEvents.length === 0) {
    throw new Error("Invalid usage telemetry v2 batch");
  }
  const { events: _events, ...envelope } = record;
  const probe = UsageTelemetryV2BatchSchema.safeParse({
    ...envelope,
    events: [V2_ENVELOPE_PROBE_EVENT],
  });
  if (!probe.success) {
    throw new Error("Invalid usage telemetry v2 batch");
  }

  const events: ParsedUsageTelemetryEvent[] = [];
  const rejections: UsageTelemetryV2EventRejection[] = [];
  let rejected = 0;
  for (let index = 0; index < rawEvents.length; index += 1) {
    const raw = rawEvents[index];
    const result = UsageTelemetryV2EventSchema.safeParse(raw);
    const isFuture = result.success && isFutureOccurredAt(result.data.occurredAt, now);
    if (!result.success || isFuture) {
      rejected += 1;
      if (rejections.length < MAX_V2_BATCH_REJECTIONS_REPORTED) {
        const rawEventId =
          raw && typeof raw === "object" && !Array.isArray(raw)
            ? (raw as { eventId?: unknown }).eventId
            : undefined;
        // Invert onto the discriminant so TS narrows result.error to ZodError:
        // isFuture is only ever true when result.success is true, so the two
        // orderings are equivalent.
        const issues = !result.success
          ? summarizeV2Issues(result.error)
          : ["occurredAt cannot be in the future"];
        rejections.push({
          index,
          ...(typeof rawEventId === "string" && rawEventId
            ? { eventId: rawEventId.slice(0, 200) }
            : {}),
          issues,
        });
      }
      continue;
    }
    events.push(await mapV2Event(probe.data, result.data, new Date(now), raw));
  }
  return { events, rejected, rejections };
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

function readNumber(
  record: Record<string, unknown>,
  key: string,
  options: { allowNegative?: boolean } = {}
): number | undefined {
  const raw = record[key];
  if (raw == null || raw === "") return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new Error(`${key} must be a finite number`);
  }
  if (!options.allowNegative && raw < 0) {
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
  record: Record<string, unknown>,
  event: { unit?: string; quantity?: number; label?: string } = {}
): Record<string, string | number | boolean | null> | undefined {
  const raw = record.metadata;
  if (raw == null) return undefined;
  const clean = cleanProducerMetadata(asRecord(raw));
  if (!clean) return undefined;
  // v1 events have no typed `ai` block; map their legacy token keys so they
  // aggregate and price the same way as v2 (UM-1592).
  const canonical = canonicalAiMetadata({ ...event, metadata: clean });
  return canonical ? { ...clean, ...canonical } : clean;
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
  if (occurredAt.getTime() > Date.now() + MAX_FUTURE_OCCURRED_AT_SKEW_MS) {
    throw new Error("occurredAt cannot be in the future");
  }
  const sourceApp = readString(record, "sourceApp", { required: true, max: 80 })!;
  const provider = readString(record, "provider", { required: true, max: 80 })!;
  const metricType = readEnum(record, "metricType", metricTypes, "usage");
  const keyRef = readString(record, "keyRef", { max: 160 });
  const environment = readString(record, "environment", { max: 80 });
  const service = readString(record, "service", { max: 120 });
  const label = readString(record, "label", { max: 160 });
  const quantity = readNumber(record, "quantity");
  // A negative costUsd is permitted ONLY for metricType "subscription", so a
  // manual pro-rated upgrade-refund (a real negative cash event) can be
  // recorded. Every other metricType — and every other numeric field, on
  // subscription events or otherwise — stays non-negative. See
  // subscription-charge-identity.ts / receipt-cash.ts for why this cannot
  // become a receipt-cash-shaped event or a forged materializer charge.
  const costUsd = readNumber(record, "costUsd", {
    allowNegative: metricType === "subscription",
  });
  // Bound the magnitude of a permitted negative subscription costUsd (see
  // MAX_NEGATIVE_SUBSCRIPTION_COST_USD's doc comment above). Positive amounts,
  // and every other metricType (already rejected above for any negative
  // value), are unaffected.
  if (
    metricType === "subscription" &&
    costUsd != null &&
    costUsd < -MAX_NEGATIVE_SUBSCRIPTION_COST_USD
  ) {
    throw new Error(
      `costUsd must not be more negative than -${MAX_NEGATIVE_SUBSCRIPTION_COST_USD} for metricType "subscription"`
    );
  }
  const requests = readInteger(record, "requests");
  const credits = readNumber(record, "credits");
  const unit = readOptionalEnum(record, "unit", units);

  return finalizeQuotaIngestEvent({
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
    unit,
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
    metadata: readMetadata(record, { unit, quantity, label }),
    // NOT included in the idempotency-key basis below — see the field's
    // CONTRACT comment on ParsedUsageTelemetryEvent and on
    // deriveIdempotencyKey. A producer resending the same logical event with
    // providerRequestId newly available (or omitted) must not change the key.
    providerRequestId: readString(record, "providerRequestId", { max: 200 }),
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
  });
}

export function parseUsageTelemetryBatch(value: unknown): ParsedUsageTelemetryEvent[] {
  const record = asRecord(value);
  const rawEvents = Array.isArray(record.events) ? record.events : [record];
  if (rawEvents.length === 0) throw new Error("events must not be empty");
  if (rawEvents.length > MAX_EVENTS) {
    throw new Error(`events must include ${MAX_EVENTS} or fewer items`);
  }
  const events = rawEvents.map(parseEvent);
  // Per-batch aggregate bound on negative subscription costUsd (see
  // MAX_NEGATIVE_SUBSCRIPTION_BATCH_COST_USD's doc comment above). Enforced
  // after per-event parsing so every event has already passed the per-event
  // magnitude bound; rejects the WHOLE batch, same as any other parse error.
  const negativeSubscriptionUsd = events.reduce(
    (sum, event) =>
      event.metricType === "subscription" &&
      event.costUsd != null &&
      event.costUsd < 0
        ? sum + -event.costUsd
        : sum,
    0
  );
  if (negativeSubscriptionUsd > MAX_NEGATIVE_SUBSCRIPTION_BATCH_COST_USD) {
    throw new Error(
      `combined negative subscription costUsd magnitude must not exceed ` +
        `${MAX_NEGATIVE_SUBSCRIPTION_BATCH_COST_USD} per batch ` +
        `(batch sums to -${negativeSubscriptionUsd.toFixed(2)})`
    );
  }
  return events;
}
