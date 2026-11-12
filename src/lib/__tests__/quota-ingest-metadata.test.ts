import { describe, expect, it } from "vitest";

import {
  enrichQuotaIngestMetadata,
  quotaEventReportedAtIso,
  resolveQuotaReportedAtIso,
  resolveQuotaWindowKeyFromMetadata,
} from "../quota-ingest-metadata";
import { parseUsageTelemetryBatch } from "../usage-telemetry";

describe("enrichQuotaIngestMetadata", () => {
  const ingestTime = new Date("2026-10-12T12:00:00.000Z");

  it("stamps reportedAt, windowKey, and machine on quota events", () => {
    const metadata = enrichQuotaIngestMetadata(
      {
        metricType: "quota",
        occurredAt: new Date("2026-10-12T11:00:00.000Z"),
        label: "5h window",
        metadata: {
          bucketId: "anthropic:five_hour",
          quotaWindow: "5h",
          source: "api.anthropic.com",
        },
      },
      { producerInstanceId: "Mac.Jays.Services", ingestTime },
    );
    expect(metadata?.reportedAt).toBe("2026-10-12T11:00:00.000Z");
    expect(metadata?.windowKey).toBe("5h");
    expect(metadata?.machine).toBe("Mac.Jays.Services");
  });

  it("falls back to ingest time when reportedAt is missing and occurredAt is invalid", () => {
    const reportedAt = resolveQuotaReportedAtIso({
      metadata: {},
      occurredAt: new Date("invalid"),
      ingestTime,
    });
    expect(reportedAt).toBe("2026-10-12T12:00:00.000Z");
  });

  it("prefers producer metadata reportedAt over occurredAt", () => {
    const reportedAt = resolveQuotaReportedAtIso({
      metadata: { reportedAt: "2026-10-12T10:30:00.000Z" },
      occurredAt: new Date("2026-10-12T11:00:00.000Z"),
      ingestTime,
    });
    expect(reportedAt).toBe("2026-10-12T10:30:00.000Z");
  });

  it("derives windowKey from quotaWindow when not stamped", () => {
    expect(
      resolveQuotaWindowKeyFromMetadata({ quotaWindow: "7d", bucketId: "x:seven_day" }, "7d window"),
    ).toBe("7d");
  });

  it("normalizes live box-collector quotaWindow tokens (five_hour, weekly)", () => {
    expect(resolveQuotaWindowKeyFromMetadata({ quotaWindow: "five_hour" }, null)).toBe("5h");
    expect(resolveQuotaWindowKeyFromMetadata({ quotaWindow: "weekly" }, null)).toBe("7d");
  });

  it("uses occurredAt as reportedAt and grok-bot-vm provenance as machine", () => {
    const metadata = enrichQuotaIngestMetadata(
      {
        metricType: "quota",
        occurredAt: new Date("2026-10-12T09:15:00.000Z"),
        label: "weekly window",
        metadata: {
          quotaWindow: "weekly",
          _producerInstanceId: "grok-bot-vm",
        },
      },
      { ingestTime },
    );
    expect(metadata?.reportedAt).toBe("2026-10-12T09:15:00.000Z");
    expect(metadata?.windowKey).toBe("7d");
    expect(metadata?.rawKey).toBe("weekly");
    expect(metadata?.machine).toBe("grok-bot-vm");
  });

  it("leaves non-quota events untouched", () => {
    expect(
      enrichQuotaIngestMetadata({
        metricType: "usage",
        occurredAt: new Date(),
        metadata: { foo: "bar" },
      }),
    ).toEqual({ foo: "bar" });
  });
});

describe("parseUsageTelemetryV2Batch quota enrichment", () => {
  it("adds reportedAt and windowKey before persistence for v2 batches", async () => {
    const { parseUsageTelemetryV2Batch } = await import("../usage-telemetry");
    const parsed = await parseUsageTelemetryV2Batch({
      schemaVersion: 2,
      producerId: "gbu",
      producerInstanceId: "grok-bot-vm",
      events: [
        {
          eventId: "evt-1",
          provider: "grok-bot",
          service: "gbu",
          metricType: "quota",
          billingMode: "actual",
          confidence: "actual",
          limit: 100,
          credits: 40,
          label: "weekly",
          occurredAt: "2026-10-12T09:15:00.000Z",
          metadata: { quotaWindow: "weekly" },
        },
      ],
    });
    const event = parsed.events[0];
    expect(event?.metadata?.reportedAt).toBe("2026-10-12T09:15:00.000Z");
    expect(event?.metadata?.windowKey).toBe("7d");
    expect(event?.metadata?.machine).toBe("grok-bot-vm");
    expect(event?.metadata?._producerInstanceId).toBe("grok-bot-vm");
  });
});

describe("parseUsageTelemetryBatch quota enrichment", () => {
  it("adds reportedAt and windowKey before persistence", () => {
    const [event] = parseUsageTelemetryBatch({
      sourceApp: "claude-code",
      provider: "anthropic",
      service: "claude-code",
      metricType: "quota",
      billingMode: "actual",
      confidence: "actual",
      limit: 100,
      credits: 50,
      label: "5h window",
      occurredAt: "2020-01-01T00:00:00.000Z",
      metadata: {
        bucketId: "anthropic:five_hour",
        quotaWindow: "5h",
        machine: "jay-mac",
      },
    });
    expect(event.metadata?.reportedAt).toBe("2020-01-01T00:00:00.000Z");
    expect(event.metadata?.windowKey).toBe("5h");
    expect(event.metadata?.machine).toBe("jay-mac");
  });
});

describe("quotaEventReportedAtIso", () => {
  it("reads metadata.reportedAt when present", () => {
    expect(
      quotaEventReportedAtIso("2026-10-12T11:00:00.000Z", {
        reportedAt: "2026-10-12T10:00:00.000Z",
      }),
    ).toBe("2026-10-12T10:00:00.000Z");
  });
});
