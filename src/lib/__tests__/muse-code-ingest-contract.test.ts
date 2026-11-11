import { describe, it, expect } from "vitest";
import { parseUsageTelemetryV2Batch } from "../usage-telemetry";
import {
  buildMuseCodeBurnReport,
  type MuseCodeBurnGroups,
} from "../muse-code-burn";

// The CodeCaps handoff contract, pinned as a test: CodeCaps (Swift, on the
// Mac) reads the Muse Code session stores and posts per-model token DELTA
// events as producer "muse-code" through the standard v2 ingest — the same
// shape the antigravity/codex session collectors use.  This test proves
// (1) the ingest parser accepts and normalizes that exact payload with zero
// rejections, and (2) the normalized events are exactly what
// GET /api/muse-code-burn sums into trailing-window totals, per-model
// split, and contributor share.  If a future schema or adapter change
// breaks the CodeCaps bridge, this test fails first.
const OBSERVED_AT = new Date(Date.now() - 60_000);

function codecapsEvent(overrides: Record<string, unknown> = {}) {
  return {
    eventId: "codecaps-muse-code:sess-1:snap-9:muse-spark-1.3-contributor",
    provider: "muse-code",
    service: "muse-code",
    producerKeyRef: "muse-spark-1.3-contributor",
    metricType: "usage",
    unit: "token",
    quantity: 125_000,
    billingMode: "estimated",
    confidence: "estimated",
    occurredAt: OBSERVED_AT.toISOString(),
    metadata: {
      sessionId: "sess-1",
      contributor: true,
      source: "muse-session-stores",
    },
    ...overrides,
  };
}

describe("CodeCaps muse-code ingest contract", () => {
  it("accepts the documented batch with zero rejections and normalizes model/unit", async () => {
    const parsed = await parseUsageTelemetryV2Batch({
      schemaVersion: 2,
      producerId: "muse-code",
      events: [
        codecapsEvent(),
        codecapsEvent({
          eventId: "codecaps-muse-code:sess-2:snap-3:muse-wonder-1.0",
          producerKeyRef: "muse-wonder-1.0",
          quantity: 25_000,
          metadata: {
            sessionId: "sess-2",
            contributor: false,
            source: "muse-session-stores",
          },
        }),
      ],
    });

    expect(parsed.rejected).toBe(0);
    expect(parsed.events).toHaveLength(2);
    for (const event of parsed.events) {
      expect(event.provider).toBe("muse-code");
      expect(event.sourceApp).toBe("muse-code");
      expect(event.metricType).toBe("usage");
      expect(event.unit).toBe("token");
    }
    expect(parsed.events.map((e) => e.keyRef).sort()).toEqual([
      "muse-spark-1.3-contributor",
      "muse-wonder-1.0",
    ]);
  });

  it("feeds the burn report: parsed events sum to totals and contributor share", async () => {
    const parsed = await parseUsageTelemetryV2Batch({
      schemaVersion: 2,
      producerId: "muse-code",
      events: [
        codecapsEvent(),
        codecapsEvent({
          eventId: "codecaps-muse-code:sess-1:snap-10:muse-spark-1.3-contributor",
          quantity: 75_000,
        }),
        codecapsEvent({
          eventId: "codecaps-muse-code:sess-2:snap-3:muse-wonder-1.0",
          producerKeyRef: "muse-wonder-1.0",
          quantity: 50_000,
          metadata: {
            sessionId: "sess-2",
            contributor: false,
            source: "muse-session-stores",
          },
        }),
      ],
    });
    expect(parsed.rejected).toBe(0);

    // Group exactly like loadMuseCodeBurnGroups does (by keyRef, sum).
    const byModel = new Map<string | null, { tokens: number; eventCount: number }>();
    for (const event of parsed.events) {
      const model = event.keyRef ?? null;
      const row = byModel.get(model) ?? { tokens: 0, eventCount: 0 };
      row.tokens += event.quantity ?? 0;
      row.eventCount += 1;
      byModel.set(model, row);
    }
    const groups: MuseCodeBurnGroups = {
      groups: [...byModel.entries()].map(([model, row]) => ({
        model,
        tokens: row.tokens,
        eventCount: row.eventCount,
      })),
      firstOccurredAt: OBSERVED_AT,
      lastOccurredAt: OBSERVED_AT,
    };

    const now = new Date();
    const report = buildMuseCodeBurnReport(groups, {
      windowMinutes: 90,
      windowStart: new Date(now.getTime() - 90 * 60_000),
      windowEnd: now,
      generatedAt: now,
    });

    expect(report.totalTokens).toBe(250_000);
    expect(report.contributorTokens).toBe(200_000);
    expect(report.contributorShare).toBeCloseTo(0.8);
    expect(report.allContributor).toBe(false);
    expect(report.models).toHaveLength(2);
  });
});
