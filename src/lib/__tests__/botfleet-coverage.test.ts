import { describe, expect, it, vi } from "vitest";

const { findMany } = vi.hoisted(() => ({
  findMany: vi.fn(() => { throw new Error("Coverage must not query the database"); }),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { externalUsageEvent: { findMany } },
}));

import { dropEventsCoveredByBotFleet } from "../botfleet-coverage";
import { oneSidedCorrelationKeys, withoutMetadataKeys } from "../telemetry-correlation";
import type { ParsedUsageTelemetryEvent } from "../usage-telemetry";

describe("BotFleet coverage preserves calls without exact billing proof", () => {
  it.each([{}, { BOTFLEET_CHILD_COVERAGE_DROP: "0" }, { BOTFLEET_CHILD_COVERAGE_DROP: "1" }])(
    "keeps all rows without querying even with flag %j", async (env) => {
      const events: ParsedUsageTelemetryEvent[] = ["claude-code", "botfleet"].map((sourceApp) => ({
        sourceApp,
        provider: "anthropic",
        service: "claude-code",
        billingMode: "estimated",
        metricType: "usage",
        confidence: "estimated",
        quantity: 100,
        occurredAt: new Date("2026-10-29T10:00:00Z"),
        idempotencyKey: sourceApp,
        metadata: {
          "agent.launcher": "botfleet",
          "session.id": "child-1",
          childSessionId: "child-1",
          usageReported: true,
          turnStartedAt: "2026-10-29T09:58:00Z",
        },
      }));
      const result = await dropEventsCoveredByBotFleet(events, env);
      expect(result.events).toBe(events);
      expect(result.skippedBotFleetCovered).toBe(0);
      expect(findMany).not.toHaveBeenCalled();
    }
  );
});

describe("correlation keys in replay comparison", () => {
  it("ignores only keys absent on one side and still compares changed values", () => {
    expect(oneSidedCorrelationKeys({}, {
      "session.id": "s", "agent.launcher": "botfleet", "agent.launcher.session": "thread",
    }).sort()).toEqual(["agent.launcher", "agent.launcher.session", "session.id"]);
    expect(oneSidedCorrelationKeys({ "session.id": "a" }, { "session.id": "b" })).toEqual([]);
    expect(oneSidedCorrelationKeys({}, { project: "x", tokenType: "input" })).toEqual([]);
  });

  it("strips the named keys and leaves null when nothing remains", () => {
    expect(withoutMetadataKeys({ "session.id": "s", a: 1 }, ["session.id"])).toEqual({ a: 1 });
    expect(withoutMetadataKeys({ "session.id": "s" }, ["session.id"])).toBeNull();
    const untouched = { a: 1 };
    expect(withoutMetadataKeys(untouched, ["session.id"])).toBe(untouched);
  });
});
