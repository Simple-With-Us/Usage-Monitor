import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { AiRequestInput } from "@/lib/otlp/ai-request-mapper";

// ---------------------------------------------------------------------------
// AiRequest persistence (UM-1590)
// ---------------------------------------------------------------------------
// Upsert on dedupeKey, filling only columns that are still null, so the
// Claude Code `api_request` log event and the `llm_request` trace span for
// the same request_id merge into one row whichever arrives first.
//
// Codex reports one call in two events: `codex.api_request` (duration to
// response headers, status) and, later, `codex.sse_event` response.completed
// (tokens, TTFT).  The api_request lands as a pending row; the completion
// attaches to the newest pending row of the same conversation within
// CODEX_STITCH_WINDOW_MS, sets occurredAt to the completion time and the
// duration to completion - request start.  A completion with no pending row
// is stored on its own.  A replayed completion is recognised by its exact
// (sessionId, occurredAt) on an already-completed row.
//
// Callers must hold the ingest admission token: rows are read then written.
// ---------------------------------------------------------------------------

const CODEX_STITCH_WINDOW_MS = 30 * 60_000;

const MERGEABLE_FIELDS = [
  "seat",
  "project",
  "billingMode",
  "sessionId",
  "requestedModel",
  "servedModel",
  "durationMs",
  "ttftMs",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "cacheWrite5mTokens",
  "cacheWrite1hTokens",
  "reasoningTokens",
  "costUsd",
  "costSource",
  "speed",
  "effort",
  "querySource",
  "statusCode",
  "error",
] as const;

type MergeableField = (typeof MERGEABLE_FIELDS)[number];
type AiRequestRow = Prisma.AiRequestGetPayload<object>;

export interface PersistAiRequestsResult {
  inserted: number;
  merged: number;
  duplicates: number;
}

function mergeSources(existing: string, source: string): string {
  const set = new Set(existing.split("+").filter(Boolean));
  set.add(source);
  return [...set].sort().join("+");
}

function createData(input: AiRequestInput): Prisma.AiRequestCreateInput {
  const data: Prisma.AiRequestCreateInput = {
    dedupeKey: input.dedupeKey,
    harness: input.harness,
    sources: input.source,
    occurredAt: input.occurredAt,
  };
  for (const field of MERGEABLE_FIELDS) {
    const value = input[field];
    if (value !== undefined) (data as Record<string, unknown>)[field] = value;
  }
  return data;
}

/** Fields of `input` that fill nulls on `existing`; empty when nothing changes. */
function coalesceUpdate(existing: AiRequestRow, input: AiRequestInput): Prisma.AiRequestUpdateInput {
  const update: Record<string, unknown> = {};
  for (const field of MERGEABLE_FIELDS) {
    const incoming = input[field as MergeableField];
    if (incoming !== undefined && existing[field as MergeableField] == null) update[field] = incoming;
  }
  const sources = mergeSources(existing.sources, input.source);
  if (sources !== existing.sources) update.sources = sources;
  return update as Prisma.AiRequestUpdateInput;
}

async function upsertCoalesce(input: AiRequestInput): Promise<"inserted" | "merged" | "duplicate"> {
  const existing = await prisma.aiRequest.findUnique({ where: { dedupeKey: input.dedupeKey } });
  if (existing) {
    const update = coalesceUpdate(existing, input);
    if (Object.keys(update).length === 0) return "duplicate";
    await prisma.aiRequest.update({ where: { id: existing.id }, data: update });
    return "merged";
  }
  try {
    await prisma.aiRequest.create({ data: createData(input) });
    return "inserted";
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      // Lost a race with another writer; fold into the row it created.
      const row = await prisma.aiRequest.findUnique({ where: { dedupeKey: input.dedupeKey } });
      if (!row) throw error;
      const update = coalesceUpdate(row, input);
      if (Object.keys(update).length === 0) return "duplicate";
      await prisma.aiRequest.update({ where: { id: row.id }, data: update });
      return "merged";
    }
    throw error;
  }
}

async function stitchCodexCompletion(input: AiRequestInput): Promise<"inserted" | "merged" | "duplicate"> {
  const byKey = await prisma.aiRequest.findUnique({ where: { dedupeKey: input.dedupeKey } });
  if (byKey) return upsertCoalesce(input);
  if (!input.sessionId) return upsertCoalesce(input);

  const replay = await prisma.aiRequest.findFirst({
    where: {
      harness: "codex",
      sessionId: input.sessionId,
      occurredAt: input.occurredAt,
      outputTokens: { not: null },
    },
    select: { id: true },
  });
  if (replay) return "duplicate";

  const pending = await prisma.aiRequest.findFirst({
    where: {
      harness: "codex",
      sessionId: input.sessionId,
      outputTokens: null,
      inputTokens: null,
      error: null,
      occurredAt: {
        gte: new Date(input.occurredAt.getTime() - CODEX_STITCH_WINDOW_MS),
        lte: input.occurredAt,
      },
    },
    orderBy: { occurredAt: "desc" },
  });
  if (!pending) return upsertCoalesce(input);

  // pending.occurredAt is when headers arrived; minus its duration is the start.
  const startMs = pending.occurredAt.getTime() - (pending.durationMs ?? 0);
  const totalMs = Math.max(0, input.occurredAt.getTime() - startMs);
  const update = coalesceUpdate(pending, { ...input, durationMs: undefined });
  await prisma.aiRequest.update({
    where: { id: pending.id },
    data: {
      ...update,
      durationMs: Math.min(totalMs, 2_147_483_647),
      occurredAt: input.occurredAt,
    },
  });
  return "merged";
}

export async function persistAiRequests(inputs: AiRequestInput[]): Promise<PersistAiRequestsResult> {
  const result: PersistAiRequestsResult = { inserted: 0, merged: 0, duplicates: 0 };
  // Oldest first, so a Codex api_request in the same batch precedes its completion.
  const ordered = [...inputs].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  for (const input of ordered) {
    const outcome =
      input.kind === "codex-completion" ? await stitchCodexCompletion(input) : await upsertCoalesce(input);
    if (outcome === "inserted") result.inserted += 1;
    else if (outcome === "merged") result.merged += 1;
    else result.duplicates += 1;
  }
  return result;
}
