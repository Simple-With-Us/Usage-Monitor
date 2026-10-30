import type { ParsedUsageTelemetryEvent } from "@/lib/usage-telemetry";

export interface BotFleetCoverageResult {
  events: ParsedUsageTelemetryEvent[];
  skippedBotFleetCovered: number;
}

/**
 * Preserve every child event until BotFleet supplies an exact billed-call ledger.
 * Same session and overlapping time do not prove that a call was billed:
 * independent CLI turns may run inside a BotFleet turn and be discarded by it.
 *
 * BOTFLEET_CHILD_COVERAGE_DROP is deliberately inert, including when set to 1.
 * A future implementation must reconcile per-call identities and measured
 * quantities against BotFleet's billed aggregate before dropping any child row.
 * Native cumulative metrics cannot be treated as single-call receipts.
 */
export async function dropEventsCoveredByBotFleet(
  events: ParsedUsageTelemetryEvent[],
  _env: Record<string, string | undefined> = process.env
): Promise<BotFleetCoverageResult> {
  return { events, skippedBotFleetCovered: 0 };
}
