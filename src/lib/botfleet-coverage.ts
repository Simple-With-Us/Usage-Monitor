import { prisma } from "@/lib/prisma";
import type { ParsedUsageTelemetryEvent } from "@/lib/usage-telemetry";
import {
  LAUNCHER_METADATA_KEY,
  SESSION_ID_METADATA_KEY,
  readMetadataString,
} from "@/lib/telemetry-correlation";

/**
 * BotFleet-vs-child coverage.
 *
 * BotFleet drives other harnesses (Claude Code, Codex, opencode, mcode, …) and
 * reports each settled turn under producer `botfleet`.  The child harness also
 * writes its own store, and that harness's local collector reads it, so the
 * same turn can arrive twice under two producers.  Ingest idempotency is
 * producer-scoped and cannot collapse the pair.
 *
 * The owner's rule is "duplicates over loss": a child row is dropped only when
 * it is PROVABLY covered.  The proof is exact, never a timing guess:
 *
 *   - the collector recognised the session as BotFleet-launched and tagged it
 *     (`agent.launcher = "botfleet"`) with the harness's own session id
 *     (`session.id`), and
 *   - a `botfleet` turn the monitor already stored names that same child
 *     session (`childSessionId`) and the child row falls inside that turn
 *     (`turnStartedAt` .. the turn's settle time, with a small margin).
 *
 * Anything short of that is kept: an untagged child, a BotFleet turn without a
 * child session id or start time, a turn that reported no usage, or a child
 * row that arrives before BotFleet reported its turn.  Those stay as
 * duplicates, which the owner prefers to a hole in the ledger.
 *
 * OFF BY DEFAULT (BOTFLEET_CHILD_COVERAGE_DROP=1 turns it on).  Same session
 * and same time is still not proof that BotFleet billed a given call: the
 * Claude CLI can run a turn of its own inside a BotFleet turn (a background
 * task notification), and BotFleet discards that turn's usage.  Until BotFleet
 * names the exact calls it billed, every tagged row is kept; the tag alone
 * lets a reader separate the two producers exactly.
 */

export function botFleetCoverageDropEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.BOTFLEET_CHILD_COVERAGE_DROP === "1";
}

export const BOTFLEET_SOURCE_APP = "botfleet";
export const BOTFLEET_LAUNCHER = "botfleet";

/** Metadata keys a BotFleet turn event carries (BotFleet server/telemetry.ts). */
export const BOTFLEET_CHILD_SESSION_KEY = "childSessionId";
export const BOTFLEET_TURN_STARTED_KEY = "turnStartedAt";

/** Rounding margin around a BotFleet turn.  The child's timestamps and
 *  BotFleet's come from the same machine's clock, so this only absorbs
 *  millisecond rounding; a wider margin would reach calls outside the turn. */
export const BOTFLEET_TURN_MARGIN_MS = 2_000;

/** The longest BotFleet turn the lookup considers.  A turn's event is stored
 *  at its settle time, which can be well after the child calls it covers. */
export const BOTFLEET_MAX_TURN_MS = 12 * 60 * 60 * 1000;

/** Lookup chunk, for the same reason as native-telemetry-coverage.ts: no
 *  single query walks a multi-day range while holding the ingest lease. */
const LOOKUP_CHUNK_MS = 6 * 60 * 60 * 1000;

export function isBotFleetTaggedChildEvent(
  event: Pick<ParsedUsageTelemetryEvent, "sourceApp" | "metadata">
): boolean {
  if (event.sourceApp === BOTFLEET_SOURCE_APP) return false;
  if (readMetadataString(event.metadata, LAUNCHER_METADATA_KEY) !== BOTFLEET_LAUNCHER) return false;
  return !!readMetadataString(event.metadata, SESSION_ID_METADATA_KEY);
}

export interface BotFleetTurnSpan {
  childSessionId: string;
  startMs: number;
  endMs: number;
}

/** The child-session span a stored BotFleet turn covers, or null when the
 *  turn does not name its child session and start time, or billed nothing.
 *  A failed or unreported turn (usageReported false, a usageGap, quantity 0)
 *  covers no call: the child's rows are then the only record of that usage. */
export function botFleetTurnSpan(row: {
  occurredAt: Date;
  metadata: unknown;
  quantity?: number | null;
}): BotFleetTurnSpan | null {
  const meta =
    row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
      ? (row.metadata as Record<string, unknown>)
      : null;
  if (!meta || meta.usageReported !== true || meta.usageGap != null) return null;
  if (!(typeof row.quantity === "number" && row.quantity > 0)) return null;
  const childSessionId = readMetadataString(row.metadata, BOTFLEET_CHILD_SESSION_KEY);
  const startedAt = readMetadataString(row.metadata, BOTFLEET_TURN_STARTED_KEY);
  if (!childSessionId || !startedAt) return null;
  const startMs = Date.parse(startedAt);
  const endMs = row.occurredAt.getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > endMs) return null;
  if (endMs - startMs > BOTFLEET_MAX_TURN_MS) return null;
  return {
    childSessionId,
    startMs: startMs - BOTFLEET_TURN_MARGIN_MS,
    endMs: endMs + BOTFLEET_TURN_MARGIN_MS,
  };
}

export interface BotFleetCoverageResult {
  events: ParsedUsageTelemetryEvent[];
  /** How many tagged child events a stored BotFleet turn already covers. */
  skippedBotFleetCovered: number;
}

/** Drop the tagged child events a stored BotFleet turn provably covers. */
export async function dropEventsCoveredByBotFleet(
  events: ParsedUsageTelemetryEvent[],
  env: Record<string, string | undefined> = process.env
): Promise<BotFleetCoverageResult> {
  if (!botFleetCoverageDropEnabled(env)) return { events, skippedBotFleetCovered: 0 };
  const tagged = events.filter(isBotFleetTaggedChildEvent);
  if (tagged.length === 0) return { events, skippedBotFleetCovered: 0 };

  const sessions = new Set(
    tagged.map((event) => readMetadataString(event.metadata, SESSION_ID_METADATA_KEY)!)
  );
  const times = tagged.map((event) => event.occurredAt.getTime());
  const fromMs = Math.min(...times) - BOTFLEET_TURN_MARGIN_MS;
  // A turn is stored at its settle time, which is at or after every child
  // call it covers, so the lookup reaches forward by the longest turn.
  const toMs = Math.max(...times) + BOTFLEET_MAX_TURN_MS + BOTFLEET_TURN_MARGIN_MS;

  const spans = new Map<string, BotFleetTurnSpan[]>();
  for (let cursor = fromMs; cursor <= toMs; cursor += LOOKUP_CHUNK_MS) {
    const chunkTo = Math.min(cursor + LOOKUP_CHUNK_MS, toMs);
    const rows = await prisma.externalUsageEvent.findMany({
      where: {
        sourceApp: BOTFLEET_SOURCE_APP,
        // Half-open chunks, so a row on a boundary is read once.
        occurredAt: { gte: new Date(cursor), ...(chunkTo < toMs ? { lt: new Date(chunkTo) } : { lte: new Date(chunkTo) }) },
      },
      select: { occurredAt: true, metadata: true, quantity: true },
    });
    for (const row of rows) {
      const span = botFleetTurnSpan(row);
      if (!span || !sessions.has(span.childSessionId)) continue;
      const list = spans.get(span.childSessionId) ?? [];
      list.push(span);
      spans.set(span.childSessionId, list);
    }
  }
  if (spans.size === 0) return { events, skippedBotFleetCovered: 0 };

  let skippedBotFleetCovered = 0;
  const kept = events.filter((event) => {
    if (!isBotFleetTaggedChildEvent(event)) return true;
    const sessionId = readMetadataString(event.metadata, SESSION_ID_METADATA_KEY)!;
    const at = event.occurredAt.getTime();
    const covered = (spans.get(sessionId) ?? []).some((span) => at >= span.startMs && at <= span.endMs);
    if (covered) skippedBotFleetCovered += 1;
    return !covered;
  });
  return { events: kept, skippedBotFleetCovered };
}
