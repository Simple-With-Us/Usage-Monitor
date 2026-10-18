import { prisma } from "@/lib/prisma";

// Per-request performance summary over AiRequest (UM-1590).
// Percentiles are computed in JS over a bounded, recent window: SQLite has no
// percentile function and the row count per window is modest.

export const MAX_PERFORMANCE_ROWS = 100_000;

export interface AiRequestPerformanceRow {
  harness: string;
  model: string;
  requests: number;
  errors: number;
  durationMsP50: number | null;
  durationMsP95: number | null;
  ttftMsP50: number | null;
  ttftMsP95: number | null;
  /** Output tokens per second of generation time (duration minus TTFT when known). */
  outputTokensPerSecP50: number | null;
  /** cacheRead / (input + cacheRead + cacheWrite), over the group's token sums. */
  cacheHitRatio: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  /** PAYG-equivalent cost reported by the harness (estimated), when present. */
  costUsd: number;
  costUsdKnownRequests: number;
  billingModes: Record<string, number>;
}

export interface AiRequestPerformance {
  ok: true;
  days: number;
  since: string;
  totalRequests: number;
  truncated: boolean;
  totalCostUsd: number;
  rows: AiRequestPerformanceRow[];
}

export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[rank];
}

type PerfInput = {
  harness: string;
  requestedModel: string | null;
  servedModel: string | null;
  durationMs: number | null;
  ttftMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  costUsd: number | null;
  billingMode: string | null;
  error: string | null;
};

export function summarizeAiRequests(rows: PerfInput[]): AiRequestPerformanceRow[] {
  const groups = new Map<string, PerfInput[]>();
  for (const row of rows) {
    const model = row.servedModel ?? row.requestedModel ?? "unknown";
    const key = `${row.harness}\u0000${model}`;
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }

  const out: AiRequestPerformanceRow[] = [];
  for (const [key, list] of groups) {
    const [harness, model] = key.split("\u0000");
    const ok = list.filter((r) => !r.error);
    const durations = ok.map((r) => r.durationMs).filter((v): v is number => v != null).sort((a, b) => a - b);
    const ttfts = ok.map((r) => r.ttftMs).filter((v): v is number => v != null).sort((a, b) => a - b);
    const rates = ok
      .map((r) => {
        if (r.outputTokens == null || r.durationMs == null) return null;
        const genMs = r.ttftMs != null && r.durationMs > r.ttftMs ? r.durationMs - r.ttftMs : r.durationMs;
        return genMs > 0 ? (r.outputTokens * 1000) / genMs : null;
      })
      .filter((v): v is number => v != null)
      .sort((a, b) => a - b);
    const sum = (pick: (r: PerfInput) => number | null) => list.reduce((acc, r) => acc + (pick(r) ?? 0), 0);
    const input = sum((r) => r.inputTokens);
    const cacheRead = sum((r) => r.cacheReadTokens);
    const cacheWrite = sum((r) => r.cacheWriteTokens);
    const promptTotal = input + cacheRead + cacheWrite;
    const billingModes: Record<string, number> = {};
    for (const r of list) {
      const mode = r.billingMode ?? "unknown";
      billingModes[mode] = (billingModes[mode] ?? 0) + 1;
    }
    const rate = percentile(rates, 0.5);
    out.push({
      harness,
      model,
      requests: list.length,
      errors: list.length - ok.length,
      durationMsP50: percentile(durations, 0.5),
      durationMsP95: percentile(durations, 0.95),
      ttftMsP50: percentile(ttfts, 0.5),
      ttftMsP95: percentile(ttfts, 0.95),
      outputTokensPerSecP50: rate == null ? null : Math.round(rate * 10) / 10,
      cacheHitRatio: promptTotal > 0 ? Math.round((cacheRead / promptTotal) * 1000) / 1000 : null,
      inputTokens: input,
      outputTokens: sum((r) => r.outputTokens),
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      reasoningTokens: sum((r) => r.reasoningTokens),
      costUsd: Math.round(sum((r) => r.costUsd) * 1e6) / 1e6,
      costUsdKnownRequests: list.filter((r) => r.costUsd != null).length,
      billingModes,
    });
  }
  return out.sort((a, b) => b.requests - a.requests);
}

export async function getAiRequestPerformance(days: number, now = new Date()): Promise<AiRequestPerformance> {
  const since = new Date(now.getTime() - days * 86_400_000);
  const rows = await prisma.aiRequest.findMany({
    where: { occurredAt: { gte: since } },
    orderBy: { occurredAt: "desc" },
    take: MAX_PERFORMANCE_ROWS + 1,
    select: {
      harness: true,
      requestedModel: true,
      servedModel: true,
      durationMs: true,
      ttftMs: true,
      inputTokens: true,
      outputTokens: true,
      cacheReadTokens: true,
      cacheWriteTokens: true,
      reasoningTokens: true,
      costUsd: true,
      billingMode: true,
      error: true,
    },
  });
  const truncated = rows.length > MAX_PERFORMANCE_ROWS;
  const used = truncated ? rows.slice(0, MAX_PERFORMANCE_ROWS) : rows;
  const summary = summarizeAiRequests(used);
  return {
    ok: true,
    days,
    since: since.toISOString(),
    totalRequests: used.length,
    truncated,
    totalCostUsd: Math.round(summary.reduce((acc, r) => acc + r.costUsd, 0) * 1e6) / 1e6,
    rows: summary,
  };
}
