import { z } from "zod";

/**
 * Trust-boundary schemas for the owner-expense duplicate quarantine.
 *
 * The request schema guards POST /api/owner-expenses/quarantine before any
 * value reaches Prisma.  The response schemas are parsed by the dashboard
 * Receipt Inbox card (client side) instead of casting `response.json()`.
 * Response schemas are deliberately NOT strict: the routes return more
 * fields than the card reads, and zod's default object mode strips them.
 */

const QUARANTINE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const QUARANTINE_RESOLVE_BODY_ERROR =
  'Body must be { "id": "<uuid>", "action": "post" | "discard" }';

/** POST /api/owner-expenses/quarantine request body. */
export const QuarantineResolveSchema = z
  .object({
    id: z.string().regex(QUARANTINE_ID_RE),
    action: z.enum(["post", "discard"]),
  })
  .strict();

export type QuarantineResolveBody = z.infer<typeof QuarantineResolveSchema>;

const QuarantinedMatchSchema = z.object({
  idempotencyKey: z.string(),
  provider: z.string(),
  amountUsd: z.number().nullable(),
  occurredAt: z.string(),
  label: z.string().nullable(),
  matchedOn: z.string(),
});

export const QuarantinedExpenseSchema = z.object({
  id: z.string(),
  quarantinedAt: z.string(),
  provider: z.string(),
  amountUsd: z.number(),
  occurredAt: z.string(),
  kind: z.string(),
  label: z.string(),
  notes: z.string().nullable(),
  receiptInboxId: z.string().nullable(),
  matchedEntries: z.array(QuarantinedMatchSchema),
  matchReason: z.string(),
});

export type QuarantinedExpense = z.infer<typeof QuarantinedExpenseSchema>;

/** GET /api/owner-expenses/quarantine response. */
export const QuarantineListSchema = z.object({
  quarantined: z.array(QuarantinedExpenseSchema),
});

/** Error body shared by the owner-expense routes. */
export const OwnerExpenseErrorSchema = z.object({
  error: z.string(),
});

/** POST /api/owner-expenses/quarantine success response. */
export const QuarantineResolveResponseSchema = z.object({
  status: z.enum(["posted", "discarded"]),
  record: z.object({ persisted: z.number() }).optional(),
});

/** POST /api/owner-expenses response (201/200 recorded, 202 held). */
export const RecordOwnerExpenseResponseSchema = z.object({
  persisted: z.number(),
  quarantined: z.boolean().optional(),
  matchReason: z.string().optional(),
});
