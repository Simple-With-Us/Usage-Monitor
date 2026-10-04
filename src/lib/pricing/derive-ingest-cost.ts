// Ingest-time cost derivation for generic pushed telemetry (Langfuse's
// worker-side lesson: when the producer omits cost, compute it from token
// counts x a pricing catalog). DEFAULT-OFF behind
// INGEST_COST_DERIVATION_ENABLED.
//
// Money-safety contract (this is why the feature is shaped the way it is):
//   - The derived value is written to METADATA ONLY (`_derivedCostUsd`).
//     `costUsd` stays null, so the pushed-cash pool in
//     external-usage-events.ts (`usagePushed` -> pushedMonthToDateUsd ->
//     budget spend) is byte-for-byte unaffected. Producers' own costUsd —
//     including their billingMode="estimated" values — is the only cost that
//     ever enters that pool; a monitor-computed estimate must not silently
//     join it.
//   - priced/unpriced coverage counts are untouched: a derived event is
//     still "unpriced" (the producer did not report a price). The estimate is
//     surfaced separately as `derivedCostEstimateUsd` in the usage-events
//     summary, explicitly labeled monitor-estimated.
//   - The four metadata keys are in RESERVED_V2_METADATA_KEYS
//     (usage-telemetry.ts) so a producer cannot spoof them; only this
//     server-side path may set them.
//   - Derivation is deterministic for a given bundled snapshot, so
//     idempotent replays of the same event derive the same value. The
//     snapshot's fetch timestamp is recorded per event so a later pricing
//     refresh is distinguishable.
//
// Scope: only metricType="usage" + unit="token" events with a keyRef that
// resolves in the LiteLLM snapshot. When the producer supplies a
// metadata.tokenType (input/output/cacheRead/cacheCreation) the matching
// rate is used; otherwise the INPUT rate is used as a floor and the event is
// flagged `_derivedCostIncomplete` (output-side tokens usually cost more, so
// the floor under-estimates — never over).

import {
  deriveTokenCostUsd,
  getModelPricing,
  PRICING_SNAPSHOT_META,
} from "./model-pricing";
import { appSettings } from "@/lib/app-settings";

export const DERIVED_COST_METADATA_KEYS = [
  "_derivedCostUsd",
  "_derivedCostPricingKey",
  "_derivedCostSnapshot",
  "_derivedCostIncomplete",
] as const;

export function ingestCostDerivationEnabled(): boolean {
  const raw = appSettings.get("INGEST_COST_DERIVATION_ENABLED")?.trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

const TOKEN_TYPES = new Set(["input", "output", "cacheRead", "cacheCreation"]);

/** Minimal event shape the derivation reads (satisfied by
 * ParsedUsageTelemetryEvent and by the route's persistence-event mapping). */
export interface CostDerivationEvent {
  metricType: string;
  unit?: string;
  quantity?: number;
  costUsd?: number;
  keyRef?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface DerivedCostEstimate {
  costUsd: number;
  pricingKey: string;
  /** True when the estimate is a floor (unknown token mix) or the catalog
   * lacks a rate for a token type that was used. */
  incomplete: boolean;
}

export function deriveEventCostEstimate(
  event: CostDerivationEvent
): DerivedCostEstimate | null {
  if (event.costUsd != null) return null;
  if (event.metricType !== "usage" || event.unit !== "token") return null;
  const quantity = event.quantity;
  if (quantity == null || !Number.isFinite(quantity) || quantity <= 0) return null;
  if (!event.keyRef) return null;
  const resolved = getModelPricing(event.keyRef);
  if (!resolved) return null;

  const rawType = event.metadata?.tokenType;
  const tokenType =
    typeof rawType === "string" && TOKEN_TYPES.has(rawType) ? rawType : undefined;
  const breakdown = tokenType ? { [tokenType]: quantity } : { input: quantity };
  const derived = deriveTokenCostUsd(resolved.pricing, breakdown);
  return {
    costUsd: derived.costUsd,
    pricingKey: resolved.key,
    incomplete: !derived.complete || !tokenType,
  };
}

/**
 * Derives and stamps cost estimates onto events IN PLACE (metadata only).
 * Returns the number of events that received an estimate. No-op when the
 * flag is disabled.
 */
export function applyIngestCostDerivation(events: CostDerivationEvent[]): number {
  if (!ingestCostDerivationEnabled()) return 0;
  let stamped = 0;
  for (const event of events) {
    const estimate = deriveEventCostEstimate(event);
    if (!estimate) continue;
    event.metadata = {
      ...(event.metadata ?? {}),
      _derivedCostUsd: estimate.costUsd,
      _derivedCostPricingKey: estimate.pricingKey,
      _derivedCostSnapshot: PRICING_SNAPSHOT_META.fetchedAt,
      ...(estimate.incomplete ? { _derivedCostIncomplete: true } : {}),
    };
    stamped += 1;
  }
  return stamped;
}
