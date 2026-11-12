import { describe, expect, it } from "vitest";
import { planSubscriptionRenewals } from "@/lib/budget-status";

describe("planSubscriptionRenewals", () => {
  const now = new Date("2026-08-05T12:00:00.000Z");

  it("walks auto-renew weekly charges through month end", () => {
    const lines = planSubscriptionRenewals(
      [
        {
          id: "sub-1",
          providerId: "p1",
          name: "Weekly plan",
          costUsd: 10,
          currency: "USD",
          interval: "weekly",
          intervalCount: 1,
          nextRenewalAt: new Date("2026-08-08T00:00:00.000Z"),
          autoRenew: true,
        },
      ],
      now
    );
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines.every((l) => l.chargeUsd === 10)).toBe(true);
    expect(lines.reduce((s, l) => s + l.chargeUsd, 0)).toBe(lines.length * 10);
  });

  it("includes a one-term next bill when autoRenew is false", () => {
    const lines = planSubscriptionRenewals(
      [
        {
          id: "grok",
          providerId: "xai",
          name: "Grok SuperGrok",
          costUsd: 99,
          currency: "USD",
          interval: "monthly",
          intervalCount: 1,
          nextRenewalAt: new Date("2026-08-20T00:00:00.000Z"),
          autoRenew: false,
        },
      ],
      now
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].chargeUsd).toBe(99);
    expect(lines[0].name).toBe("Grok SuperGrok");
    expect(lines[0].autoRenew).toBe(false);
  });

  it("skips past renewals and non-USD", () => {
    const lines = planSubscriptionRenewals(
      [
        {
          id: "past",
          providerId: "p",
          name: "Past",
          costUsd: 50,
          currency: "USD",
          interval: "monthly",
          intervalCount: 1,
          nextRenewalAt: new Date("2026-08-01T00:00:00.000Z"),
          autoRenew: false,
        },
        {
          id: "eur",
          providerId: "p",
          name: "Euro",
          costUsd: 50,
          currency: "EUR",
          interval: "monthly",
          intervalCount: 1,
          nextRenewalAt: new Date("2026-08-15T00:00:00.000Z"),
          autoRenew: true,
        },
      ],
      now
    );
    expect(lines).toHaveLength(0);
  });
});
