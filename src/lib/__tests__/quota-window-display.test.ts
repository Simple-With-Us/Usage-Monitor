import { describe, expect, it } from "vitest";

import {
  normalizeQuotaWindowKey,
  normalizeQuotaWindowKeyFromAnthropicKey,
  quotaWindowDisplayName,
} from "../quota-window-display";

describe("quota window display mapping", () => {
  const nowMs = new Date("2026-10-12T12:00:00.000Z").getTime();

  it("maps standard Anthropic keys", () => {
    expect(normalizeQuotaWindowKeyFromAnthropicKey("five_hour")).toEqual({
      windowKey: "5h",
      rawKey: "five_hour",
    });
    expect(normalizeQuotaWindowKeyFromAnthropicKey("seven_day_opus", "opus")).toEqual({
      windowKey: "7d",
      rawKey: "seven_day_opus",
    });
    expect(quotaWindowDisplayName({ windowKey: "5h", rawKey: "five_hour" })).toBe("5-hour");
    expect(quotaWindowDisplayName({ windowKey: "7d:opus", rawKey: "seven_day_opus" })).toBe("7-day");
  });

  it("maps unknown Anthropic keys to Other Limit copy", () => {
    const { windowKey, rawKey } = normalizeQuotaWindowKeyFromAnthropicKey("iguana_necktie");
    expect(windowKey).toBe("other:iguana_necktie");
    expect(
      quotaWindowDisplayName({
        windowKey,
        rawKey,
        resetAt: "2026-10-12T17:00:00.000Z",
        nowMs,
      }),
    ).toMatch(/^other-limit · resets /);
  });

  it("normalizes bucket ids and labels", () => {
    expect(
      normalizeQuotaWindowKey({
        bucketId: "anthropic:five_hour",
        quotaWindow: "5h",
      }).windowKey,
    ).toBe("5h");
    expect(
      normalizeQuotaWindowKey({
        label: "7d window (Opus)",
        modelId: "opus",
      }).windowKey,
    ).toBe("7d");
  });

  it("normalizes raw quotaWindow names from live box collectors", () => {
    expect(normalizeQuotaWindowKey({ quotaWindow: "five_hour" })).toEqual({
      windowKey: "5h",
      rawKey: "five_hour",
    });
    expect(normalizeQuotaWindowKey({ quotaWindow: "seven_day" })).toEqual({
      windowKey: "7d",
      rawKey: "seven_day",
    });
    expect(normalizeQuotaWindowKey({ quotaWindow: "weekly" }).windowKey).toBe("7d");
  });
});
