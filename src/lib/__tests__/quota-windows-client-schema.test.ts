import { describe, expect, it } from "vitest";
import {
  quotaSourceReadingSchema,
  quotaWindowsClientResponseSchema,
} from "../quota-windows-client-schema";

describe("quotaWindowsClientResponseSchema", () => {
  it("accepts legacy windows-only payloads", () => {
    const result = quotaWindowsClientResponseSchema.safeParse({
      windows: [{ id: "a", provider: "anthropic", label: "5h window" }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects quotaGroups with invalid primary readings", () => {
    const result = quotaWindowsClientResponseSchema.safeParse({
      windows: [],
      quotaGroups: [
        {
          provider: "anthropic",
          providerLabel: "Claude",
          windows: [
            {
              windowKey: "5h",
              displayName: "5-hour",
              rawKey: "5h",
              platformTitle: null,
              primary: { source: "x" },
              sources: [],
            },
          ],
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe("quotaSourceReadingSchema", () => {
  it("requires freshness enum and reportedAt", () => {
    expect(
      quotaSourceReadingSchema.safeParse({
        source: "codecaps",
        sourceLabel: "CodeCaps",
        machine: null,
        collector: null,
        remainingPercent: 80,
        remainingUnknown: false,
        isExhausted: false,
        resetAt: null,
        reportedAt: "2026-10-12T00:00:00.000Z",
        freshness: "fresh",
      }).success,
    ).toBe(true);
  });
});
