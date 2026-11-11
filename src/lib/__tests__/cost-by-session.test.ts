import { describe, expect, it } from "vitest";
import {
  MAX_SESSION_IDS,
  buildCostBySessionReport,
  parseSessionIdsParam,
  type CostBySessionRow,
} from "../cost-by-session";

// buildCostBySessionReport is a pure reducer over already-aggregated rows --
// no `new Date()` inside it, so there is no wall clock to freeze here (see
// the wall-clock-test-rot memory note). Timestamps below are fixed literals
// purely as readable fixture data.

function row(overrides: Partial<CostBySessionRow> = {}): CostBySessionRow {
  return {
    sessionId: "session-a",
    metricType: "usage",
    unit: "token",
    model: "claude-sonnet-5",
    label: "token:input",
    quantity: 0,
    costUsd: 0,
    eventCount: 1,
    firstOccurredAt: new Date("2026-09-24T12:00:00Z"),
    lastOccurredAt: new Date("2026-09-24T12:00:00Z"),
    ...overrides,
  };
}

describe("parseSessionIdsParam", () => {
  function params(query: string): URLSearchParams {
    return new URLSearchParams(query);
  }

  it("splits comma-separated ids, trims, and de-dups while preserving order", () => {
    const result = parseSessionIdsParam(params("ids=a, b ,a,c"));
    expect(result).toEqual({ ids: ["a", "b", "c"] });
  });

  it("merges repeated ids= params with comma-separated ones", () => {
    const result = parseSessionIdsParam(params("ids=a&ids=b,c"));
    expect(result).toEqual({ ids: ["a", "b", "c"] });
  });

  it("errors when no ids are supplied", () => {
    expect(parseSessionIdsParam(params(""))).toEqual({ error: "ids_required" });
    expect(parseSessionIdsParam(params("ids=,,"))).toEqual({ error: "ids_required" });
  });

  it("errors when more than MAX_SESSION_IDS distinct ids are supplied", () => {
    const many = Array.from({ length: MAX_SESSION_IDS + 1 }, (_, i) => `s${i}`).join(",");
    const result = parseSessionIdsParam(params(`ids=${many}`));
    expect("error" in result).toBe(true);
  });

  it("accepts exactly MAX_SESSION_IDS distinct ids", () => {
    const many = Array.from({ length: MAX_SESSION_IDS }, (_, i) => `s${i}`).join(",");
    const result = parseSessionIdsParam(params(`ids=${many}`));
    expect("ids" in result && result.ids).toHaveLength(MAX_SESSION_IDS);
  });
});

describe("buildCostBySessionReport", () => {
  it("splits requested ids into matched and unmatched", () => {
    const report = buildCostBySessionReport(
      ["session-a", "session-missing"],
      [row({ sessionId: "session-a" })]
    );
    expect(report.matchedSessionIds).toEqual(["session-a"]);
    expect(report.unmatchedSessionIds).toEqual(["session-missing"]);
    expect(report.sessions).toHaveLength(1);
  });

  it("buckets token rows by label into the right token type", () => {
    const rows: CostBySessionRow[] = [
      row({ label: "token:input", quantity: 100 }),
      row({ label: "token:output", quantity: 20 }),
      row({ label: "token:cacheRead", quantity: 5 }),
      row({ label: "token:cacheCreation", quantity: 2 }),
      row({ label: "token:weird-future-type", quantity: 1 }),
      row({ label: null, quantity: 1 }),
    ];
    const report = buildCostBySessionReport(["session-a"], rows);
    const session = report.sessions[0];
    expect(session.tokens).toEqual({
      input: 100,
      output: 20,
      cacheRead: 5,
      cacheCreation: 2,
      unknown: 2,
      total: 129,
    });
  });

  it("sums costUsd only from metricType=cost rows, not usage/token rows", () => {
    const rows: CostBySessionRow[] = [
      row({ metricType: "usage", unit: "token", quantity: 1000, costUsd: 0 }),
      row({ metricType: "cost", unit: null, label: "estimated_api_equivalent", quantity: 0, costUsd: 0.5 }),
      row({ metricType: "cost", unit: null, label: "estimated_api_equivalent", quantity: 0, costUsd: 0.25 }),
    ];
    const report = buildCostBySessionReport(["session-a"], rows);
    expect(report.sessions[0].costUsd).toBeCloseTo(0.75);
    expect(report.sessions[0].tokens.total).toBe(1000);
  });

  it("aggregates independently per session and rolls totals across all matched sessions", () => {
    const rows: CostBySessionRow[] = [
      row({ sessionId: "session-a", metricType: "cost", costUsd: 1, label: "estimated_api_equivalent" }),
      row({ sessionId: "session-a", metricType: "usage", unit: "token", label: "token:input", quantity: 100 }),
      row({ sessionId: "session-b", metricType: "cost", costUsd: 2, label: "estimated_api_equivalent" }),
      row({ sessionId: "session-b", metricType: "usage", unit: "token", label: "token:output", quantity: 50 }),
    ];
    const report = buildCostBySessionReport(["session-a", "session-b"], rows);
    expect(report.sessions.map((s) => s.sessionId)).toEqual(["session-a", "session-b"]);
    expect(report.totals.costUsd).toBeCloseTo(3);
    expect(report.totals.tokens.total).toBe(150);
    expect(report.totals.tokens.input).toBe(100);
    expect(report.totals.tokens.output).toBe(50);
  });

  it("collects distinct sorted models and the widest occurredAt span per session", () => {
    const rows: CostBySessionRow[] = [
      row({
        model: "claude-opus-5",
        firstOccurredAt: new Date("2026-09-24T12:30:00Z"),
        lastOccurredAt: new Date("2026-09-24T12:30:00Z"),
      }),
      row({
        model: "claude-sonnet-5",
        firstOccurredAt: new Date("2026-09-24T10:00:00Z"),
        lastOccurredAt: new Date("2026-09-24T14:00:00Z"),
      }),
      row({ model: "claude-opus-5" }),
    ];
    const report = buildCostBySessionReport(["session-a"], rows);
    const session = report.sessions[0];
    expect(session.models).toEqual(["claude-opus-5", "claude-sonnet-5"]);
    expect(session.firstSeenAt).toBe("2026-09-24T10:00:00.000Z");
    expect(session.lastSeenAt).toBe("2026-09-24T14:00:00.000Z");
  });

  it("returns an empty report shape when nothing matches", () => {
    const report = buildCostBySessionReport(["session-x"], []);
    expect(report.matchedSessionIds).toEqual([]);
    expect(report.unmatchedSessionIds).toEqual(["session-x"]);
    expect(report.sessions).toEqual([]);
    expect(report.totals).toEqual({
      eventCount: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, unknown: 0, total: 0 },
      costUsd: 0,
    });
  });

  it("always reports the analytics-only cost semantics, never cash", () => {
    const report = buildCostBySessionReport(["session-a"], [row()]);
    expect(report.billingMode).toBe("estimated");
    expect(report.costSemantics).toBe("estimated_api_equivalent_not_authoritative");
  });
});
