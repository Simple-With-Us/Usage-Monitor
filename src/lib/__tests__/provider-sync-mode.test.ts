import { describe, expect, it } from "vitest";
import {
  effectivePollDueIntervalMs,
  formatProviderSyncLabel,
  MAX_POLL_FRESHNESS_MS,
  resolveProviderSyncMode,
} from "@/lib/provider-sync-mode";

describe("resolveProviderSyncMode", () => {
  it("marks voyage and roic as manual", () => {
    expect(resolveProviderSyncMode({ name: "voyage", type: "builtin" })).toBe(
      "manual"
    );
    expect(resolveProviderSyncMode({ name: "ROIC.ai", type: "builtin" })).toBe(
      "manual"
    );
  });

  it("marks push/generic as manual", () => {
    expect(resolveProviderSyncMode({ name: "anything", type: "push" })).toBe(
      "manual"
    );
    expect(resolveProviderSyncMode({ name: "anything", type: "generic" })).toBe(
      "manual"
    );
  });

  it("marks xai as poll", () => {
    expect(resolveProviderSyncMode({ name: "xai", type: "builtin" })).toBe(
      "poll"
    );
  });
});

describe("effectivePollDueIntervalMs", () => {
  it("caps long intervals at 60 minutes", () => {
    expect(effectivePollDueIntervalMs(1440)).toBe(MAX_POLL_FRESHNESS_MS);
    expect(effectivePollDueIntervalMs(90)).toBe(MAX_POLL_FRESHNESS_MS);
  });

  it("keeps short intervals", () => {
    expect(effectivePollDueIntervalMs(15)).toBe(15 * 60 * 1000);
    expect(effectivePollDueIntervalMs(60)).toBe(60 * 60 * 1000);
  });
});

describe("formatProviderSyncLabel", () => {
  it("returns Manually only for never-pollable providers", () => {
    expect(
      formatProviderSyncLabel({
        syncMode: "manual",
        latestFetchedAt: null,
        nowMs: Date.now(),
        formatRelative: () => "never",
      })
    ).toBe("Manually only");
  });

  it("returns Never synced when pollable but no fetch yet", () => {
    expect(
      formatProviderSyncLabel({
        syncMode: "poll",
        latestFetchedAt: null,
        nowMs: Date.now(),
        formatRelative: () => "x",
      })
    ).toBe("Never synced");
  });
});
