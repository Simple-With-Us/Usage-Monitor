import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { deriveUsageTelemetryV2IdempotencyKey } from "@jaywedgeworth22/congress-trading-shared";
import senderFixture from "./fixtures/botfleet-singlecall-v2.json";

const { findMany, deriveKey } = vi.hoisted(() => ({
  findMany: vi.fn(),
  deriveKey: vi.fn(),
}));
vi.mock("@jaywedgeworth22/congress-trading-shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@jaywedgeworth22/congress-trading-shared")>();
  deriveKey.mockImplementation(actual.deriveUsageTelemetryV2IdempotencyKey);
  return { ...actual, deriveUsageTelemetryV2IdempotencyKey: deriveKey };
});
vi.mock("@/lib/prisma", () => ({
  prisma: { externalUsageEvent: { findMany } },
}));

import { dropEventsCoveredByBotFleet, stampBotFleetReceiptCredential } from "../botfleet-coverage";
import { oneSidedCorrelationKeys, withoutMetadataKeys } from "../telemetry-correlation";
import type { ParsedUsageTelemetryEvent } from "../usage-telemetry";
import { parseUsageTelemetryV2Batch } from "../usage-telemetry";

beforeEach(() => findMany.mockReset().mockResolvedValue([]));
const issuer = { credentialId: "botfleet", token: "test-only-issuer", allowedSourceApps: new Set(["botfleet"]) };
const enabledEnv = { BOTFLEET_CHILD_COVERAGE_DROP: "1", USAGE_INGEST_PRODUCER_TOKENS: `botfleet:${issuer.token}` };

const child = (extra: Record<string, unknown> = {}): ParsedUsageTelemetryEvent => ({
  sourceApp: "claude-code", provider: "anthropic", service: "claude-code", billingMode: "estimated",
  metricType: "usage", confidence: "estimated", unit: "token", quantity: 5, keyRef: "claude-test", idempotencyKey: "child-output",
  occurredAt: new Date("2026-10-30T12:00:00Z"),
  metadata: { "agent.launcher": "botfleet", "session.id": "child-1", "call.id": "msg-1", model: "claude-test", tokenType: "output", _producerInstanceId: "host-a", ...extra },
});

async function receipt(extra: Record<string, unknown> = {}) {
  const eventId = `bf-call-v1:${createHash("sha256").update(JSON.stringify(["child-1", "msg-1"])).digest("hex")}`;
  const event: ParsedUsageTelemetryEvent = {
    idempotencyKey: await deriveUsageTelemetryV2IdempotencyKey({ producerId: "botfleet", eventId }),
    sourceApp: "botfleet", provider: "anthropic", metricType: "usage", unit: "token", quantity: 20, requests: 1,
    billingMode: "estimated", confidence: "estimated", occurredAt: new Date("2026-10-30T12:00:00Z"),
    metadata: {
      _usageTelemetrySchemaVersion: 2, _producerEventId: eventId, _producerInstanceId: "host-a", _botFleetReceiptCredential: "botfleet-v1",
      childHarness: "claudeAgent", childSessionId: "child-1", usageReported: true,
      billedCallProofVersion: 1, billedCallId: "msg-1", billedCallModel: "claude-test",
      billedCallOutput: 5, billedCallCacheRead: 3, billedCallCacheWrite: 2,
      _aiModelServed: "claude-test", _aiHarness: "botfleet", _aiSource: "block",
      _aiTokensInput: 10, _aiTokensOutput: 5, _aiTokensCacheRead: 3,
      _aiTokensCacheWrite5m: 2, _aiTokensCacheWrite1h: 0, ...extra,
    },
  };
  return stampBotFleetReceiptCredential([event], issuer)[0];
}

describe("exact single-call billing receipts", () => {
  it.each(["_botFleetReceiptCredential", "_botFleetReceiptSignature"])("keeps rows without authenticated %s", async (key) => {
    const row = await receipt();
    delete row.metadata![key];
    findMany.mockResolvedValue([row]);
    const events = [child()];
    expect((await dropEventsCoveredByBotFleet(events, enabledEnv)).events).toBe(events);
  });

  it("rejects a forged pre-rollout marker and signature", async () => {
    const row = await receipt();
    row.metadata!._botFleetReceiptSignature = "0".repeat(64);
    findMany.mockResolvedValue([row]);
    const events = [child()];
    expect((await dropEventsCoveredByBotFleet(events, enabledEnv)).events).toBe(events);
  });

  it("binds a valid signature to the receipt host", async () => {
    const row = await receipt();
    row.metadata!._producerInstanceId = "other-host";
    findMany.mockResolvedValue([row]);
    const events = [child({ _producerInstanceId: "other-host" })];
    expect((await dropEventsCoveredByBotFleet(events, enabledEnv)).events).toBe(events);
  });

  it("accepts an overlapping issuer key but fails open after its retirement", async () => {
    findMany.mockResolvedValue([await receipt()]);
    const events = [child()];
    expect((await dropEventsCoveredByBotFleet(events, {
      ...enabledEnv, USAGE_INGEST_PRODUCER_TOKENS: `botfleet:replacement-test-key,botfleet:${issuer.token}`,
    })).skippedBotFleetCovered).toBe(1);
    expect((await dropEventsCoveredByBotFleet(events, {
      ...enabledEnv, USAGE_INGEST_PRODUCER_TOKENS: "botfleet:replacement-test-key",
    })).events).toBe(events);
  });

  it("recognizes a real BotFleet sender fixture after shared v2 validation", async () => {
    const parsed = await parseUsageTelemetryV2Batch(senderFixture);
    expect(parsed.rejected).toBe(0);
    expect(parsed.events).toHaveLength(1);
    findMany.mockResolvedValue(stampBotFleetReceiptCredential(parsed.events, issuer));
    const events = [{ ...child({ "session.id": "fixture-session", "call.id": "fixture-call", _producerInstanceId: "fixture-host" }), quantity: 20 }];
    expect((await dropEventsCoveredByBotFleet(events, enabledEnv)).skippedBotFleetCovered).toBe(1);
  });

  it("uses only indexed receipt keys and keeps input and unrelated calls", async () => {
    findMany.mockResolvedValue([await receipt()]);
    const events = [child(), { ...child(), quantity: 3, metadata: { ...child().metadata, tokenType: "cacheRead" } },
      { ...child(), quantity: 2, metadata: { ...child().metadata, tokenType: "cacheCreation" } },
      child({ tokenType: "input" }), child({ "call.id": "other" })];
    const result = await dropEventsCoveredByBotFleet(events, enabledEnv);
    expect(result.events).toEqual(events.slice(3));
    expect(result.skippedBotFleetCovered).toBe(3);
    expect(findMany.mock.calls[0][0].where).toEqual({ idempotencyKey: { in: expect.any(Array) } });
    expect(Object.keys(findMany.mock.calls[0][0].where)).toEqual(["idempotencyKey"]);
  });

  it.each([
    { billedCallProofVersion: 2 }, { billedCallId: "other" }, { childSessionId: "other" },
    { childHarness: "opencodeGo" }, { billedCallModel: "other" }, { _aiModelServed: "other" },
    { billedCallOutput: 4 }, { _aiTokensOutput: 4 }, { _aiTokensInput: undefined },
    { _aiTokensCacheWrite5m: 1 }, { _aiSource: "legacy" }, { _aiHarness: "claude-code" },
    { _producerInstanceId: "other-host" }, { usageReported: false }, { _usageTelemetrySchemaVersion: 1 },
  ])("preserves rows when proof is incomplete or inconsistent: %j", async (change) => {
    findMany.mockResolvedValue([await receipt(change)]);
    const events = [child()];
    expect((await dropEventsCoveredByBotFleet(events, enabledEnv)).events).toBe(events);
  });

  it("preserves rows when lookup fails, receipt is absent, or the child carries cash", async () => {
    const events = [child()];
    findMany.mockRejectedValueOnce(new Error("database unavailable"));
    expect((await dropEventsCoveredByBotFleet(events, enabledEnv)).events).toBe(events);
    expect((await dropEventsCoveredByBotFleet(events, enabledEnv)).events).toBe(events);
    findMany.mockClear();
    const priced = [{ ...child(), costUsd: 1 }];
    expect((await dropEventsCoveredByBotFleet(priced, enabledEnv)).events).toBe(priced);
    expect(findMany).not.toHaveBeenCalled();
  });

  it.each(["input", "constructor", "toString", "__proto__", "unknown"])("keeps unproven token component %s without a query", async (tokenType) => {
    const events = [child({ tokenType })];
    expect((await dropEventsCoveredByBotFleet(events, enabledEnv)).events).toBe(events);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("preserves the candidate if exact-key derivation fails", async () => {
    deriveKey.mockRejectedValueOnce(new Error("hash unavailable"));
    const events = [child()];
    expect((await dropEventsCoveredByBotFleet(events, enabledEnv)).events).toBe(events);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("retains additional claims on the same billed component within a batch", async () => {
    findMany.mockResolvedValue([await receipt()]);
    const events = [child(), { ...child(), idempotencyKey: "second-child-claim" }];
    const result = await dropEventsCoveredByBotFleet(events, enabledEnv);
    expect(result.events).toEqual([events[1]]);
    expect(result.skippedBotFleetCovered).toBe(1);
  });
});

describe("BotFleet coverage preserves calls without exact billing proof", () => {
  it.each([{}, { BOTFLEET_CHILD_COVERAGE_DROP: "0" }, enabledEnv])(
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
