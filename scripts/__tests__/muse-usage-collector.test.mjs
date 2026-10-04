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
} from "../muse-usage-collector.mjs";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const SAMPLE_TEXT = readFileSync(
  join(FIXTURES, "muse-subscription-status.txt"),
  "utf8",
);

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
    expect(byBucket["free-weekly"].remainingPercent).toBe(69);
    expect(byBucket["free-weekly"].usedPercent).toBe(31);
    expect(byBucket["free-weekly"].resetAt).toBe("2026-10-11T03:59:00.000Z");
    expect(byBucket["free-weekly"].planType).toBe("free");
    expect(byBucket["additional-tokens"].remainingPercent).toBe(98);
    expect(byBucket["additional-tokens"].usedPercent).toBe(2);
    expect(byBucket["additional-tokens"].resetAt).toBeNull();
    expect(byBucket["additional-tokens"].metadataExtras).toEqual({
      tokensLeftLabel: "1.9B tokens left",
    });
  });

  it("treats the first line as the plan type and surfaces a paid plan name", () => {
    const paid = [
      "Pro plan",
      "Usage: 50% of free weekly limit.",
      "Weekly limit resets Dec 1 at 12:00 AM CDT",
    ].join("\n");
    const readings = parseMuseSubscriptionStatus(paid, { now });
    expect(readings).toHaveLength(1);
    expect(readings[0].planType).toBe("Pro plan");
  });

  it("drops readings whose percentage could not be parsed instead of inventing a number", () => {
    const partial = [
      "The user does not have a subscription.",
      "Additional tokens: 7% used (100M tokens left)",
    ].join("\n");
    const readings = parseMuseSubscriptionStatus(partial, { now });
    expect(readings).toHaveLength(1);
    expect(readings[0].bucketId).toBe("additional-tokens");
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
    expect(additional.metadata.bucketId).toBe("additional-tokens");
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