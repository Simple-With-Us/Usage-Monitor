import type { ParsedUsageTelemetryEvent } from "@/lib/usage-telemetry";

export interface NativeCoverageResult {
  events: ParsedUsageTelemetryEvent[];
  skippedNativeCovered: number;
  nativeRowsConsidered: number;
}

/**
 * Aggregate native metrics cannot prove coverage of an individual transcript
 * call or token component.  Preserve both feeds until an exact-call contract
 * exists; timing, host proximity and exporter health never authorize a drop.
 * This compatibility entrypoint deliberately performs no database lookup.
 */
export function dropEventsCoveredByNative(
  events: ParsedUsageTelemetryEvent[],
  _options: { now?: Date } = {}
): Promise<NativeCoverageResult> {
  return Promise.resolve({ events, skippedNativeCovered: 0, nativeRowsConsidered: 0 });
}
