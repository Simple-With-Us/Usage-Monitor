import { describe, expect, it } from "vitest";
import { truncatePlanText } from "../quota-plan-metadata";
import { projectQuotaWindows } from "../quota-windows";
import { quotaWindowsClientResponseSchema } from "../quota-windows-client-schema";
import { parseUsageTelemetryV2Batch } from "../usage-telemetry";
import { projectQuotaPlanMetadata } from "../quota-plan-metadata";

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

  it("reads plan metadata from the raw-query JSON-string shape", () => {
    // `loadLatestQuotaWindowEvents` uses `prisma.$queryRaw`, which returns the
    // SQLite JSON column as TEXT rather than a deserialized object.  Projecting
    // that shape must still surface planMetadata/planName, on the primary path
    // and on the object-shaped `findMany` fallback alike.
    const plan = { planDetectedName: "Max 20x", planUserName: "Team", planType: "Max 20x" };
    const response = projectQuotaWindows([
      { provider: "claude", occurredAt: now, credits: 50, metadata: JSON.stringify({ source: "codecaps", ...plan }) },
      { provider: "anthropic", occurredAt: now, credits: 50, metadata: { source: "codecaps", ...plan } },
    ], now);

    const expected = {
      detectedPlanName: "Max 20x", userPlanName: "Team", hasMismatch: false,
    };
    // Both fixtures must actually reach `windows`; without the length assertion
    // a row that failed to project would be skipped by the loop below and the
    // test would still pass.
    expect(response.windows).toHaveLength(2);
    for (const row of response.windows) {
      expect(row.planName).toBe("Max 20x");
      expect(row.planMetadata).toEqual(expected);
    }
    // "claude" normalizes to the canonical "anthropic" key and neither fixture
    // carries a label/modelId/bucketId, so both land in ONE window bucket: one
    // becomes `primary` and the other a `source`.  Asserting `primary` alone
    // would compare identical fixture data and pass whichever candidate won,
    // leaving the other shape's grouped metadata unasserted.
    const group = response.quotaGroups?.find((g) => g.provider === response.windows[0].providerKey);
    const readings = [group!.windows[0].primary, ...group!.windows[0].sources];
    expect(readings).toHaveLength(2);
    for (const reading of readings) {
      expect(reading.planMetadata).toEqual(expected);
      expect(reading.planName).toBe("Max 20x");
    }
  });

  it("treats malformed and non-object quota metadata as an empty record", () => {
    for (const metadata of ["{not json", "[]", '"a string"', "null", 42, null, undefined]) {
      const response = projectQuotaWindows(
        [{ provider: "claude", occurredAt: now, credits: 50, metadata }], now);
      expect(response.windows[0].planName).toBeFalsy();
      expect(response.windows[0].planMetadata).toBeUndefined();
    }
  });

  it.each([
    [{ planDetectedName: "Detected", planType: "Type", planName: "Legacy", planUserName: "User" }, "Detected"],
    [{ planType: "Type", planName: "Legacy", planUserName: "User" }, "Type"],
    [{ planName: "Legacy", planUserName: "User" }, "Legacy"],
    // A present-but-unusable planType must not shadow a usable planName behind it.
    [{ planType: "   ", planName: "Legacy", planUserName: "User" }, "Legacy"],
    [{ planType: 42, planName: "Legacy", planUserName: "User" }, "Legacy"],
    [{ planType: "", planName: "Legacy" }, "Legacy"],
    [{ planUserName: "User" }, undefined],
  ])("projects legacy detected plan without substituting user entry: %j", (plan, expected) => {
    const response = projectQuotaWindows([{ provider: "claude", occurredAt: now, credits: 50,
      metadata: { source: "codecaps", ...plan },
    }], now);
    expect(response.windows[0].planName).toBe(expected);
    const group = response.quotaGroups?.find((g) => g.provider === response.windows[0].providerKey);
    expect(group?.windows[0].primary.planName).toBe(expected);
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

  it("sanitizes pre-existing lone surrogates below the new bound", async () => {
    const legacy = "x".repeat(499) + "\ud83d";
    expect(truncatePlanText(legacy, 1024)).toBe("x".repeat(499));
    expect(truncatePlanText("a\udc00b\ud800c😀", 1024)).toBe("abc😀");
    const response = projectQuotaWindows([{ provider: "claude", occurredAt: now, credits: 50,
      metadata: { planUserSubtitle: legacy },
    }], now);
    expect(response.windows[0].planMetadata?.userSubtitle).toBe("x".repeat(499));
    const parsed = await parseUsageTelemetryV2Batch({ schemaVersion: 2, producerId: "codecaps", events: [{
      eventId: "legacy-surrogate", provider: "claude", metricType: "quota",
      occurredAt: now.toISOString(), metadata: { planUserSubtitle: legacy },
    }] });
    expect(parsed.events[0].metadata?.planUserSubtitle).toBe("x".repeat(499));
  });

  it("never emits a lone surrogate when truncating astral characters", () => {
    // A lone surrogate survives JSON.parse in JS, but Foundation's JSONDecoder
    // rejects it -- costing iOS the whole quota response, not just this field.
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    // 1023 filler units put the emoji's leading surrogate exactly on the 1024 cut.
    for (const value of ["s".repeat(1023) + "\u{1F600}", "\u{1F600}"]) {
      const projected = projectQuotaPlanMetadata({ planUserSubtitle: value });
      expect(projected?.userSubtitle).not.toMatch(loneSurrogate);
      expect(projected?.userSubtitle).toHaveLength(Math.min(value.length, 1023));
    }
    // Under the bound an astral character is preserved intact.
    expect(projectQuotaPlanMetadata({ planUserSubtitle: "\u{1F600}" })?.userSubtitle).toBe("\u{1F600}");
  });

  it("sanitizes metadata keys, not just metadata values", async () => {
    // A lone surrogate in a producer key is persisted as an object key;
    // JSON.stringify then emits it as an escape Foundation's JSONDecoder
    // rejects, costing the client the whole usage-event payload.
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    const parsed = await parseUsageTelemetryV2Batch({ schemaVersion: 2, producerId: "codecaps", events: [{
      eventId: "lone-surrogate-key", provider: "claude", metricType: "quota",
      occurredAt: now.toISOString(),
      metadata: { [`planUserSubtitle\ud83d`]: "value", planUserName: "Team" },
    }] });
    const parsedMetadata = parsed.events[0].metadata ?? {};
    for (const key of Object.keys(parsedMetadata)) expect(key).not.toMatch(loneSurrogate);
    expect(JSON.parse(JSON.stringify(parsedMetadata))).toEqual(parsedMetadata);
  });

  it("sanitizes the legacy detected-plan fallback, not just projected metadata", async () => {
    // A row stored by the old value.slice(0, 500) can end in a lone surrogate.
    // The legacy planType/planName fallback publishes it as planName, which would
    // make Foundation's JSONDecoder reject the whole quota response.
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    const legacyPlanType = "x".repeat(499) + "\ud83d";
    const legacyPlanName = "a\udc00b\ud800c";

    // Direct projection of the unsanitized stored value, as the DB would hand it over.
    const direct = projectQuotaWindows([{ provider: "claude", occurredAt: now, credits: 50,
      metadata: { source: "codecaps", planType: legacyPlanType },
    }], now);
    expect(direct.windows[0].planName).toBe("x".repeat(256));
    expect(direct.windows[0].planName).not.toMatch(loneSurrogate);

    for (const plan of [{ planType: legacyPlanType }, { planName: legacyPlanName }]) {
      const response = projectQuotaWindows([{ provider: "claude", occurredAt: now, credits: 50,
        metadata: { source: "codecaps", ...plan },
      }], now);
      const row = response.windows[0];
      expect(row.planName).toBeDefined();
      expect(row.planName).not.toMatch(loneSurrogate);
      const primary = response.quotaGroups?.find((g) => g.provider === row.providerKey)?.windows[0].primary;
      expect(primary?.planName).toBe(row.planName);
      expect(JSON.parse(JSON.stringify(response))).toEqual(response);
    }
  });

  it("prefers the projected detected plan over the sanitized legacy fallback", () => {
    const response = projectQuotaWindows([{ provider: "claude", occurredAt: now, credits: 50,
      metadata: { source: "codecaps", planDetectedName: "Detected", planType: "x".repeat(499) + "\ud83d" },
    }], now);
    expect(response.windows[0].planName).toBe("Detected");
  });

});
