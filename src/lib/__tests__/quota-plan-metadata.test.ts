import { describe, expect, it } from "vitest";
import { projectQuotaWindows } from "../quota-windows";
import { quotaWindowsClientResponseSchema } from "../quota-windows-client-schema";
import { parseUsageTelemetryV2Batch } from "../usage-telemetry";

const now = new Date("2026-10-20T12:00:00.000Z");
const metadata = {
  source: "codecaps", remainingUnknown: true, planName: "Max 20x",
  planDetectedName: "Max 20x", planUserName: "Team", planUserCostUsd: "200",
  planUserRenewalDateText: "r".repeat(512), planUserSubtitle: "s".repeat(1024),
  planShowCostAndRenewal: false, planHasMismatch: true, privateToken: "never project",
};

describe("CodeCaps plan metadata", () => {
  it("retains bounded scalars through v2 parsing and projection without inventing quota", async () => {
    const parsed = await parseUsageTelemetryV2Batch({
      schemaVersion: 2, producerId: "codecaps", events: [{
        eventId: "plan-only", provider: "claude", metricType: "quota",
        occurredAt: now.toISOString(), metadata,
      }],
    });
    expect(parsed.rejected).toBe(0);
    const response = projectQuotaWindows(parsed.events, now);
    const row = response.windows[0];
    expect(row).toMatchObject({
      remainingPercent: null, remainingUnknown: true, isExhausted: false,
      status: "unknown", skip: false, planName: "Max 20x",
      planMetadata: {
        detectedPlanName: "Max 20x", userPlanName: "Team", userCostUsd: "200",
        userRenewalDateText: metadata.planUserRenewalDateText,
        userSubtitle: metadata.planUserSubtitle,
        showCostAndRenewal: false, hasMismatch: true,
      },
    });
    expect(response.skipModelTypes).toEqual([]);
    expect(row.planMetadata).not.toHaveProperty("privateToken");
    const primary = response.quotaGroups?.find((g) => g.provider === row.providerKey)?.windows[0].primary;
    expect(primary?.planMetadata).toEqual(row.planMetadata);
    expect(quotaWindowsClientResponseSchema.parse(response).quotaGroups?.find((g) => g.provider === row.providerKey)?.windows[0].primary.planMetadata).toEqual(row.planMetadata);
  });

  it("keeps legacy events additive and bounds only selected fields", () => {
    const response = projectQuotaWindows([{ provider: "claude", occurredAt: now, credits: 50,
      metadata: { planName: "Pro", planUserSubtitle: "x".repeat(1200), privateToken: "secret" },
    }], now);
    expect(response.windows[0].planMetadata).toEqual({ hasMismatch: false, userSubtitle: "x".repeat(1024) });
    expect(response.windows[0].planName).toBe("Pro");
    expect(projectQuotaWindows([{ provider: "claude", occurredAt: now, credits: 50 }], now).windows[0]).not.toHaveProperty("planMetadata");
  });

  it("retains bounds in partial batches and still rejects malformed scalar metadata", async () => {
    const parsed = await parseUsageTelemetryV2Batch({ schemaVersion: 2, producerId: "codecaps", events: [
      { eventId: "valid", provider: "claude", metricType: "quota", metadata },
      { eventId: "invalid", provider: "claude", metadata: { planUserSubtitle: { nested: true } } },
    ] });
    expect(parsed.rejected).toBe(1);
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0].metadata?.planUserSubtitle).toBe(metadata.planUserSubtitle);
    expect(parsed.events[0].metadata?.privateToken).toBe("never project");
  });

  it("keeps the shared metadata entry cap and normalized-key collision semantics", async () => {
    const capped = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`key${i}`, "x"]));
    const parsed = await parseUsageTelemetryV2Batch({ schemaVersion: 2, producerId: "codecaps", events: [
      { eventId: "cap", provider: "claude", metadata: { ...capped, planUserSubtitle: "hidden" } },
      { eventId: "collision", provider: "claude", metadata: {
        planUserSubtitle: "s".repeat(1024), " planUserSubtitle ": null,
        arbitrary: "x".repeat(1024),
      } },
    ] });
    expect(parsed.events[0].metadata).not.toHaveProperty("planUserSubtitle");
    expect(parsed.events[1].metadata?.planUserSubtitle).toBeNull();
    expect(parsed.events[1].metadata?.arbitrary).toHaveLength(500);
  });

});
