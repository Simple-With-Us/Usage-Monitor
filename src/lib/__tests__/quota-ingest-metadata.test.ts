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
