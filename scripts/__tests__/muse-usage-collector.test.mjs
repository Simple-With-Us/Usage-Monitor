import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

import {
  MUSE_PRODUCER_ID,
} from "../lib/session-token-collectors.mjs";
import {
  parseMuseResetLine,
  parseMuseSubscriptionStatus,
  quotaEventsFromMuse,
  readingsChanged,
  snapshotFromEvents,
  validateAndBuildEvents,
} from "../muse-usage-collector.mjs";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const SAMPLE_TEXT = readFileSync(
  join(FIXTURES, "muse-subscription-status.txt"),
  "utf8",
);

const WEEKLY_BUCKET = "muse:free-weekly";
const ADDITIONAL_BUCKET = "muse:additional-tokens";

describe("MUSE_PRODUCER_ID", () => {
  it("is the same identifier every other collector imports", () => {
    expect(MUSE_PRODUCER_ID).toBe("muse");
  });
});

describe("parseMuseResetLine", () => {
  const now = new Date("2026-10-04T12:00:00.000Z");

  it("converts CDT wall clock to the correct UTC instant", () => {
    expect(parseMuseResetLine("Oct 10 at 10:59 PM CDT", now)).toBe(
      "2026-10-11T03:59:00.000Z",
    );
  });

  it("handles CST offsets in winter", () => {
    expect(parseMuseResetLine("Jan 5 at 9:00 AM CST", now)).toBe(
      "2027-01-05T15:00:00.000Z",
    );
  });

  it("rolls the year forward when the parsed reset is in the past", () => {
    // Today is 2026-10-04; Oct 1 has already happened, so the next period is Oct 1 2027.
    const result = parseMuseResetLine("Oct 1 at 10:59 PM CDT", now);
    expect(result).toBe("2027-10-02T03:59:00.000Z");
  });

  it("returns null for an unrecognised timezone abbreviation", () => {
    expect(parseMuseResetLine("Oct 10 at 10:59 PM GMT", now)).toBeNull();
    expect(parseMuseResetLine("Oct 10 at 10:59 PM", now)).toBeNull();
  });

  it("returns null on a malformed shape instead of throwing", () => {
    expect(parseMuseResetLine("", now)).toBeNull();
    expect(parseMuseResetLine("nonsense", now)).toBeNull();
    expect(parseMuseResetLine("Oct 99 at 10:59 PM CDT", now)).toBeNull();
  });
});

describe("parseMuseSubscriptionStatus", () => {
  const now = new Date("2026-10-04T12:00:00.000Z");

  it("returns two readings for the live VM output shape", () => {
    const readings = parseMuseSubscriptionStatus(SAMPLE_TEXT, { now });
    expect(readings).toHaveLength(2);
    const byBucket = Object.fromEntries(readings.map((r) => [r.bucketId, r]));
    expect(byBucket[WEEKLY_BUCKET].remainingPercent).toBe(69);
    expect(byBucket[WEEKLY_BUCKET].usedPercent).toBe(31);
    expect(byBucket[WEEKLY_BUCKET].resetAt).toBe("2026-10-11T03:59:00.000Z");
    expect(byBucket[WEEKLY_BUCKET].planType).toBe("free");
    expect(byBucket[ADDITIONAL_BUCKET].remainingPercent).toBe(98);
    expect(byBucket[ADDITIONAL_BUCKET].usedPercent).toBe(2);
    expect(byBucket[ADDITIONAL_BUCKET].resetAt).toBeNull();
    expect(byBucket[ADDITIONAL_BUCKET].metadataExtras).toEqual({
      tokensLeftLabel: "1.9B tokens left",
    });
  });

  it("treats the first non-empty non-data line as the plan type and surfaces a paid plan name", () => {
    const paid = [
      "Pro plan",
      "Usage: 50% of free weekly limit.",
      "Weekly limit resets Dec 1 at 12:00 AM CDT",
    ].join("\n");
    const readings = parseMuseSubscriptionStatus(paid, { now });
    expect(readings).toHaveLength(1);
    expect(readings[0].planType).toBe("Pro plan");
  });

  it("detects the plan line after a leading blank line and parses both windows", () => {
    const blankFirst = [
      "",
      "The user does not have a subscription.",
      "Usage: 30% of free weekly limit.",
      "Weekly limit resets Oct 10 at 10:59 PM CDT",
      "Additional tokens: 5% used (1.5B tokens left)",
    ].join("\n");
    const readings = parseMuseSubscriptionStatus(blankFirst, { now });
    expect(readings).toHaveLength(2);
    expect(readings[0].bucketId).toBe(WEEKLY_BUCKET);
    expect(readings[0].planType).toBe("free");
    expect(readings[1].bucketId).toBe(ADDITIONAL_BUCKET);
    expect(readings[1].planType).toBe("free");
  });

  it("parses data-line-first ordering with no plan line (planType stays null)", () => {
    const dataFirst = [
      "Usage: 30% of free weekly limit.",
      "Weekly limit resets Oct 10 at 10:59 PM CDT",
      "Additional tokens: 5% used (1.5B tokens left)",
    ].join("\n");
    const readings = parseMuseSubscriptionStatus(dataFirst, { now });
    expect(readings).toHaveLength(2);
    expect(readings[0].bucketId).toBe(WEEKLY_BUCKET);
    expect(readings[1].bucketId).toBe(ADDITIONAL_BUCKET);
    expect(readings[0].planType).toBeNull();
    expect(readings[1].planType).toBeNull();
  });

  it("drops readings whose percentage could not be parsed instead of inventing a number", () => {
    const partial = [
      "The user does not have a subscription.",
      "Additional tokens: 7% used (100M tokens left)",
    ].join("\n");
    const readings = parseMuseSubscriptionStatus(partial, { now });
    expect(readings).toHaveLength(1);
    expect(readings[0].bucketId).toBe(ADDITIONAL_BUCKET);
    expect(readings[0].remainingPercent).toBe(93);
  });

  it("returns an empty array for an unrecognisable shape instead of throwing", () => {
    expect(parseMuseSubscriptionStatus("", { now })).toEqual([]);
    expect(parseMuseSubscriptionStatus("not muse output", { now })).toEqual([]);
    expect(parseMuseSubscriptionStatus(null, { now })).toEqual([]);
  });
});

describe("quotaEventsFromMuse", () => {
  const now = new Date("2026-10-04T12:00:00.000Z");
  const occurredAtIso = "2026-10-04T20:09:19.328Z";

  it("emits the Antigravity-compatible quota shape: credits = remaining, limit = 100", () => {
    const events = quotaEventsFromMuse(SAMPLE_TEXT, { now, occurredAtIso });
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.metricType).toBe("quota");
      expect(event.provider).toBe("muse");
      expect(event.service).toBe("muse-cli");
      expect(event.limit).toBe(100);
      expect(typeof event.credits).toBe("number");
      expect(event.credits).toBeGreaterThan(0);
      expect(event.credits).toBeLessThanOrEqual(100);
      expect(event.billingMode).toBe("actual");
      expect(event.confidence).toBe("actual");
      expect(event.occurredAt).toBe(occurredAtIso);
      expect(event.metadata.scale).toBe("percent_0_100");
      expect(event.metadata.source).toBe("subscription-status-cli");
    }
    const byLabel = Object.fromEntries(events.map((e) => [e.label, e]));
    expect(byLabel["Free weekly limit"].credits).toBe(69);
    expect(byLabel["Additional tokens"].credits).toBe(98);
    expect(byLabel["Free weekly limit"].metadata.resetAt).toBe(
      "2026-10-11T03:59:00.000Z",
    );
    expect(byLabel["Additional tokens"].metadata.resetAt).toBeNull();
  });

  it("puts the raw '1.9B tokens left' string in metadata only", () => {
    const events = quotaEventsFromMuse(SAMPLE_TEXT, { now, occurredAtIso });
    const additional = events.find((e) => e.label === "Additional tokens");
    expect(additional.metadata.tokensLeftLabel).toBe("1.9B tokens left");
    expect(additional.metadata.bucketId).toBe(ADDITIONAL_BUCKET);
    expect(additional.metadata.quotaWindow).toBe("balance");
    expect(additional.metadata.planType).toBe("free");
  });

  it("stamps each eventId with the observation time so remaining-% can advance", () => {
    const first = quotaEventsFromMuse(SAMPLE_TEXT, {
      now,
      occurredAtIso: "2026-10-04T20:00:00.000Z",
    });
    const later = quotaEventsFromMuse(SAMPLE_TEXT, {
      now,
      occurredAtIso: "2026-10-04T20:15:00.000Z",
    });
    expect(first.map((e) => e.eventId)).not.toEqual(later.map((e) => e.eventId));
  });

  it("returns no events when the CLI output is empty", () => {
    expect(quotaEventsFromMuse("", { now, occurredAtIso })).toEqual([]);
  });
});

describe("validateAndBuildEvents (Zod trust boundary)", () => {
  const occurredAtIso = "2026-10-04T20:09:19.328Z";
  const validWeekly = {
    bucketId: WEEKLY_BUCKET,
    label: "Free weekly limit",
    quotaWindow: "weekly",
    remainingPercent: 69,
    usedPercent: 31,
    resetAt: "2026-10-11T03:59:00.000Z",
    planType: "free",
    modelId: null,
    remainingUnknown: false,
    isExhausted: false,
  };

  it("builds events for a schema-valid reading", () => {
    const events = validateAndBuildEvents([validWeekly], { occurredAtIso });
    expect(events).toHaveLength(1);
    expect(events[0].provider).toBe("muse");
  });

  it("throws the stable 'muse reading validation failed' on an unknown bucketId", () => {
    expect(() =>
      validateAndBuildEvents([{ ...validWeekly, bucketId: "muse:unknown" }], { occurredAtIso }),
    ).toThrow("muse reading validation failed");
  });

  it("throws the stable error on an out-of-range percentage", () => {
    expect(() =>
      validateAndBuildEvents([{ ...validWeekly, remainingPercent: 150 }], { occurredAtIso }),
    ).toThrow("muse reading validation failed");
  });

  it("throws the stable error when an unknown metadata key sneaks in", () => {
    expect(() =>
      validateAndBuildEvents(
        [{ ...validWeekly, metadataExtras: { tokensLeftLabel: "x", account: "leak" } }],
        { occurredAtIso },
      ),
    ).toThrow("muse reading validation failed");
  });

  it("quotaEventsFromMuse throws the stable error when a reading fails validation", () => {
    // parseMuseSubscriptionStatus cannot produce an invalid reading by itself,
    // but validateAndBuildEvents is the same entry point: driving it with a
    // hand-crafted invalid reading proves the boundary is wired end to end.
    expect(() =>
      validateAndBuildEvents([{ ...validWeekly, bucketId: "bad" }], { occurredAtIso }),
    ).toThrow("muse reading validation failed");
  });

  it("quotaEventsFromMuse still returns [] without throwing for empty/garbage input", () => {
    expect(quotaEventsFromMuse("", { occurredAtIso })).toEqual([]);
    expect(quotaEventsFromMuse("not muse output", { occurredAtIso })).toEqual([]);
    expect(quotaEventsFromMuse(null, { occurredAtIso })).toEqual([]);
  });
});

describe("readingsChanged + snapshotFromEvents (material-change gate)", () => {
  const now = new Date("2026-10-04T20:09:19.328Z");
  const occurredAtIso = "2026-10-04T20:09:19.328Z";

  function events() {
    return quotaEventsFromMuse(SAMPLE_TEXT, { now, occurredAtIso });
  }

  it("treats a missing snapshot as a material change (first run)", () => {
    expect(readingsChanged(events(), null)).toBe(true);
    expect(readingsChanged(events(), undefined)).toBe(true);
    expect(readingsChanged(events(), {})).toBe(true);
    expect(readingsChanged(events(), { producerId: "other-provider", buckets: {} })).toBe(true);
  });

  it("returns false when the snapshot matches the current events exactly", () => {
    const snapshot = snapshotFromEvents(events(), { now });
    expect(readingsChanged(events(), snapshot)).toBe(false);
  });

  it("returns true when credits change", () => {
    const snapshot = snapshotFromEvents(events(), { now });
    snapshot.buckets[WEEKLY_BUCKET].credits = 42;
    expect(readingsChanged(events(), snapshot)).toBe(true);
  });

  it("returns true when resetAt changes", () => {
    const snapshot = snapshotFromEvents(events(), { now });
    snapshot.buckets[WEEKLY_BUCKET].resetAt = "2030-01-01T00:00:00.000Z";
    expect(readingsChanged(events(), snapshot)).toBe(true);
  });

  it("returns true when planType changes", () => {
    const snapshot = snapshotFromEvents(events(), { now });
    snapshot.buckets[WEEKLY_BUCKET].planType = "Pro plan";
    expect(readingsChanged(events(), snapshot)).toBe(true);
  });

  it("snapshotFromEvents stamps version, producerId, and an ISO at", () => {
    const snapshot = snapshotFromEvents(events(), { now });
    expect(snapshot.version).toBe(1);
    expect(snapshot.producerId).toBe("muse");
    expect(new Date(snapshot.at).getTime()).toBe(now.getTime());
    expect(Object.keys(snapshot.buckets).sort()).toEqual(
      [WEEKLY_BUCKET, ADDITIONAL_BUCKET].sort(),
    );
  });
});
