import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: { externalUsageEvent: { findMany: (...args: unknown[]) => findMany(...args) } },
}));

import {
  NATIVE_COVERAGE_WINDOW_MS,
  dropEventsCoveredByNative,
  isTranscriptSourcedEvent,
  readHostName,
  readTranscriptMarker,
} from "../native-telemetry-coverage";
import type { ParsedUsageTelemetryEvent } from "../usage-telemetry";

const at = (iso: string) => new Date(iso);

function event(
  occurredAt: string,
  metadata: Record<string, string | number | boolean | null>,
  sourceApp = "claude-code",
): ParsedUsageTelemetryEvent {
  return {
    sourceApp,
    provider: "anthropic",
    service: "claude-code",
    billingMode: "estimated",
    metricType: "usage",
    confidence: "estimated",
    occurredAt: at(occurredAt),
    metadata,
    idempotencyKey: `k-${occurredAt}-${JSON.stringify(metadata)}`,
  };
}

describe("native telemetry coverage", () => {
  beforeEach(() => {
    findMany.mockReset();
  });

  it("recognizes a transcript-sourced event by its marker", () => {
    expect(isTranscriptSourcedEvent(event("2026-10-25T10:00:00.000Z", { collector: "transcript" }))).toBe(true);
    expect(isTranscriptSourcedEvent(event("2026-10-25T10:00:00.000Z", {}))).toBe(false);
    // Another producer's events are never treated as transcript rows.
    expect(
      isTranscriptSourcedEvent(
        event("2026-10-25T10:00:00.000Z", { collector: "transcript" }, "opencode")
      )
    ).toBe(false);
  });

  it("reads the marker and host out of an unknown metadata shape", () => {
    expect(readTranscriptMarker({ collector: "transcript" })).toBe("transcript");
    expect(readTranscriptMarker(null)).toBeUndefined();
    expect(readTranscriptMarker(["transcript"])).toBeUndefined();
    expect(readHostName({ "host.name": "jay-macbook" })).toBe("jay-macbook");
    expect(readHostName({ "host.name": "  " })).toBeUndefined();
  });

  it("keeps transcript events when the native feed has no rows", async () => {
    findMany.mockResolvedValue([]);
    const events = [event("2026-10-25T10:00:00.000Z", { collector: "transcript", "host.name": "jay-macbook" })];
    const result = await dropEventsCoveredByNative(events);
    expect(result.events).toHaveLength(1);
    expect(result.skippedNativeCovered).toBe(0);
  });

  it("drops a transcript event the native feed already covers", async () => {
    findMany.mockResolvedValue([
      { occurredAt: at("2026-10-25T10:00:30.000Z"), metadata: { "host.name": "jay-macbook" } },
    ]);
    const events = [
      event("2026-10-25T10:00:00.000Z", { collector: "transcript", "host.name": "jay-macbook" }),
      event("2026-10-25T11:00:00.000Z", { collector: "transcript", "host.name": "jay-macbook" }),
    ];
    const result = await dropEventsCoveredByNative(events);
    expect(result.skippedNativeCovered).toBe(1);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].occurredAt.toISOString()).toBe("2026-10-25T11:00:00.000Z");
  });

  it("does not let one machine's native feed silence another machine's transcripts", async () => {
    // The Mac's native feed must not drop the server's transcript rows, and
    // the server has no native feed at all.
    findMany.mockResolvedValue([
      { occurredAt: at("2026-10-25T10:00:30.000Z"), metadata: { "host.name": "jay-macbook" } },
    ]);
    const events = [
      event("2026-10-25T10:00:00.000Z", { collector: "transcript", "host.name": "fleet-hetzner-nbg1" }),
    ];
    const result = await dropEventsCoveredByNative(events);
    expect(result.skippedNativeCovered).toBe(0);
    expect(result.events).toHaveLength(1);
  });

  it("never lets a native row without a machine identity cover anything", async () => {
    // A native row that cannot be attributed to a machine must not silence
    // another machine's transcript events.
    findMany.mockResolvedValue([
      { occurredAt: at("2026-10-25T10:00:30.000Z"), metadata: {} },
    ]);
    const events = [
      event("2026-10-25T10:00:00.000Z", { collector: "transcript", "host.name": "jay-macbook" }),
      event("2026-10-25T10:00:00.000Z", { collector: "transcript", "host.name": "fleet-hetzner-nbg1" }),
    ];
    const result = await dropEventsCoveredByNative(events);
    expect(result.skippedNativeCovered).toBe(0);
    expect(result.events).toHaveLength(2);
  });

  it("compares machine identities case-insensitively", async () => {
    // The OTLP resource attribute is written by an operator and the transcript
    // feed writes os.hostname(), so a case difference must not decide
    // whether the native feed covers the event.
    findMany.mockResolvedValue([
      { occurredAt: at("2026-10-25T10:00:30.000Z"), metadata: { "host.name": "Mac.Jays.Services" } },
    ]);
    const events = [
      event("2026-10-25T10:00:00.000Z", { collector: "transcript", "host.name": "mac.jays.services" }),
    ];
    const result = await dropEventsCoveredByNative(events);
    expect(result.skippedNativeCovered).toBe(1);
    expect(result.events).toHaveLength(0);
  });

  it("never drops another producer's events", async () => {
    findMany.mockResolvedValue([
      { occurredAt: at("2026-10-25T10:00:30.000Z"), metadata: { "host.name": "jay-macbook" } },
    ]);
    const events = [
      event("2026-10-25T10:00:00.000Z", { "host.name": "jay-macbook" }, "opencode"),
    ];
    const result = await dropEventsCoveredByNative(events);
    expect(result.skippedNativeCovered).toBe(0);
    expect(result.events).toHaveLength(1);
  });

  it("looks only inside the batch's own time window", async () => {
    findMany.mockResolvedValue([]);
    await dropEventsCoveredByNative([
      event("2026-10-25T10:00:00.000Z", { collector: "transcript", "host.name": "jay-macbook" }),
    ]);
    const where = (findMany.mock.calls[0][0] as { where: { occurredAt: { gte: Date; lte: Date } } }).where;
    expect(where.occurredAt.gte.getTime()).toBe(
      at("2026-10-25T10:00:00.000Z").getTime() - NATIVE_COVERAGE_WINDOW_MS
    );
    expect(where.occurredAt.lte.getTime()).toBe(
      at("2026-10-25T10:00:00.000Z").getTime() + NATIVE_COVERAGE_WINDOW_MS
    );
  });
});
