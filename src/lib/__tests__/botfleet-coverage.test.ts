import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: { externalUsageEvent: { findMany: (...args: unknown[]) => findMany(...args) } },
}));

import {
  BOTFLEET_TURN_MARGIN_MS,
  botFleetTurnSpan,
  dropEventsCoveredByBotFleet,
  isBotFleetTaggedChildEvent,
} from "../botfleet-coverage";
import { oneSidedCorrelationKeys, withoutMetadataKeys } from "../telemetry-correlation";
import type { ParsedUsageTelemetryEvent } from "../usage-telemetry";

function child(
  occurredAt: string,
  metadata: Record<string, string | number | boolean | null>,
  sourceApp = "claude-code"
): ParsedUsageTelemetryEvent {
  return {
    sourceApp,
    provider: "anthropic",
    service: "claude-code",
    billingMode: "estimated",
    metricType: "usage",
    confidence: "estimated",
    occurredAt: new Date(occurredAt),
    metadata,
    idempotencyKey: `k-${occurredAt}-${JSON.stringify(metadata)}`,
  };
}

const TAGGED = { "agent.launcher": "botfleet", "session.id": "child-1" };
const ON = { BOTFLEET_CHILD_COVERAGE_DROP: "1" };

/** A stored BotFleet turn that reported its usage, unless overridden. */
function botFleetTurn(
  settledAt: string,
  metadata: Record<string, string | boolean | null>,
  quantity = 12_345
) {
  return { occurredAt: new Date(settledAt), metadata: { usageReported: true, ...metadata }, quantity };
}

describe("BotFleet coverage", () => {
  beforeEach(() => {
    findMany.mockReset();
  });

  it("only treats tagged, session-bearing, non-BotFleet rows as candidates", () => {
    expect(isBotFleetTaggedChildEvent(child("2026-10-29T10:00:00Z", TAGGED))).toBe(true);
    expect(isBotFleetTaggedChildEvent(child("2026-10-29T10:00:00Z", { "session.id": "child-1" }))).toBe(false);
    expect(isBotFleetTaggedChildEvent(child("2026-10-29T10:00:00Z", { "agent.launcher": "botfleet" }))).toBe(false);
    expect(isBotFleetTaggedChildEvent(child("2026-10-29T10:00:00Z", TAGGED, "botfleet"))).toBe(false);
  });

  it("does not query when nothing in the batch is tagged", async () => {
    const events = [child("2026-10-29T10:00:00Z", { "session.id": "child-1" })];
    const result = await dropEventsCoveredByBotFleet(events, ON);
    expect(result).toEqual({ events, skippedBotFleetCovered: 0 });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("drops a tagged child row a stored BotFleet turn names and spans", async () => {
    findMany.mockResolvedValue([
      botFleetTurn("2026-10-29T10:05:00Z", {
        childSessionId: "child-1",
        turnStartedAt: "2026-10-29T09:58:00Z",
      }),
    ]);
    const covered = child("2026-10-29T10:00:00Z", TAGGED);
    const otherSession = child("2026-10-29T10:00:00Z", { ...TAGGED, "session.id": "child-2" });
    const untagged = child("2026-10-29T10:00:00Z", { "session.id": "child-1" });
    const result = await dropEventsCoveredByBotFleet([covered, otherSession, untagged], ON);
    expect(result.skippedBotFleetCovered).toBe(1);
    expect(result.events).toEqual([otherSession, untagged]);
  });

  it("keeps a tagged child row outside the turn, even for the same session", async () => {
    findMany.mockResolvedValue([
      botFleetTurn("2026-10-29T10:05:00Z", {
        childSessionId: "child-1",
        turnStartedAt: "2026-10-29T09:58:00Z",
      }),
    ]);
    const earlier = child("2026-10-29T09:50:00Z", TAGGED);
    const result = await dropEventsCoveredByBotFleet([earlier], ON);
    expect(result.skippedBotFleetCovered).toBe(0);
    expect(result.events).toEqual([earlier]);
  });

  it("keeps everything when the BotFleet turn lacks a child session id or start time", async () => {
    findMany.mockResolvedValue([
      botFleetTurn("2026-10-29T10:05:00Z", { childSessionId: "child-1" }),
      botFleetTurn("2026-10-29T10:05:00Z", { turnStartedAt: "2026-10-29T09:58:00Z" }),
    ]);
    const events = [child("2026-10-29T10:00:00Z", TAGGED)];
    const result = await dropEventsCoveredByBotFleet(events, ON);
    expect(result.skippedBotFleetCovered).toBe(0);
    expect(result.events).toEqual(events);
  });

  it("drops nothing and reads nothing unless BOTFLEET_CHILD_COVERAGE_DROP=1", async () => {
    findMany.mockResolvedValue([
      botFleetTurn("2026-10-29T10:05:00Z", {
        childSessionId: "child-1",
        turnStartedAt: "2026-10-29T09:58:00Z",
      }),
    ]);
    const events = [child("2026-10-29T10:00:00Z", TAGGED)];
    const result = await dropEventsCoveredByBotFleet(events, {});
    expect(result).toEqual({ events, skippedBotFleetCovered: 0 });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("keeps the child rows of a turn that billed nothing", async () => {
    const span = { childSessionId: "child-1", turnStartedAt: "2026-10-29T09:58:00Z" };
    findMany.mockResolvedValue([
      // A failed or interrupted turn: the child's rows are the only record.
      botFleetTurn("2026-10-29T10:05:00Z", { ...span, usageReported: false, usageGap: "failed" }, 0),
      botFleetTurn("2026-10-29T10:05:00Z", { ...span, usageGap: "unreported" }),
      botFleetTurn("2026-10-29T10:05:00Z", span, 0),
    ]);
    const events = [child("2026-10-29T10:00:00Z", TAGGED)];
    const result = await dropEventsCoveredByBotFleet(events, ON);
    expect(result.skippedBotFleetCovered).toBe(0);
    expect(result.events).toEqual(events);
  });

  it("widens a turn by the clock margin on both ends", () => {
    const span = botFleetTurnSpan(
      botFleetTurn("2026-10-29T10:05:00Z", {
        childSessionId: "child-1",
        turnStartedAt: "2026-10-29T09:58:00Z",
      })
    );
    expect(span?.startMs).toBe(Date.parse("2026-10-29T09:58:00Z") - BOTFLEET_TURN_MARGIN_MS);
    expect(span?.endMs).toBe(Date.parse("2026-10-29T10:05:00Z") + BOTFLEET_TURN_MARGIN_MS);
    expect(
      botFleetTurnSpan(
        botFleetTurn("2026-10-29T10:05:00Z", { childSessionId: "c", turnStartedAt: "not a date" })
      )
    ).toBeNull();
  });
});

describe("correlation keys in replay comparison", () => {
  it("names only the correlation keys one side lacks", () => {
    expect(
      oneSidedCorrelationKeys(
        { tokenType: "input", collector: "transcript" },
        { tokenType: "input", collector: "transcript", "session.id": "s", "agent.launcher": "botfleet" }
      ).sort()
    ).toEqual(["agent.launcher", "session.id"]);
    // Present on both sides: compared as usual, so not ignored.
    expect(oneSidedCorrelationKeys({ "session.id": "a" }, { "session.id": "b" })).toEqual([]);
    // Non-correlation keys are never ignored.
    expect(oneSidedCorrelationKeys({}, { project: "x", tokenType: "input" })).toEqual([]);
  });

  it("strips the named keys and leaves null when nothing remains", () => {
    expect(withoutMetadataKeys({ "session.id": "s", a: 1 }, ["session.id"])).toEqual({ a: 1 });
    expect(withoutMetadataKeys({ "session.id": "s" }, ["session.id"])).toBeNull();
    const untouched = { a: 1 };
    expect(withoutMetadataKeys(untouched, ["session.id"])).toBe(untouched);
  });
});
