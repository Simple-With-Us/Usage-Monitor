import { prisma } from "@/lib/prisma";
import type { ParsedUsageTelemetryEvent } from "@/lib/usage-telemetry";

/**
 * Native-vs-local coverage for a producer whose request-scoped telemetry can
 * arrive from two places at once.
 *
 * Claude Code's native OTLP exporter delivers `claude_code.token.usage` rows
 * (sourceApp "claude-code", unit "token") and its local transcripts under
 * `~/.claude/projects/**.jsonl` carry the same usage per request.  When the
 * native exporter is healthy both sources describe the same calls, so writing
 * both would double-count the owner's largest coding tool.
 *
 * The rule here is "native wins, local fills the gap": a transcript-sourced
 * event is dropped when the native feed delivered a token row close enough in
 * time to have covered that call.  When the native feed is dead (it stopped on
 * 2026-10-23, see docs/rollouts/2026-10-25-claude-code-telemetry-gap.md) no
 * native row exists near the event, so the transcript event is kept and the
 * gap is filled.
 *
 * The native feed exports on a 60 second cadence, so a five minute margin
 * around each event is a wide tolerance for a delayed export without letting
 * a dead native feed silently cover a later gap.
 */

/** How close a native token row must be to a transcript event to cover it. */
export const NATIVE_COVERAGE_WINDOW_MS = 5 * 60_000;

/** The metadata KEY a transcript-sourced event carries the marker under. */
export const TRANSCRIPT_COLLECTOR_KEY = "collector";

/** The metadata VALUE that marks an event as transcript-sourced. */
export const TRANSCRIPT_COLLECTOR_MARKER = "transcript";

/** The metadata key both feeds use to name the machine they came from. */
export const HOST_NAME_KEY = "host.name";

/** Producers where a native feed and a local transcript feed can coexist. */
const NATIVE_COVERAGE_PRODUCERS: ReadonlySet<string> = new Set(["claude-code"]);

/** Upper bound on the native rows pulled for one coverage decision. */
const MAX_NATIVE_ROWS = 500;

export function isTranscriptSourcedEvent(
  event: Pick<ParsedUsageTelemetryEvent, "sourceApp" | "metadata">
): boolean {
  if (!NATIVE_COVERAGE_PRODUCERS.has(event.sourceApp)) return false;
  return readTranscriptMarker(event.metadata) === TRANSCRIPT_COLLECTOR_MARKER;
}

/** Read the transcript marker out of a metadata bag of unknown shape. */
export function readTranscriptMarker(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const value = (metadata as Record<string, unknown>)[TRANSCRIPT_COLLECTOR_KEY];
  return typeof value === "string" ? value : undefined;
}

/**
 * Read the machine identity out of a metadata bag of unknown shape.
 *
 * The comparison is done on a normalized value: the OTLP resource attribute is
 * written by an operator (or by a tool that copies a shell hostname) and the
 * transcript feed writes `os.hostname()`, so case and surrounding whitespace
 * must not decide whether the native feed covers a transcript event.  A
 * mismatch would silently double-count the same usage.
 */
export function readHostName(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const value = (metadata as Record<string, unknown>)[HOST_NAME_KEY];
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized ? normalized : undefined;
}

export interface NativeCoverageResult {
  /** The events that should be persisted. */
  events: ParsedUsageTelemetryEvent[];
  /** How many transcript events the native feed already covers. */
  skippedNativeCovered: number;
  /** How many native token rows were consulted. */
  nativeRowsConsidered: number;
}

/**
 * Drop the transcript-sourced events that the native feed already covers.
 *
 * The lookup is bounded by the batch's own time range and by the
 * (sourceApp, occurredAt) index, so it costs one indexed read per batch.
 */
export async function dropEventsCoveredByNative(
  events: ParsedUsageTelemetryEvent[],
  options: { now?: Date } = {}
): Promise<NativeCoverageResult> {
  const transcriptEvents = events.filter(isTranscriptSourcedEvent);
  if (transcriptEvents.length === 0) {
    return { events, skippedNativeCovered: 0, nativeRowsConsidered: 0 };
  }

  const times = transcriptEvents.map((event) => event.occurredAt.getTime());
  const from = new Date(Math.min(...times) - NATIVE_COVERAGE_WINDOW_MS);
  const to = new Date(Math.max(...times) + NATIVE_COVERAGE_WINDOW_MS);

  const candidates = await prisma.externalUsageEvent.findMany({
    where: {
      sourceApp: { in: [...NATIVE_COVERAGE_PRODUCERS] },
      metricType: "usage",
      unit: "token",
      occurredAt: { gte: from, lte: to },
    },
    orderBy: { occurredAt: "desc" },
    take: MAX_NATIVE_ROWS,
    select: { occurredAt: true, metadata: true },
  });

  const nativeRows = candidates
    .filter((row) => readTranscriptMarker(row.metadata) !== TRANSCRIPT_COLLECTOR_MARKER)
    .map((row) => ({
      at: row.occurredAt.getTime(),
      host: readHostName(row.metadata),
    }));

  if (nativeRows.length === 0) {
    return { events, skippedNativeCovered: 0, nativeRowsConsidered: candidates.length };
  }

  let skippedNativeCovered = 0;
  const kept = events.filter((event) => {
    if (!isTranscriptSourcedEvent(event)) return true;
    const at = event.occurredAt.getTime();
    const host = readHostName(event.metadata);
    const covered = nativeRows.some(
      (row) =>
        Math.abs(row.at - at) <= NATIVE_COVERAGE_WINDOW_MS &&
        // Machine-scoped, and never a wildcard: the Mac's native feed must
        // not silence the server's transcript feed, and the server has no
        // native feed at all.  A native row without a machine identity cannot
        // be attributed to a machine, so it covers nothing.
        //
        // The historical native rows are not left in that state: the 214,382
        // rows Claude Code wrote before the Mac carried `host.name` were
        // stamped once with the machine they came from (every one of them
        // was written by the Mac's CLI or its Desktop app), so the
        // unattributable case does not arise in the ledger and the wildcard
        // is not needed.  A native row that still carries no machine
        // identity therefore means a producer that never named its machine,
        // and letting it cover every machine would silently drop another
        // machine's transcript usage.
        row.host !== undefined &&
        host !== undefined &&
        row.host === host
    );
    if (covered) skippedNativeCovered += 1;
    return !covered;
  });

  return { events: kept, skippedNativeCovered, nativeRowsConsidered: candidates.length };
}
