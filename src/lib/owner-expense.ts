import crypto from "crypto";
import type { Prisma } from "@prisma/client";
import { persistExternalUsageEvents } from "@/lib/external-usage-events";
import { bustBudgetStatusCache } from "@/lib/budget-status";
import { prisma } from "@/lib/prisma";

export const OWNER_EXPENSE_SOURCE_APP = "owner-recorded-expense";

export const OWNER_EXPENSE_KINDS = ["subscription", "prepaid", "usage", "one_time"] as const;
export type OwnerExpenseKind = (typeof OWNER_EXPENSE_KINDS)[number];

export interface OwnerExpenseInput {
  provider: string;
  amountUsd: number;
  occurredAt: Date;
  kind: OwnerExpenseKind;
  label: string;
  notes?: string;
  confidence: "actual" | "estimated";
  receiptInboxId?: string;
  dueDate?: string;
  nextDueDate?: string;
  cancelledNoRenew?: boolean;
  calendarSort?: "subscription" | "prepaid" | "usage" | "dev-expense";
}

export interface RecordedOwnerExpense {
  persisted: number;
  idempotencyKey: string;
  provider: string;
  amountUsd: number;
  occurredAt: string;
  kind: OwnerExpenseKind;
  /** True when the entry was held for review instead of posting. */
  quarantined?: boolean;
  /**
   * True when the entry's idempotency key is tombstoned — the expense was
   * posted before and then deleted by the owner (UM-1659), so a replay or
   * re-forward of the same receipt records nothing.  Distinct from a plain
   * idempotency replay (the row still exists) and from the duplicate
   * quarantine (a different row matched).
   */
  tombstoned?: boolean;
  /** Quarantine row id (present only when quarantined). */
  quarantineId?: string;
  /** The posted rows this entry matched (present only when quarantined). */
  matchedEntries?: DuplicateMatch[];
  /** Human-readable why-held reason (present only when quarantined). */
  matchReason?: string;
}

/** A posted ledger row that an incoming expense exactly duplicates. */
export interface DuplicateMatch {
  idempotencyKey: string;
  provider: string;
  amountUsd: number | null;
  occurredAt: string;
  label: string | null;
  /** Which criterion matched. */
  matchedOn: "vendor_amount_date" | "receipt_inbox_id" | "vendor_amount_near_date";
}

const MAX_AMOUNT_USD = 5_000;
const RECEIPT_ID_PATTERN = /^[0-9a-f]{64}$/;
// Candidate scan window around the incoming charge date.  Matching itself is
// exact (same UTC day), so this only bounds the query; the ledger is small
// and this keeps the duplicate check to one indexed range scan.
const DUPLICATE_SCAN_WINDOW_DAYS = 7;
// Forward-copy tolerance (days).  Jay's standing rule forwards every receipt
// found in Gmail/iCloud scans to no-reply@receipts.jays.services for R2
// archival, so the intake regularly files agent-forwarded copies of receipts
// that are already posted.  When such a copy is recorded from the inbox
// review flow (receiptInboxId present) its charge date may skew a few days
// from the original posting (the dashboard form defaults an empty Date to
// today).  A ±3 day tolerance catches those; genuine monthly renewals are
// ~30 days apart and can never false-hold.
const NEAR_DATE_TOLERANCE_DAYS = 3;

function toCents(value: number): number {
  return Math.round(value * 100);
}

function utcDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function rowReceiptInboxId(metadata: unknown): string | undefined {
  if (metadata && typeof metadata === "object") {
    const value = (metadata as Record<string, unknown>).receiptInboxId;
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function toDuplicateMatch(
  row: {
    idempotencyKey: string;
    provider: string;
    costUsd: number | null;
    occurredAt: Date;
    label?: string | null;
  },
  matchedOn: DuplicateMatch["matchedOn"]
): DuplicateMatch {
  return {
    idempotencyKey: row.idempotencyKey,
    provider: row.provider,
    amountUsd: row.costUsd,
    occurredAt: row.occurredAt.toISOString(),
    label: row.label ?? null,
    matchedOn,
  };
}

/**
 * Pure duplicate predicate over one posted row.  An "exact duplicate" is:
 *   1. the same receipt inbox id (when the incoming entry carries one), or
 *   2. same vendor (case-insensitive) + same amount (exact cents) + same
 *      charge date (UTC day), or
 *   3. same vendor + same amount + charge date within ±3 days, but ONLY for
 *      inbox-sourced posts (receiptInboxId present) — the agent-forwarded
 *      archival-copy path, where the recorded date may skew a few days from
 *      the original posting.  Monthly renewals (~30 days apart) are outside
 *      the tolerance and never hold.
 * Label, kind, notes, and due dates are deliberately NOT part of the
 * criteria — the Oct 6 doubles arrived with different labels for the same
 * purchase, which is exactly what this guardrail must catch.
 */
export function isDuplicateOwnerExpense(
  input: OwnerExpenseInput,
  row: {
    idempotencyKey: string;
    provider: string;
    costUsd: number | null;
    occurredAt: Date;
    label?: string | null;
    metadata?: unknown;
  }
): DuplicateMatch | null {
  if (row.idempotencyKey === ownerExpenseIdempotencyKey(input)) return null;
  if (
    input.receiptInboxId &&
    rowReceiptInboxId(row.metadata) === input.receiptInboxId
  ) {
    return toDuplicateMatch(row, "receipt_inbox_id");
  }
  const sameVendor =
    row.provider.trim().toLowerCase() === input.provider.trim().toLowerCase();
  const sameAmount =
    row.costUsd != null && toCents(row.costUsd) === toCents(input.amountUsd);
  if (!sameVendor || !sameAmount) return null;
  if (utcDay(row.occurredAt) === utcDay(input.occurredAt)) {
    return toDuplicateMatch(row, "vendor_amount_date");
  }
  // Forward-copy tolerance: only for posts recorded from the inbox review
  // flow, where agent-forwarded archival copies of already-posted receipts
  // arrive with a possibly-skewed charge date.
  if (input.receiptInboxId) {
    const skewDays =
      Math.abs(row.occurredAt.getTime() - input.occurredAt.getTime()) /
      (24 * 60 * 60 * 1000);
    if (skewDays <= NEAR_DATE_TOLERANCE_DAYS) {
      return toDuplicateMatch(row, "vendor_amount_near_date");
    }
  }
  return null;
}

export function duplicateMatchReason(
  input: OwnerExpenseInput,
  match: DuplicateMatch
): string {
  const amount =
    match.amountUsd != null ? `$${match.amountUsd.toFixed(2)}` : "$—";
  const day = utcDay(new Date(match.occurredAt));
  const label = match.label ? ` (“${match.label}”)` : "";
  if (match.matchedOn === "receipt_inbox_id") {
    return (
      `Same receipt inbox id ${input.receiptInboxId} already posted as ` +
      `${match.provider} ${amount} on ${day}${label}.`
    );
  }
  if (match.matchedOn === "vendor_amount_near_date") {
    return (
      `Same vendor and amount posted within ${NEAR_DATE_TOLERANCE_DAYS} days ` +
      `of the charge date (likely an agent-forwarded archival copy): ` +
      `${match.provider} ${amount} on ${day}${label}.`
    );
  }
  return (
    `Same vendor, amount, and charge date already posted: ${match.provider} ` +
    `${amount} on ${day}${label}.`
  );
}

/**
 * Find posted owner-expense rows that exactly duplicate the incoming entry.
 * One bounded range query (±7 days around the charge date); all matching is
 * exact and done in JS so SQLite's lack of case-insensitive filters and JSON
 * path quirks can't change the semantics.
 *
 * The receipt-inbox-id check is UNCONDITIONAL: an agent-forwarded archival
 * copy may carry a charge date far from the original posting, so when the
 * incoming entry carries a receiptInboxId the date bound is lifted.
 */
export async function findDuplicateOwnerExpenses(
  input: OwnerExpenseInput
): Promise<DuplicateMatch[]> {
  const dayStart = new Date(`${utcDay(input.occurredAt)}T00:00:00.000Z`);
  const from = new Date(
    dayStart.getTime() - DUPLICATE_SCAN_WINDOW_DAYS * 24 * 60 * 60 * 1000
  );
  const to = new Date(
    dayStart.getTime() + (DUPLICATE_SCAN_WINDOW_DAYS + 1) * 24 * 60 * 60 * 1000
  );
  const rows = await prisma.externalUsageEvent.findMany({
    where: {
      sourceApp: OWNER_EXPENSE_SOURCE_APP,
      // Lift the date bound for the inbox-id check: that match must be
      // unconditional, not limited to the scan window.
      ...(input.receiptInboxId ? {} : { occurredAt: { gte: from, lt: to } }),
    },
    select: {
      idempotencyKey: true,
      provider: true,
      costUsd: true,
      occurredAt: true,
      label: true,
      metadata: true,
    },
  });
  const matches: DuplicateMatch[] = [];
  for (const row of rows) {
    const match = isDuplicateOwnerExpense(input, row);
    if (match) matches.push(match);
  }
  return matches;
}

async function quarantineOwnerExpense(
  input: OwnerExpenseInput,
  matches: DuplicateMatch[]
): Promise<string> {
  const reasons = matches.map((match) => duplicateMatchReason(input, match));
  const row = await prisma.quarantinedOwnerExpense.create({
    data: {
      provider: input.provider,
      amountUsd: input.amountUsd,
      occurredAt: input.occurredAt,
      kind: input.kind,
      label: input.label,
      notes: input.notes ?? null,
      confidence: input.confidence,
      receiptInboxId: input.receiptInboxId ?? null,
      dueDate: input.dueDate ?? null,
      nextDueDate: input.nextDueDate ?? null,
      calendarSort: input.calendarSort ?? null,
      cancelledNoRenew: input.cancelledNoRenew === true,
      matchedEntries: JSON.stringify(matches),
      matchReason: reasons.join(" "),
    },
    select: { id: true },
  });
  return row.id;
}

function isOwnerExpenseKind(value: string): value is OwnerExpenseKind {
  return (OWNER_EXPENSE_KINDS as readonly string[]).includes(value);
}

export function parseOwnerExpenseInput(body: unknown): OwnerExpenseInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Body must be a JSON object");
  }
  const record = body as Record<string, unknown>;
  const provider =
    typeof record.provider === "string" ? record.provider.trim() : "";
  if (!provider || provider.length > 80) {
    throw new Error("provider must be 1-80 characters");
  }
  const amountUsd = record.amountUsd;
  if (typeof amountUsd !== "number" || !Number.isFinite(amountUsd)) {
    throw new Error("amountUsd must be a finite number");
  }
  if (amountUsd === 0 || Math.abs(amountUsd) > MAX_AMOUNT_USD) {
    throw new Error(`amountUsd must be non-zero and at most $${MAX_AMOUNT_USD}`);
  }
  const kind = typeof record.kind === "string" ? record.kind.trim() : "";
  if (!isOwnerExpenseKind(kind)) {
    throw new Error('kind must be "subscription", "prepaid", "usage", or "one_time"');
  }
  const label = typeof record.label === "string" ? record.label.trim() : "";
  if (!label || label.length > 160) {
    throw new Error("label must be 1-160 characters");
  }
  const notes =
    typeof record.notes === "string" && record.notes.trim().length > 0
      ? record.notes.trim()
      : undefined;
  if (notes && notes.length > 500) {
    throw new Error("notes must be at most 500 characters");
  }
  const confidence =
    record.confidence === "estimated" || record.confidence === "actual"
      ? record.confidence
      : "actual";
  const occurredAt = new Date(String(record.occurredAt ?? ""));
  if (
    typeof record.occurredAt !== "string" ||
    Number.isNaN(occurredAt.getTime()) ||
    occurredAt.toISOString() !== record.occurredAt
  ) {
    throw new Error("occurredAt must be a canonical ISO timestamp");
  }
  const receiptInboxId =
    typeof record.receiptInboxId === "string" && record.receiptInboxId.length > 0
      ? record.receiptInboxId.trim()
      : undefined;
  if (receiptInboxId && !RECEIPT_ID_PATTERN.test(receiptInboxId)) {
    throw new Error("receiptInboxId must be a 64-hex inbox id");
  }
  const dueDate = isoDay(record.dueDate);
  const nextDueDate = isoDay(record.nextDueDate);
  const calendarSort = parseCalendarSort(record.calendarSort);
  return {
    provider,
    amountUsd,
    occurredAt,
    kind,
    label,
    notes,
    confidence,
    receiptInboxId,
    dueDate: dueDate ?? undefined,
    nextDueDate: nextDueDate ?? undefined,
    cancelledNoRenew: record.cancelledNoRenew === true,
    calendarSort,
  };
}

function isoDay(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return value;
}

function parseCalendarSort(
  value: unknown
): OwnerExpenseInput["calendarSort"] {
  if (
    value === "subscription"
    || value === "prepaid"
    || value === "usage"
    || value === "dev-expense"
  ) {
    return value;
  }
  return undefined;
}

export function ownerExpenseIdempotencyKey(input: OwnerExpenseInput): string {
  const digest = crypto
    .createHash("sha256")
    .update(
      [
        "owner-recorded-expense:v1",
        input.provider.toLowerCase(),
        input.kind,
        input.amountUsd.toFixed(6),
        input.occurredAt.toISOString(),
        input.label,
        input.receiptInboxId ?? "",
      ].join("\0")
    )
    .digest("hex");
  return `owner-recorded-expense:v1:${digest}`;
}

export interface RecordOwnerExpenseOptions {
  /**
   * Skip the duplicate quarantine (used when the owner explicitly resolves a
   * quarantined item as "post anyway").  The idempotency-key replay guard
   * still applies.
   */
  force?: boolean;
}

export async function recordOwnerExpense(
  input: OwnerExpenseInput,
  options: RecordOwnerExpenseOptions = {}
): Promise<RecordedOwnerExpense> {
  const idempotencyKey = ownerExpenseIdempotencyKey(input);
  const base = {
    idempotencyKey,
    provider: input.provider,
    amountUsd: input.amountUsd,
    occurredAt: input.occurredAt.toISOString(),
    kind: input.kind,
  };
  // Owner-deleted entries stay deleted (UM-1659): the delete path upserts an
  // ExternalUsageEventTombstone for the removed key, and a tombstoned key
  // records nothing — no post, no quarantine — whether the replay arrives as
  // a fresh POST, an inbox re-forward, or a "post anyway" resolve (force
  // bypasses only the duplicate quarantine, never the tombstone).  The
  // generic persist layer would skip the key anyway; checking here makes
  // the refusal visible to the caller instead of a silent persisted: 0.
  const tombstone = await prisma.externalUsageEventTombstone.findUnique({
    where: { idempotencyKey },
    select: { idempotencyKey: true },
  });
  if (tombstone) {
    return { ...base, persisted: 0, tombstoned: true };
  }
  // True replay under the same idempotency key: the existing persisted: 0
  // path.  This is not a suspected duplicate — nothing new is being
  // recorded — so it is never quarantined.
  const existing = await prisma.externalUsageEvent.findUnique({
    where: { idempotencyKey },
    select: { idempotencyKey: true },
  });
  if (existing) {
    return { ...base, persisted: 0 };
  }
  // Duplicate quarantine: hold suspected exact duplicates for owner review
  // instead of posting.  Never auto-posts, never alters posted rows.
  if (!options.force) {
    const matches = await findDuplicateOwnerExpenses(input);
    if (matches.length > 0) {
      const quarantineId = await quarantineOwnerExpense(input, matches);
      return {
        ...base,
        persisted: 0,
        quarantined: true,
        quarantineId,
        matchedEntries: matches,
        matchReason: matches
          .map((match) => duplicateMatchReason(input, match))
          .join(" "),
      };
    }
  }
  const result = await persistExternalUsageEvents([
    {
      idempotencyKey,
      sourceApp: OWNER_EXPENSE_SOURCE_APP,
      provider: input.provider,
      service: input.kind,
      label: input.label,
      billingMode: "manual",
      metricType: input.kind === "subscription" ? "subscription" : "cost",
      unit: "usd",
      costUsd: input.amountUsd,
      confidence: input.confidence,
      occurredAt: input.occurredAt,
      metadata: {
        ownerRecorded: true,
        kind: input.kind,
        ...(input.notes ? { notes: input.notes } : {}),
        ...(input.receiptInboxId ? { receiptInboxId: input.receiptInboxId } : {}),
        ...(input.dueDate ? { dueDate: input.dueDate } : {}),
        ...(input.nextDueDate ? { nextDueDate: input.nextDueDate } : {}),
        ...(input.cancelledNoRenew ? { cancelledNoRenew: true } : {}),
        ...(input.calendarSort ? { calendarSort: input.calendarSort } : {}),
      },
    },
  ]);
  bustBudgetStatusCache();
  return { ...base, persisted: result.persisted };
}

/**
 * Resolve a quarantined item.  "post" force-records the original input
 * (bypassing only the duplicate quarantine — the idempotency-key replay
 * guard still applies); "discard" drops it permanently.  Neither action
 * touches already-posted ledger rows.
 */
export async function resolveQuarantinedOwnerExpense(
  id: string,
  action: "post" | "discard"
): Promise<{ status: "posted" | "discarded"; record?: RecordedOwnerExpense }> {
  const item = await prisma.quarantinedOwnerExpense.findUnique({
    where: { id },
  });
  if (!item || item.status !== "held") {
    throw new Error("Quarantined expense not found or already resolved");
  }
  const input: OwnerExpenseInput = {
    provider: item.provider,
    amountUsd: item.amountUsd,
    occurredAt: item.occurredAt,
    kind: item.kind as OwnerExpenseKind,
    label: item.label,
    notes: item.notes ?? undefined,
    confidence: item.confidence === "estimated" ? "estimated" : "actual",
    receiptInboxId: item.receiptInboxId ?? undefined,
    dueDate: item.dueDate ?? undefined,
    nextDueDate: item.nextDueDate ?? undefined,
    cancelledNoRenew: item.cancelledNoRenew,
    calendarSort:
      item.calendarSort === "subscription"
      || item.calendarSort === "prepaid"
      || item.calendarSort === "usage"
      || item.calendarSort === "dev-expense"
        ? item.calendarSort
        : undefined,
  };
  let record: RecordedOwnerExpense | undefined;
  if (action === "post") {
    record = await recordOwnerExpense(input, { force: true });
  }
  await prisma.quarantinedOwnerExpense.update({
    where: { id },
    data: {
      status: action === "post" ? "posted" : "discarded",
      resolvedAt: new Date(),
    },
  });
  return { status: action === "post" ? "posted" : "discarded", record };
}

// ---------------------------------------------------------------------------
// Posted-expense management (UM-1659): list snapshots, delete with
// tombstones, edit with rekeying, and the owner-visible audit trail.
// ---------------------------------------------------------------------------

/** Spend category carried by the notes convention ("Category: Tech" etc.). */
export type OwnerExpenseCategory = "Tech" | "Other";

/**
 * Parse the category out of an expense's notes.  Owner recording convention:
 * notes begin with "Category: Tech" (business) or "Category: Other"
 * (personal); the older "Category: Personal" spelling is the same bucket as
 * Other.  Anything else (or no notes) is uncategorized.
 */
export function ownerExpenseCategory(
  notes: string | undefined | null
): OwnerExpenseCategory | null {
  if (!notes) return null;
  const match = /^\s*Category:\s*(Tech|Other|Personal)\b/i.exec(notes);
  if (!match) return null;
  return match[1].toLowerCase() === "tech" ? "Tech" : "Other";
}

/** The dashboard-facing shape of one posted owner expense. */
export interface OwnerExpenseSnapshot {
  idempotencyKey: string;
  vendor: string;
  amountUsd: number | null;
  occurredAt: string;
  kind: string;
  label: string | null;
  notes?: string;
  confidence: string;
  receiptInboxId?: string;
  dueDate?: string;
  nextDueDate?: string;
  calendarSort?: string;
  cancelledNoRenew: boolean;
  category: OwnerExpenseCategory | null;
}

interface OwnerExpenseRow {
  idempotencyKey: string;
  provider: string;
  service?: string | null;
  label: string | null;
  costUsd: number | null;
  confidence: string;
  occurredAt: Date;
  metadata: unknown;
}

const OWNER_EXPENSE_ROW_SELECT = {
  idempotencyKey: true,
  provider: true,
  service: true,
  label: true,
  costUsd: true,
  confidence: true,
  occurredAt: true,
  metadata: true,
} as const;

function metadataString(
  metadata: Record<string, unknown>,
  key: string
): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function snapshotOwnerExpenseRow(row: OwnerExpenseRow): OwnerExpenseSnapshot {
  const metadata =
    row.metadata && typeof row.metadata === "object"
      ? (row.metadata as Record<string, unknown>)
      : {};
  const notes = metadataString(metadata, "notes");
  return {
    idempotencyKey: row.idempotencyKey,
    vendor: row.provider,
    amountUsd: row.costUsd,
    occurredAt: row.occurredAt.toISOString(),
    kind: metadataString(metadata, "kind") ?? row.service ?? "one_time",
    label: row.label,
    notes,
    confidence: row.confidence,
    receiptInboxId: metadataString(metadata, "receiptInboxId"),
    dueDate: metadataString(metadata, "dueDate"),
    nextDueDate: metadataString(metadata, "nextDueDate"),
    calendarSort: metadataString(metadata, "calendarSort"),
    cancelledNoRenew: metadata.cancelledNoRenew === true,
    category: ownerExpenseCategory(notes),
  };
}

/** Snapshots are stored in OwnerExpenseAudit Json columns; round-tripping
 * through JSON both satisfies Prisma's InputJsonValue and guarantees the
 * stored shape is plain serializable data. */
function snapshotJson(snapshot: OwnerExpenseSnapshot): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(snapshot)) as Prisma.InputJsonValue;
}

function snapshotFromInput(
  input: OwnerExpenseInput,
  idempotencyKey: string
): OwnerExpenseSnapshot {
  return {
    idempotencyKey,
    vendor: input.provider,
    amountUsd: input.amountUsd,
    occurredAt: input.occurredAt.toISOString(),
    kind: input.kind,
    label: input.label,
    notes: input.notes,
    confidence: input.confidence,
    receiptInboxId: input.receiptInboxId,
    dueDate: input.dueDate,
    nextDueDate: input.nextDueDate,
    calendarSort: input.calendarSort,
    cancelledNoRenew: input.cancelledNoRenew === true,
    category: ownerExpenseCategory(input.notes),
  };
}

function inputFromRow(row: OwnerExpenseRow): OwnerExpenseInput {
  const metadata =
    row.metadata && typeof row.metadata === "object"
      ? (row.metadata as Record<string, unknown>)
      : {};
  const kind = metadataString(metadata, "kind") ?? row.service ?? "one_time";
  return {
    provider: row.provider,
    amountUsd: row.costUsd ?? 0,
    occurredAt: row.occurredAt,
    kind: isOwnerExpenseKind(kind) ? kind : "one_time",
    label: row.label ?? "",
    notes: metadataString(metadata, "notes"),
    confidence: row.confidence === "estimated" ? "estimated" : "actual",
    receiptInboxId: metadataString(metadata, "receiptInboxId"),
    dueDate: metadataString(metadata, "dueDate"),
    nextDueDate: metadataString(metadata, "nextDueDate"),
    cancelledNoRenew: metadata.cancelledNoRenew === true,
    calendarSort: parseCalendarSort(metadataString(metadata, "calendarSort")),
  };
}

export interface DeleteOwnerExpensesResult {
  requested: number;
  deleted: number;
  /** Deleted keys that received a tombstone (== deleted; kept explicit). */
  tombstoned: number;
  notFound: string[];
}

/**
 * Delete posted owner expenses by idempotency key, permanently (UM-1659).
 *
 * One transaction per call: for each found row, write the audit snapshot,
 * upsert an ExternalUsageEventTombstone (the resurrection guard — every
 * write path, including recordOwnerExpense and the generic ingest persist,
 * skips tombstoned keys), then delete the rows.  Rows are pinned to
 * sourceApp "owner-recorded-expense", so a key can never delete telemetry.
 */
export async function deleteOwnerExpenses(
  idempotencyKeys: string[]
): Promise<DeleteOwnerExpensesResult> {
  const keys = [...new Set(idempotencyKeys)];
  const result = await prisma.$transaction(async (tx) => {
    const rows = await tx.externalUsageEvent.findMany({
      where: {
        sourceApp: OWNER_EXPENSE_SOURCE_APP,
        idempotencyKey: { in: keys },
      },
      select: OWNER_EXPENSE_ROW_SELECT,
    });
    const found = new Set(rows.map((row) => row.idempotencyKey));
    for (const row of rows) {
      await tx.ownerExpenseAudit.create({
        data: {
          idempotencyKey: row.idempotencyKey,
          action: "delete",
          before: snapshotJson(snapshotOwnerExpenseRow(row)),
        },
      });
      await tx.externalUsageEventTombstone.upsert({
        where: { idempotencyKey: row.idempotencyKey },
        create: {
          idempotencyKey: row.idempotencyKey,
          occurredAt: row.occurredAt,
        },
        update: {},
      });
    }
    const deleted =
      rows.length > 0
        ? await tx.externalUsageEvent.deleteMany({
            where: {
              sourceApp: OWNER_EXPENSE_SOURCE_APP,
              idempotencyKey: { in: rows.map((row) => row.idempotencyKey) },
            },
          })
        : { count: 0 };
    return {
      requested: keys.length,
      deleted: deleted.count,
      tombstoned: rows.length,
      notFound: keys.filter((key) => !found.has(key)),
    };
  });
  if (result.deleted > 0) {
    bustBudgetStatusCache();
  }
  return result;
}

/**
 * Field updates for editOwnerExpense.  A field set to null clears it
 * (notes / receiptInboxId / dueDate / nextDueDate / calendarSort); an absent
 * field is left unchanged.
 */
export interface OwnerExpenseUpdates {
  provider?: string;
  amountUsd?: number;
  occurredAt?: string;
  kind?: string;
  label?: string;
  notes?: string | null;
  confidence?: string;
  receiptInboxId?: string | null;
  dueDate?: string | null;
  nextDueDate?: string | null;
  cancelledNoRenew?: boolean;
  calendarSort?: string | null;
}

export interface EditOwnerExpenseResult {
  expense: OwnerExpenseSnapshot;
  /** True when the edit changed key fields and the row was rekeyed. */
  rekeyed: boolean;
}

/**
 * Edit one posted owner expense (UM-1659).
 *
 * The merged values go through parseOwnerExpenseInput, so an edit can never
 * produce a row the recorder itself would reject.  When the edit changes a
 * key field (provider / kind / amount / occurredAt / label / receiptInboxId)
 * the row is rekeyed: the new key must not collide with another posted row
 * or with a tombstone, and the OLD key is tombstoned so a replay of the
 * pre-edit receipt cannot resurrect the pre-edit values.  The audit row
 * (before / after / resultingKey) is written in the same transaction.
 */
export async function editOwnerExpense(
  idempotencyKey: string,
  updates: OwnerExpenseUpdates
): Promise<EditOwnerExpenseResult> {
  const row = await prisma.externalUsageEvent.findFirst({
    where: { sourceApp: OWNER_EXPENSE_SOURCE_APP, idempotencyKey },
    select: OWNER_EXPENSE_ROW_SELECT,
  });
  if (!row) {
    throw new Error("Owner expense not found");
  }
  const current = inputFromRow(row);
  const merged = {
    provider: updates.provider ?? current.provider,
    amountUsd: updates.amountUsd ?? current.amountUsd,
    occurredAt: updates.occurredAt ?? current.occurredAt.toISOString(),
    kind: updates.kind ?? current.kind,
    label: updates.label ?? current.label,
    notes:
      updates.notes === null
        ? undefined
        : (updates.notes ?? current.notes),
    confidence: updates.confidence ?? current.confidence,
    receiptInboxId:
      updates.receiptInboxId === null
        ? undefined
        : (updates.receiptInboxId ?? current.receiptInboxId),
    dueDate:
      updates.dueDate === null
        ? undefined
        : (updates.dueDate ?? current.dueDate),
    nextDueDate:
      updates.nextDueDate === null
        ? undefined
        : (updates.nextDueDate ?? current.nextDueDate),
    cancelledNoRenew: updates.cancelledNoRenew ?? current.cancelledNoRenew,
    calendarSort:
      updates.calendarSort === null
        ? undefined
        : (updates.calendarSort ?? current.calendarSort),
  };
  const input = parseOwnerExpenseInput(merged);
  const newKey = ownerExpenseIdempotencyKey(input);
  const rekeyed = newKey !== idempotencyKey;
  if (rekeyed) {
    const collision = await prisma.externalUsageEvent.findUnique({
      where: { idempotencyKey: newKey },
      select: { idempotencyKey: true },
    });
    if (collision) {
      throw new Error(
        "Edit conflicts with another posted expense (same vendor, kind, amount, date, and label)"
      );
    }
    const tombstone = await prisma.externalUsageEventTombstone.findUnique({
      where: { idempotencyKey: newKey },
      select: { idempotencyKey: true },
    });
    if (tombstone) {
      throw new Error(
        "Edit conflicts with a deleted expense: the resulting values match an entry the owner deleted (tombstoned)"
      );
    }
  }
  const before = snapshotOwnerExpenseRow(row);
  const after = snapshotFromInput(input, newKey);
  await prisma.$transaction(async (tx) => {
    await tx.ownerExpenseAudit.create({
      data: {
        idempotencyKey,
        action: "edit",
        before: snapshotJson(before),
        after: snapshotJson(after),
        resultingKey: rekeyed ? newKey : null,
      },
    });
    if (rekeyed) {
      await tx.externalUsageEventTombstone.upsert({
        where: { idempotencyKey },
        create: { idempotencyKey, occurredAt: row.occurredAt },
        update: {},
      });
    }
    await tx.externalUsageEvent.update({
      where: { idempotencyKey },
      data: {
        idempotencyKey: newKey,
        provider: input.provider,
        service: input.kind,
        label: input.label,
        costUsd: input.amountUsd,
        confidence: input.confidence,
        occurredAt: input.occurredAt,
        metricType: input.kind === "subscription" ? "subscription" : "cost",
        metadata: {
          ownerRecorded: true,
          kind: input.kind,
          ...(input.notes ? { notes: input.notes } : {}),
          ...(input.receiptInboxId
            ? { receiptInboxId: input.receiptInboxId }
            : {}),
          ...(input.dueDate ? { dueDate: input.dueDate } : {}),
          ...(input.nextDueDate ? { nextDueDate: input.nextDueDate } : {}),
          ...(input.cancelledNoRenew ? { cancelledNoRenew: true } : {}),
          ...(input.calendarSort ? { calendarSort: input.calendarSort } : {}),
        },
      },
    });
  });
  bustBudgetStatusCache();
  return { expense: after, rekeyed };
}

export interface OwnerExpenseAuditEntry {
  id: string;
  idempotencyKey: string;
  action: string;
  before: OwnerExpenseSnapshot;
  after: OwnerExpenseSnapshot | null;
  resultingKey: string | null;
  createdAt: string;
}

/** Recent owner-expense management history, newest first (UM-1659). */
export async function listOwnerExpenseAudit(
  limit: number
): Promise<OwnerExpenseAuditEntry[]> {
  const rows = await prisma.ownerExpenseAudit.findMany({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
  });
  return rows.map((row) => ({
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    action: row.action,
    before: row.before as unknown as OwnerExpenseSnapshot,
    after: (row.after as unknown as OwnerExpenseSnapshot | null) ?? null,
    resultingKey: row.resultingKey,
    createdAt: row.createdAt.toISOString(),
  }));
}
