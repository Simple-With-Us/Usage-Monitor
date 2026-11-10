import { describe, it, expect } from "vitest";
import { buildAgentModelMixReport, type AgentModelMixRow } from "../agent-model-mix";

// Fixed literal fixtures — buildAgentModelMixReport never calls `new Date()`
// internally, so no vi.useFakeTimers() is needed (see local memory note
// "wall-clock test rot").
const WINDOW_START = new Date("2026-09-17T00:00:00.000Z");
const WINDOW_END = new Date("2026-09-24T00:00:00.000Z");
const GENERATED_AT = new Date("2026-09-24T01:23:45.000Z");
const DAYS = 7;

function row(overrides: Partial<AgentModelMixRow>): AgentModelMixRow {
  return {
    sourceApp: "claude-code",
    provider: "anthropic",
    model: "claude-sonnet-5",
    seat: null,
    project: null,
    tokens: 0,
    costUsd: 0,
    eventCount: 0,
    ...overrides,
  };
}

describe("buildAgentModelMixReport", () => {
  it("echoes the supplied window/days/generatedAt verbatim (no internal clock)", () => {
    const report = buildAgentModelMixReport([], WINDOW_START, WINDOW_END, DAYS, GENERATED_AT);

    expect(report.windowStart).toBe("2026-09-17T00:00:00.000Z");
    expect(report.windowEnd).toBe("2026-09-24T00:00:00.000Z");
    expect(report.days).toBe(DAYS);
    expect(report.generatedAt).toBe("2026-09-24T01:23:45.000Z");
  });

  it("stamps the fixed cost-semantics / billing-mode markers", () => {
    const report = buildAgentModelMixReport([], WINDOW_START, WINDOW_END, DAYS, GENERATED_AT);

    expect(report.costSemantics).toBe("estimated_api_equivalent_not_authoritative");
    expect(report.billingMode).toBe("estimated");
  });

  it("sums tokens/costUsd/eventCount across all rows into totals", () => {
    const rows = [
      row({ tokens: 1000, costUsd: 1, eventCount: 5 }),
      row({ sourceApp: "codex-cli", provider: "openai", tokens: 2000, costUsd: 2, eventCount: 3 }),
    ];

    const report = buildAgentModelMixReport(rows, WINDOW_START, WINDOW_END, DAYS, GENERATED_AT);

    expect(report.totals).toEqual({ tokens: 3000, costUsd: 3, eventCount: 8 });
    expect(report.rows).toHaveLength(2);
  });

  it("sorts rows by tokens desc, then costUsd desc, then sourceApp/provider/model asc", () => {
    const rows = [
      row({ sourceApp: "grok-build", tokens: 500, costUsd: 5 }),
      row({ sourceApp: "codex-cli", tokens: 1500, costUsd: 1 }),
      row({ sourceApp: "claude-code", tokens: 1500, costUsd: 9 }),
      row({ sourceApp: "deepseek-dsh", tokens: 500, costUsd: 5, provider: "aaa-provider" }),
    ];

    const report = buildAgentModelMixReport(rows, WINDOW_START, WINDOW_END, DAYS, GENERATED_AT);

    expect(report.rows.map((r) => r.sourceApp)).toEqual([
      "claude-code",
      "codex-cli",
      "deepseek-dsh",
      "grok-build",
    ]);
  });

  it("computes seatDataAvailable true only when at least one row has a non-null seat", () => {
    const withoutSeats = buildAgentModelMixReport(
      [row({ seat: null }), row({ seat: null, sourceApp: "codex-cli" })],
      WINDOW_START,
      WINDOW_END,
      DAYS,
      GENERATED_AT
    );
    expect(withoutSeats.seatDataAvailable).toBe(false);

    const withOneSeat = buildAgentModelMixReport(
      [row({ seat: null }), row({ seat: "MONET", sourceApp: "codex-cli" })],
      WINDOW_START,
      WINDOW_END,
      DAYS,
      GENERATED_AT
    );
    expect(withOneSeat.seatDataAvailable).toBe(true);
  });

  it("preserves seat/project/model fields per row, including nulls", () => {
    const rows = [
      row({ model: null, seat: null, project: "usage-monitor" }),
      row({ sourceApp: "codex-cli", model: "gpt-5-codex", seat: "CLAUDE", project: null }),
    ];

    const report = buildAgentModelMixReport(rows, WINDOW_START, WINDOW_END, DAYS, GENERATED_AT);

    const claudeRow = report.rows.find((r) => r.sourceApp === "claude-code");
    const codexRow = report.rows.find((r) => r.sourceApp === "codex-cli");
    expect(claudeRow).toMatchObject({ model: null, seat: null, project: "usage-monitor" });
    expect(codexRow).toMatchObject({ model: "gpt-5-codex", seat: "CLAUDE", project: null });
  });

  it("returns an empty report (zeroed totals, no rows) for an empty input", () => {
    const report = buildAgentModelMixReport([], WINDOW_START, WINDOW_END, DAYS, GENERATED_AT);

    expect(report.rows).toEqual([]);
    expect(report.totals).toEqual({ tokens: 0, costUsd: 0, eventCount: 0 });
    expect(report.seatDataAvailable).toBe(false);
  });
});
