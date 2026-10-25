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

/**
 * How wide one coverage lookup is.
 *
 * The lookup is chunked so no single query walks a multi-day range, and the
 * chunks are wide enough that a backfill batch does not turn into dozens of
 * queries inside one ingest request, which would hold the ingest admission
 * lease long enough to make the write behind it time out.
 */
const COVERAGE_LOOKUP_CHUNK_MS = 6 * 60 * 60 * 1000;

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

  // The native rows are looked up in hour-sized chunks, and only the rows
  // whose machine is one of the batch's own machines count.
  //
  // Two things matter here.  A truncated lookup would silently under-cover: a
  // backfill batch spans days, and the newest native rows alone say nothing
  // about the older part of the batch.  And a single wide lookup holds the
  // database open long enough to make the writer behind it time out, so the
  // range is walked in bounded pieces instead.
  const hosts = new Set(
    transcriptEvents
      .map((event) => readHostName(event.metadata))
      .filter((host): host is string => !!host)
  );
  if (hosts.size === 0) {
    // No transcript event names its machine, so no native row can be
    // attributed to one either.
    return { events, skippedNativeCovered: 0, nativeRowsConsidered: 0 };
  }

  const nativeTimes: number[] = [];
  const eventFromMs = Math.min(...times);
  const eventToMs = Math.max(...times);
  for (let cursor = eventFromMs; cursor <= eventToMs; cursor += COVERAGE_LOOKUP_CHUNK_MS) {
    const chunkTo = Math.min(cursor + COVERAGE_LOOKUP_CHUNK_MS, eventToMs);
    const rows = await prisma.externalUsageEvent.findMany({
      where: {
        sourceApp: { in: [...NATIVE_COVERAGE_PRODUCERS] },
        metricType: "usage",
        unit: "token",
        occurredAt: {
          gte: new Date(cursor - NATIVE_COVERAGE_WINDOW_MS),
          lte: new Date(chunkTo + NATIVE_COVERAGE_WINDOW_MS),
        },
      },
      select: { occurredAt: true, metadata: true },
    });
    for (const row of rows) {
      // A row this feed stored earlier is not native telemetry: it would
      // cover the next transcript event in the same window and silently drop
      // it from the ledger.
      if (readTranscriptMarker(row.metadata) === TRANSCRIPT_COLLECTOR_MARKER) continue;
      const host = readHostName(row.metadata);
      // Machine-scoped, and never a wildcard: the Mac's native feed must not
      // silence the server's transcript feed, and the server has no native
      // feed at all.  A native row without a machine identity cannot be
      // attributed to a machine, so it covers nothing.
      //
      // The historical native rows are not left in that state: the rows
      // Claude Code wrote before the Mac carried `host.name` were stamped
      // once with the machine they came from, so the unattributable case does
      // not arise in the ledger and the wildcard is not needed.
      if (!host || !hosts.has(host)) continue;
      nativeTimes.push(row.occurredAt.getTime());
    }
  }

  if (nativeTimes.length === 0) {
    return { events, skippedNativeCovered: 0, nativeRowsConsidered: 0 };
  }

  let skippedNativeCovered = 0;
  const kept = events.filter((event) => {
    if (!isTranscriptSourcedEvent(event)) return true;
    const at = event.occurredAt.getTime();
    const covered = nativeTimes.some(
      (nativeAt) => Math.abs(nativeAt - at) <= NATIVE_COVERAGE_WINDOW_MS
    );
    if (covered) skippedNativeCovered += 1;
    return !covered;
  });

  return { events: kept, skippedNativeCovered, nativeRowsConsidered: nativeTimes.length };
}
