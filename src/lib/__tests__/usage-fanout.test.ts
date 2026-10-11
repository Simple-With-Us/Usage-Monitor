import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const recordFleetInfraMetric = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@/lib/sentry-fleet", () => ({
  recordFleetInfraMetric,
}));

import {
  fanoutAgentTurns,
  fanoutPersistedUsage,
  fanoutPollSnapshot,
} from "@/lib/usage-fanout";

beforeEach(() => {
  recordFleetInfraMetric.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fanoutPersistedUsage", () => {
  it("is a no-op for an empty batch", async () => {
    await fanoutPersistedUsage([], "ingest/usage");
    expect(recordFleetInfraMetric).not.toHaveBeenCalled();
  });

  it("aggregates by provider/platform/model and emits a total", async () => {
    await fanoutPersistedUsage(
      [
        { provider: "cursor", sourceApp: "cursor-agent", model: "gpt-5", costUsd: 0.1 },
        { provider: "cursor", sourceApp: "cursor-agent", model: "gpt-5", costUsd: 0.2 },
        { provider: "anthropic", sourceApp: "claude-code", model: "sonnet", costUsd: 1 },
      ],
      "otlp/v1/metrics"
    );
    const names = recordFleetInfraMetric.mock.calls.map((call) => call[0]);
    expect(names.filter((name) => name === "usage.persisted")).toHaveLength(2);
    expect(names).toContain("usage.persisted_total");
    const total = recordFleetInfraMetric.mock.calls.find((call) => call[0] === "usage.persisted_total");
    expect(total?.[1]).toBe(3);
  });

  it("caps group envelopes so a large batch cannot fan out 100 events", async () => {
    const events = Array.from({ length: 40 }, (_, i) => ({
      provider: `p${i}`,
      sourceApp: `app${i}`,
      model: `m${i}`,
      costUsd: 1,
    }));
    await fanoutPersistedUsage(events, "ingest/usage");
    const groupCalls = recordFleetInfraMetric.mock.calls.filter((call) => call[0] === "usage.persisted");
    expect(groupCalls).toHaveLength(10);
  });
});

describe("fanoutPollSnapshot", () => {
  it("emits a snapshot counter and optional cost gauge", async () => {
    await fanoutPollSnapshot("openai", { totalCost: 12.5, balance: 3 });
    expect(recordFleetInfraMetric).toHaveBeenCalledWith(
      "poll.snapshot",
      1,
      expect.objectContaining({ provider: "openai", source: "poll-snapshot" })
    );
    expect(recordFleetInfraMetric).toHaveBeenCalledWith(
      "poll.snapshot.cost_usd",
      12.5,
      expect.objectContaining({ provider: "openai" })
    );
  });
});

describe("fanoutAgentTurns", () => {
  it("never includes prompt text and counts errors per platform", async () => {
    await fanoutAgentTurns([
      { platform: "cursor-agent", error: null },
      { platform: "cursor-agent", error: "boom" },
      { platform: "botfleet" },
    ]);
    expect(recordFleetInfraMetric).toHaveBeenCalledWith(
      "agent.turn",
      2,
      expect.objectContaining({ platform: "cursor-agent", errors: 1, source: "otlp-traces" })
    );
    const serialized = JSON.stringify(recordFleetInfraMetric.mock.calls);
    expect(serialized).not.toContain("prompt");
    expect(serialized).not.toContain("boom");
  });
});
