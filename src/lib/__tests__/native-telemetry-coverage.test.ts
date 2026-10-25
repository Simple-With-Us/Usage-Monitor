import { beforeEach, describe, expect, it, vi } from "vitest";

const queryRaw = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: { $queryRaw: (...args: unknown[]) => queryRaw(...args) },
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

/**
 * Emulate the raw lookup: it returns only the native rows whose machine is
 * one of the machines the query asked about, which is what the SQL does.
 */
function mockNativeRows(
  rows: Array<{ occurredAt: Date; metadata: Record<string, string> }>
) {
  queryRaw.mockImplementation((query: { values: unknown[] }) =>
    rows.filter((row) => {
      const host = String(row.metadata["host.name"] ?? "").trim().toLowerCase();
      return host !== "" && query.values.includes(host);
    })
  );
}


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
    queryRaw.mockReset();
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
    expect(readHostName({ "host.name": "workstation-1" })).toBe("workstation-1");
    expect(readHostName({ "host.name": "  " })).toBeUndefined();
  });

  it("keeps transcript events when the native feed has no rows", async () => {
    mockNativeRows([]);
    const events = [event("2026-10-25T10:00:00.000Z", { collector: "transcript", "host.name": "workstation-1" })];
    const result = await dropEventsCoveredByNative(events);
    expect(result.events).toHaveLength(1);
    expect(result.skippedNativeCovered).toBe(0);
  });

  it("drops a transcript event the native feed already covers", async () => {
    queryRaw.mockResolvedValue([
      { occurredAt: at("2026-10-25T10:00:30.000Z"), metadata: { "host.name": "workstation-1" } },
    ]);
    const events = [
      event("2026-10-25T10:00:00.000Z", { collector: "transcript", "host.name": "workstation-1" }),
      event("2026-10-25T11:00:00.000Z", { collector: "transcript", "host.name": "workstation-1" }),
    ];
    const result = await dropEventsCoveredByNative(events);
    expect(result.skippedNativeCovered).toBe(1);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].occurredAt.toISOString()).toBe("2026-10-25T11:00:00.000Z");
  });

  it("does not let one machine's native feed silence another machine's transcripts", async () => {
    // The Mac's native feed must not drop the server's transcript rows, and
    // the server has no native feed at all.
    mockNativeRows([
      { occurredAt: at("2026-10-25T10:00:30.000Z"), metadata: { "host.name": "workstation-1" } },
    ]);
    const events = [
      event("2026-10-25T10:00:00.000Z", { collector: "transcript", "host.name": "server-1" }),
    ];
    const result = await dropEventsCoveredByNative(events);
    expect(result.skippedNativeCovered).toBe(0);
    expect(result.events).toHaveLength(1);
  });

  it("never lets a native row without a machine identity cover anything", async () => {
    // A native row that cannot be attributed to a machine must not silence
    // another machine's transcript events.
    mockNativeRows([
      { occurredAt: at("2026-10-25T10:00:30.000Z"), metadata: {} },
    ]);
    const events = [
      event("2026-10-25T10:00:00.000Z", { collector: "transcript", "host.name": "workstation-1" }),
      event("2026-10-25T10:00:00.000Z", { collector: "transcript", "host.name": "server-1" }),
    ];
    const result = await dropEventsCoveredByNative(events);
    expect(result.skippedNativeCovered).toBe(0);
    expect(result.events).toHaveLength(2);
  });

  it("compares machine identities case-insensitively", async () => {
    // The OTLP resource attribute is written by an operator and the transcript
    // feed writes os.hostname(), so a case difference must not decide
    // whether the native feed covers the event.
    mockNativeRows([
      { occurredAt: at("2026-10-25T10:00:30.000Z"), metadata: { "host.name": "Workstation-1" } },
    ]);
    const events = [
      event("2026-10-25T10:00:00.000Z", { collector: "transcript", "host.name": "workstation-1" }),
    ];
    const result = await dropEventsCoveredByNative(events);
    expect(result.skippedNativeCovered).toBe(1);
    expect(result.events).toHaveLength(0);
  });

  it("never drops another producer's events", async () => {
    queryRaw.mockResolvedValue([
      { occurredAt: at("2026-10-25T10:00:30.000Z"), metadata: { "host.name": "workstation-1" } },
    ]);
    const events = [
      event("2026-10-25T10:00:00.000Z", { "host.name": "workstation-1" }, "opencode"),
    ];
    const result = await dropEventsCoveredByNative(events);
    expect(result.skippedNativeCovered).toBe(0);
    expect(result.events).toHaveLength(1);
  });

  it("looks only inside the batch's own time window", async () => {
    mockNativeRows([]);
    await dropEventsCoveredByNative([
      event("2026-10-25T10:00:00.000Z", { collector: "transcript", "host.name": "workstation-1" }),
    ]);
    // The lookup is a raw, host-scoped query: it returns only the native rows
    // that could cover one of the batch's own machines.
    const sql = (queryRaw.mock.calls[0][0] as { text: string; values: unknown[] });
    expect(sql.text).toContain("json_extract(metadata");
    expect(sql.text).toContain("occurredAt >=");
    const values = (sql as unknown as { values: unknown[] }).values;
    expect(values.some((value) => value instanceof Date)).toBe(true);
  });
});
