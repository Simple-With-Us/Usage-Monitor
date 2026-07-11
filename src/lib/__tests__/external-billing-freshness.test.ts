import { describe, expect, it } from "vitest";
import { isExternalBillingStale } from "../external-billing-freshness";

describe("isExternalBillingStale", () => {
  const now = Date.parse("2026-07-11T12:00:00.000Z");

  it("honors the caller's refresh-derived stale threshold", () => {
    const record = { syncedAt: "2026-07-11T10:00:00.000Z" };
    expect(isExternalBillingStale(record, 60 * 60 * 1_000, now)).toBe(true);
    expect(isExternalBillingStale(record, 3 * 60 * 60 * 1_000, now)).toBe(false);
  });

  it("treats invalid timestamps as stale", () => {
    expect(isExternalBillingStale({ syncedAt: "not-a-date" }, 60_000, now)).toBe(true);
  });
});
