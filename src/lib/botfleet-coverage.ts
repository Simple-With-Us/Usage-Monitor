import type { ParsedUsageTelemetryEvent } from "@/lib/usage-telemetry";
import { createHash } from "node:crypto";
import { deriveUsageTelemetryV2IdempotencyKey } from "@jaywedgeworth22/congress-trading-shared";
import { prisma } from "@/lib/prisma";
import { AI_METADATA_KEYS } from "@/lib/ai-usage-metadata";
import type { IngestCredential } from "@/lib/ingest-auth";

export interface BotFleetCoverageResult {
  events: ParsedUsageTelemetryEvent[];
  skippedBotFleetCovered: number;
}

type RecordValue = Record<string, unknown>;
const COVERED_COMPONENTS = new Map([
  ["output", "billedCallOutput"], ["cacheRead", "billedCallCacheRead"], ["cacheCreation", "billedCallCacheWrite"],
]);
function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}
function identity(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 200 ? value : null;
}
function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function singleCallEventId(session: string, call: string): string {
  return `bf-call-v1:${createHash("sha256").update(JSON.stringify([session, call])).digest("hex")}`;
}

/** Only the HTTP receiver may grant receipt authority to a scoped BotFleet issuer. */
export function stampBotFleetReceiptCredential(
  events: ParsedUsageTelemetryEvent[], credential: IngestCredential | null
): ParsedUsageTelemetryEvent[] {
  if (credential?.credentialId !== "botfleet" || credential.allowedSourceApps?.size !== 1 ||
    !credential.allowedSourceApps.has("botfleet")) return events;
  return events.map((event) => {
    const meta = record(event.metadata);
    if (event.sourceApp !== "botfleet" || meta._usageTelemetrySchemaVersion !== 2 ||
      meta.billedCallProofVersion !== 1 || typeof meta._producerEventId !== "string" ||
      !/^bf-call-v1:[a-f0-9]{64}$/.test(meta._producerEventId)) return event;
    return { ...event, metadata: { ...meta, _botFleetReceiptCredential: "botfleet-v1" } };
  });
}

/** Only a persisted, reconciled single-call receipt can cover child token slices. */
export async function dropEventsCoveredByBotFleet(
  events: ParsedUsageTelemetryEvent[],
  env: Record<string, string | undefined> = process.env
): Promise<BotFleetCoverageResult> {
  const unchanged = () => ({ events, skippedBotFleetCovered: 0 });
  if (env.BOTFLEET_CHILD_COVERAGE_DROP !== "1" || events.length > 100) return unchanged();
  const candidates = await Promise.all(events.map(async (event, index) => {
    const meta = record(event.metadata);
    const session = identity(meta["session.id"]);
    const call = identity(meta["call.id"]);
    const model = identity(meta.model);
    const host = identity(meta._producerInstanceId);
    const component = typeof meta.tokenType === "string" ? COVERED_COMPONENTS.get(meta.tokenType) : undefined;
    // Inputs, costs, request counts, cumulative metrics and all incomplete
    // identities stay additive. There is no time-window fallback.
    if (event.sourceApp !== "claude-code" || event.provider !== "anthropic" ||
      event.metricType !== "usage" || event.unit !== "token" ||
      event.costUsd != null || (event.requests != null && event.requests !== 0) ||
      !count(event.quantity) || event.quantity === 0 || meta["agent.launcher"] !== "botfleet" ||
      !session || !call || !model || !host || event.keyRef !== model || !component) return null;
    const eventId = singleCallEventId(session, call);
    try {
      const key = await deriveUsageTelemetryV2IdempotencyKey({ producerId: "botfleet", eventId });
      return { index, session, call, model, host, component, eventId, key, quantity: event.quantity };
    } catch { return null; }
  }));
  const eligible = candidates.filter((item) => item !== null);
  if (eligible.length === 0) return unchanged();
  // HTTP batches are already bounded; retain a defensive bound for direct callers.
  if (eligible.length > 100) return unchanged();
  try {
    const receipts = await prisma.externalUsageEvent.findMany({
      where: { idempotencyKey: { in: [...new Set(eligible.map((item) => item.key))] } },
      select: { idempotencyKey: true, sourceApp: true, provider: true, metricType: true, unit: true, quantity: true, requests: true, metadata: true },
    });
    const byKey = new Map(receipts.map((row) => [row.idempotencyKey, row]));
    const covered = new Set<number>();
    const claimed = new Set<string>();
    for (const candidate of eligible) {
      const claim = `${candidate.key}:${candidate.component}`;
      if (claimed.has(claim)) continue;
      const row = byKey.get(candidate.key);
      if (!row || row.sourceApp !== "botfleet" || row.provider !== "anthropic" || row.metricType !== "usage" || row.unit !== "token" || row.requests !== 1) continue;
      const meta = record(row.metadata);
      const output = meta[AI_METADATA_KEYS.tokensOutput];
      const input = meta[AI_METADATA_KEYS.tokensInput];
      const read = meta[AI_METADATA_KEYS.tokensCacheRead];
      const write5m = meta[AI_METADATA_KEYS.tokensCacheWrite5m];
      const write1h = meta[AI_METADATA_KEYS.tokensCacheWrite1h];
      if (![input, output, read, write5m, write1h].every(count)) continue;
      const total = (input as number) + (output as number) + (read as number) + (write5m as number) + (write1h as number);
      if (!Number.isSafeInteger(total)) continue;
      if (meta._botFleetReceiptCredential !== "botfleet-v1" ||
        meta._usageTelemetrySchemaVersion !== 2 || meta._producerEventId !== candidate.eventId ||
        meta._producerInstanceId !== candidate.host || meta.childHarness !== "claudeAgent" ||
        meta.childSessionId !== candidate.session || meta.usageReported !== true ||
        meta.billedCallProofVersion !== 1 || meta.billedCallId !== candidate.call ||
        meta.billedCallModel !== candidate.model || meta[AI_METADATA_KEYS.modelServed] !== candidate.model ||
        meta[AI_METADATA_KEYS.harness] !== "botfleet" || meta[AI_METADATA_KEYS.source] !== "block" ||
        meta.billedCallOutput !== output || meta.billedCallCacheRead !== read ||
        meta.billedCallCacheWrite !== (write5m as number) + (write1h as number) ||
        row.quantity !== total ||
        meta[candidate.component] !== candidate.quantity) continue;
      covered.add(candidate.index);
      claimed.add(claim);
    }
    return covered.size > 0
      ? { events: events.filter((_, index) => !covered.has(index)), skippedBotFleetCovered: covered.size }
      : unchanged();
  } catch {
    // Lookup failure cannot cost a child event.
    return unchanged();
  }
}
