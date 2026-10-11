import { recordFleetInfraMetric } from "@/lib/sentry-fleet";

// Best-effort fan-out of persisted usage/cost observations to the shared
// fleet-infra Sentry project (audit §B.4 / §C.2c). UM stays the billing
// ledger; fleet-infra gets low-cardinality summary signals only — never
// event IDs, prompts, tool arguments, credentials, or transcript text.
//
// Volume discipline: callers pass a batch, this module emits at most a few
// aggregated envelopes per call (top provider × platform groups + a total),
// so a 100-event ingest batch cannot produce 100 Sentry events. Every path
// is fire-and-forget and never throws.

const MAX_GROUPS_PER_CALL = 10;

export interface FanoutUsageEvent {
  provider: string;
  sourceApp: string;
  /** Model when known (keyRef on ExternalUsageEvent-shaped rows). */
  model?: string | null;
  costUsd?: number | null;
}

function groupKey(e: FanoutUsageEvent): string {
  return `${e.provider}\u0000${e.sourceApp}\u0000${(e.model ?? "").trim().toLowerCase()}`;
}

/**
 * Emit one aggregated `usage.persisted` counter per (provider, platform,
 * model) group plus a `usage.persisted_total` envelope. No-op for empty
 * input. Never throws.
 */
export async function fanoutPersistedUsage(
  events: readonly FanoutUsageEvent[],
  route: "ingest/usage" | "otlp/v1/metrics" | "otlp/v1/traces" | "poll"
): Promise<void> {
  try {
    if (events.length === 0) return;
    const byGroup = new Map<string, { provider: string; platform: string; model: string; count: number; cost: number }>();
    for (const e of events) {
      const provider = e.provider?.trim() || "unknown";
      const platform = e.sourceApp?.trim().toLowerCase() || "unknown";
      const model = (e.model ?? "").trim() || "unknown";
      const key = groupKey({ provider, sourceApp: platform, model });
      const g = byGroup.get(key) ?? { provider, platform, model, count: 0, cost: 0 };
      g.count += 1;
      if (typeof e.costUsd === "number" && Number.isFinite(e.costUsd)) g.cost += e.costUsd;
      byGroup.set(key, g);
    }
    const groups = Array.from(byGroup.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, MAX_GROUPS_PER_CALL);
    for (const g of groups) {
      await recordFleetInfraMetric("usage.persisted", g.count, {
        route,
        source: route === "poll" ? "poll-snapshot" : "ingest",
        platform: g.platform,
        provider: g.provider,
        model: g.model,
        cost_usd: Number(g.cost.toFixed(4)),
      });
    }
    const total = Array.from(byGroup.values()).reduce((n, g) => n + g.count, 0);
    await recordFleetInfraMetric("usage.persisted_total", total, { route });
  } catch {
    // best-effort only
  }
}

/**
 * Emit a per-snapshot signal for one poll-adapter UsageSnapshot write.
 * Never throws.
 */
export async function fanoutPollSnapshot(
  providerName: string,
  snapshot: { totalCost?: number | null; balance?: number | null }
): Promise<void> {
  try {
    const provider = providerName?.trim() || "unknown";
    await recordFleetInfraMetric("poll.snapshot", 1, {
      source: "poll-snapshot",
      platform: "poll",
      provider,
    });
    if (typeof snapshot.totalCost === "number" && Number.isFinite(snapshot.totalCost)) {
      await recordFleetInfraMetric("poll.snapshot.cost_usd", snapshot.totalCost, {
        source: "poll-snapshot",
        platform: "poll",
        provider,
      });
    }
  } catch {
    // best-effort only
  }
}

/**
 * Emit one envelope per persisted agent turn batch (count + error count).
 * Turn content (prompts, tool args) never leaves this process. Never throws.
 */
export async function fanoutAgentTurns(turns: readonly { platform: string; error?: string | null }[]): Promise<void> {
  try {
    if (turns.length === 0) return;
    const byPlatform = new Map<string, { count: number; errors: number }>();
    for (const t of turns) {
      const platform = t.platform?.trim().toLowerCase() || "unknown";
      const g = byPlatform.get(platform) ?? { count: 0, errors: 0 };
      g.count += 1;
      if (t.error) g.errors += 1;
      byPlatform.set(platform, g);
    }
    for (const [platform, g] of Array.from(byPlatform.entries()).slice(0, MAX_GROUPS_PER_CALL)) {
      await recordFleetInfraMetric("agent.turn", g.count, {
        source: "otlp-traces",
        platform,
        errors: g.errors,
      });
    }
  } catch {
    // best-effort only
  }
}
