import { describe, expect, it } from "vitest";
import {
  formatAgentMoneyValue,
  formatAgentSeatPrimary,
  formatAgentTokenValue,
  isReliableTokenTelemetryKind,
  resolveTelemetryAccuracy,
  telemetryIncompleteNoteFor,
} from "../agent-telemetry-accuracy";

describe("agent-telemetry-accuracy", () => {
  it("treats character-estimate and none feeds as not reported even when a number exists", () => {
    const antigravity = resolveTelemetryAccuracy({
      name: "Antigravity",
      tokenTelemetryKind: "character_estimate",
      totalTokens: 12_000,
      isRunningOnMac: true,
      unavailableReason:
        "Antigravity does not expose token telemetry.  Local transcript character estimates are not usage.  This is not zero use.",
    });
    expect(antigravity.accuracy).toBe("unavailable");
    expect(antigravity.usageIsReliable).toBe(false);
    expect(antigravity.label).toBe("not reported");
    expect(antigravity.note).toContain("not zero use");

    const cursor = resolveTelemetryAccuracy({
      name: "Cursor",
      tokenTelemetryKind: "none",
      totalTokens: 0,
      isRunningOnMac: true,
    });
    expect(cursor.accuracy).toBe("unavailable");
    expect(cursor.label).toBe("not reported");
    expect(cursor.note).toContain("This is not zero usage.");
  });

  it("does not treat a running seat with zero events as confirmed idle", () => {
    const grok = resolveTelemetryAccuracy({
      name: "Grok Build & Leader",
      tokenTelemetryKind: "session_jsonl",
      totalTokens: 0,
      isRunningOnMac: true,
    });
    expect(grok.accuracy).toBe("unavailable");
    expect(grok.usageIsReliable).toBe(false);
    expect(grok.note).toContain("not confirmed as zero usage");
  });

  it("keeps idle OTLP zero as a window empty, not a missing feed", () => {
    const claude = resolveTelemetryAccuracy({
      name: "Claude Code / Desktop",
      tokenTelemetryKind: "otlp",
      totalTokens: 0,
      isRunningOnMac: false,
    });
    expect(claude.accuracy).toBe("none_in_window");
    expect(claude.usageIsReliable).toBe(true);
    expect(claude.label).toBe("no events in this window");
  });

  it("treats billing_api telemetry as reliable when tokens are present", () => {
    expect(isReliableTokenTelemetryKind("billing_api")).toBe(true);
    const cursor = resolveTelemetryAccuracy({
      name: "Cursor",
      tokenTelemetryKind: "billing_api",
      totalTokens: 50_000,
      isRunningOnMac: false,
    });
    expect(cursor.usageIsReliable).toBe(true);
    expect(cursor.note).toContain("Admin API");
  });

  it("marks idle session-jsonl zero as not a confirmed zero", () => {
    const codex = resolveTelemetryAccuracy({
      name: "OpenAI Codex",
      tokenTelemetryKind: "session_jsonl",
      totalTokens: 0,
      isRunningOnMac: false,
    });
    expect(codex.usageIsReliable).toBe(false);
    expect(codex.label).toBe("not reported");
    expect(codex.note).toContain("not a confirmed zero");
  });

  it("formats display values without pretending zero is usage", () => {
    expect(
      formatAgentTokenValue(
        { usageIsReliable: false, totalTokens: 0 },
        (n) => String(n),
      ),
    ).toBe("not reported");
    expect(
      formatAgentMoneyValue(
        { usageIsReliable: false },
        0,
        (n) => `$${n.toFixed(2)}`,
      ),
    ).toBe("not reported");
    expect(
      formatAgentSeatPrimary({
        monthlySeatCostUsd: 70,
        bundledOffsetUsd: 30,
      }),
    ).toBe("$70/mo net");
    expect(
      formatAgentSeatPrimary({
        monthlySeatCostUsd: 20,
        bundledOffsetUsd: null,
      }),
    ).toBe("$20/mo");
    expect(
      formatAgentSeatPrimary({
        monthlySeatCostUsd: 0,
        bundledOffsetUsd: 200,
      }),
    ).toBe("Not billed");
  });

  it("names omitted seats in the incomplete-totals note", () => {
    expect(telemetryIncompleteNoteFor(["Antigravity"])).toContain("Antigravity");
    expect(telemetryIncompleteNoteFor(["Antigravity", "Cursor"])).toContain(
      "Antigravity and Cursor",
    );
    expect(
      isReliableTokenTelemetryKind("character_estimate"),
    ).toBe(false);
    expect(isReliableTokenTelemetryKind("otlp")).toBe(true);
  });
});
