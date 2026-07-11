import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { NextRequest } from "next/server";
import protobuf from "protobufjs";
import { setupPrismaSqliteTestDb } from "@/lib/__tests__/setup-test-db";

// This test exercises the real POST /api/otlp/v1/metrics route handler
// against a throwaway SQLite file (never the dev `data`/`dev.db`), following
// this repo's convention (see src/lib/__tests__/usage-telemetry.test.ts's
// sibling contract test in congress-trading-shared, and Socratic.Trade's
// documented `DATABASE_URL=file:<tmpdir>/...` pattern) of pointing
// DATABASE_URL at a fresh tmp file before the Prisma client module loads.

let dbPath: string;
let POST: typeof import("../metrics/route").POST;
let prisma: typeof import("@/lib/prisma").prisma;

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "otlp-metrics-test-"));
  dbPath = path.join(dir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.USAGE_INGEST_TOKEN = "test-token-123";

  setupPrismaSqliteTestDb(dbPath);

  ({ POST } = await import("../metrics/route"));
  ({ prisma } = await import("@/lib/prisma"));
}, 60_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (dbPath && fs.existsSync(dbPath)) fs.rmSync(dbPath);
});

beforeEach(async () => {
  await prisma.otlpMetricState.deleteMany();
  await prisma.externalUsageEvent.deleteMany({ where: { sourceApp: "claude-code" } });
  await prisma.provider.deleteMany({ where: { name: { in: ["anthropic", "Anthropic"] } } });
});

// Each call gets its own x-forwarded-for so tests don't share the route
// module's in-memory rate-limit bucket (rate limiting itself isn't what
// these tests are checking; a shared IP across ~10+ requests in one file
// would otherwise start tripping the 10-req/sec limiter as a test-isolation
// artifact, not a real bug).
let ipCounter = 0;
function jsonRequest(body: unknown, headers: Record<string, string> = {}): NextRequest {
  ipCounter += 1;
  return new NextRequest("https://usage.jays.services/api/otlp/v1/metrics", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": `10.0.0.${ipCounter}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const samplePayload = {
  resourceMetrics: [
    {
      resource: {
        attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }],
      },
      scopeMetrics: [
        {
          scope: { name: "com.anthropic.claude_code" },
          metrics: [
            {
              name: "claude_code.cost.usage",
              unit: "USD",
              sum: {
                aggregationTemporality: 2,
                isMonotonic: true,
                dataPoints: [
                  {
                    attributes: [{ key: "model", value: { stringValue: "claude-sonnet-5" } }],
                    startTimeUnixNano: "1751500000000000000",
                    timeUnixNano: "1751500060000000000",
                    asDouble: 0.0231,
                  },
                ],
              },
            },
          ],
        },
      ],
    },
  ],
};

describe("POST /api/otlp/v1/metrics", () => {
  it("rejects requests with no auth header", async () => {
    const res = await POST(jsonRequest(samplePayload));
    expect(res.status).toBe(401);
  });

  it("rejects requests with the wrong token", async () => {
    const res = await POST(jsonRequest(samplePayload, { authorization: "Bearer wrong-token" }));
    expect(res.status).toBe(401);
  });

  it("accepts a valid bearer token and writes a usage row", async () => {
    const res = await POST(jsonRequest(samplePayload, { authorization: "Bearer test-token-123" }));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.accepted).toBe(1);

    const rows = await prisma.externalUsageEvent.findMany({ where: { sourceApp: "claude-code" } });
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe("anthropic");
    expect(rows[0].service).toBe("claude-code");
    expect(rows[0].costUsd).toBeCloseTo(0.0231);
  });

  it("lazily seeds an anthropic Provider row with no budget on first ingest", async () => {
    const before = await prisma.provider.findMany({ where: { name: "anthropic" } });
    expect(before).toHaveLength(0);

    const res = await POST(jsonRequest(samplePayload, { authorization: "Bearer test-token-123" }));
    expect(res.status).toBe(202);

    const after = await prisma.provider.findMany({ where: { name: "anthropic" }, include: { plan: true } });
    expect(after).toHaveLength(1);
    expect(after[0].displayName).toBe("Anthropic (Claude Code)");
    expect(after[0].plan).toBeNull();
  });

  it("does not create a second anthropic provider row if one already exists", async () => {
    await prisma.provider.create({
      data: { name: "anthropic", displayName: "Anthropic", type: "builtin", refreshIntervalMin: 60 },
    });

    const res = await POST(jsonRequest(samplePayload, { authorization: "Bearer test-token-123" }));
    expect(res.status).toBe(202);

    const providers = await prisma.provider.findMany({ where: { name: "anthropic" } });
    expect(providers).toHaveLength(1);
    // The pre-existing row (created by the user via the poll adapter flow)
    // is left untouched, not overwritten.
    expect(providers[0].displayName).toBe("Anthropic");
  });

  it("accepts the x-usage-ingest-token header as an alternative to Authorization", async () => {
    const res = await POST(jsonRequest(samplePayload, { "x-usage-ingest-token": "test-token-123" }));
    expect(res.status).toBe(202);
  });

  it("is idempotent: posting the identical payload twice does not double-count", async () => {
    const first = await POST(jsonRequest(samplePayload, { authorization: "Bearer test-token-123" }));
    expect(first.status).toBe(202);
    const second = await POST(jsonRequest(samplePayload, { authorization: "Bearer test-token-123" }));
    expect(second.status).toBe(202);

    const rows = await prisma.externalUsageEvent.findMany({ where: { sourceApp: "claude-code" } });
    expect(rows).toHaveLength(1);
  });

  it("converts cumulative sums to deltas durably", async () => {
    const first = await POST(
      jsonRequest(samplePayload, { authorization: "Bearer test-token-123" })
    );
    expect(first.status).toBe(202);

    const secondPayload = structuredClone(samplePayload);
    const secondPoint = secondPayload.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0];
    secondPoint.timeUnixNano = "1751500120000000000";
    secondPoint.asDouble = 0.05;
    const second = await POST(
      jsonRequest(secondPayload, { authorization: "Bearer test-token-123" })
    );
    expect(second.status).toBe(202);

    const rows = await prisma.externalUsageEvent.findMany({
      where: { sourceApp: "claude-code" },
      orderBy: { occurredAt: "asc" },
    });
    expect(rows.map((row) => row.costUsd)).toEqual([0.0231, 0.0269]);
    expect(rows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0)).toBeCloseTo(0.05);
    expect(await prisma.otlpMetricState.count()).toBe(1);
  });

  it("ignores out-of-order cumulative points and handles a counter reset", async () => {
    await POST(jsonRequest(samplePayload, { authorization: "Bearer test-token-123" }));
    const later = structuredClone(samplePayload);
    later.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0].timeUnixNano =
      "1751500120000000000";
    later.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0].asDouble = 0.05;
    await POST(jsonRequest(later, { authorization: "Bearer test-token-123" }));

    const stale = structuredClone(samplePayload);
    stale.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0].timeUnixNano =
      "1751500090000000000";
    stale.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0].asDouble = 0.04;
    const staleResponse = await POST(
      jsonRequest(stale, { authorization: "Bearer test-token-123" })
    );
    expect((await staleResponse.json()).ignoredOutOfOrder).toBe(1);

    const reset = structuredClone(samplePayload);
    const resetPoint = reset.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0];
    resetPoint.startTimeUnixNano = "1751500180000000000";
    resetPoint.timeUnixNano = "1751500180000000000";
    resetPoint.asDouble = 0.01;
    await POST(jsonRequest(reset, { authorization: "Bearer test-token-123" }));

    const rows = await prisma.externalUsageEvent.findMany({
      where: { sourceApp: "claude-code" },
      orderBy: { occurredAt: "asc" },
    });
    expect(rows).toHaveLength(3);
    expect(rows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0)).toBeCloseTo(0.06);
    expect(rows[2].metadata).toMatchObject({ otlpCounterReset: true });
  });

  it("persists delta temporality as reported without cumulative state", async () => {
    const delta = structuredClone(samplePayload);
    delta.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.aggregationTemporality = 1;
    delta.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0].asDouble = 0.4;
    await POST(jsonRequest(delta, { authorization: "Bearer test-token-123" }));
    const next = structuredClone(delta);
    next.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0].timeUnixNano =
      "1751500120000000000";
    next.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0].asDouble = 0.5;
    await POST(jsonRequest(next, { authorization: "Bearer test-token-123" }));

    const aggregate = await prisma.externalUsageEvent.aggregate({
      where: { sourceApp: "claude-code" },
      _sum: { costUsd: true },
    });
    expect(aggregate._sum.costUsd).toBeCloseTo(0.9);
    expect(await prisma.otlpMetricState.count()).toBe(0);
  });

  it("uses an explicit metadata allowlist", async () => {
    const payload = structuredClone(samplePayload);
    payload.resourceMetrics[0].resource.attributes.push(
      { key: "user.email", value: { stringValue: "private@example.com" } },
      { key: "project", value: { stringValue: "socratic-trade" } }
    );
    payload.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0].attributes.push({
      key: "session.id",
      value: { stringValue: "secret-session" },
    });
    await POST(jsonRequest(payload, { authorization: "Bearer test-token-123" }));
    const row = await prisma.externalUsageEvent.findFirstOrThrow({
      where: { sourceApp: "claude-code" },
    });
    expect(row.metadata).toMatchObject({ model: "claude-sonnet-5", project: "socratic-trade" });
    expect(row.metadata).not.toMatchObject({ "user.email": expect.anything() });
    expect(row.metadata).not.toMatchObject({ "session.id": expect.anything() });
  });

  it("rejects oversized attribute values during bounded validation", async () => {
    const payload = structuredClone(samplePayload);
    payload.resourceMetrics[0].resource.attributes.push({
      key: "service.version",
      value: { stringValue: "x".repeat(1_025) },
    });
    const response = await POST(
      jsonRequest(payload, { authorization: "Bearer test-token-123" })
    );
    expect(response.status).toBe(400);
  });

  it("tolerates unknown metric names without a 500 and does not persist them", async () => {
    const payload = {
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "claude_code.brand_new_metric.count",
                  sum: { dataPoints: [{ timeUnixNano: "1751500060000000000", asInt: "3" }] },
                },
              ],
            },
          ],
        },
      ],
    };
    const res = await POST(jsonRequest(payload, { authorization: "Bearer test-token-123" }));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.accepted).toBe(0);
    expect(body.unknownMetrics).toEqual([
      { name: "claude_code.brand_new_metric.count", dataPointCount: 1 },
    ]);

    const rows = await prisma.externalUsageEvent.findMany({ where: { sourceApp: "claude-code" } });
    expect(rows).toHaveLength(0);
  });

  it("rejects a gRPC-style content type with a helpful 415", async () => {
    const res = await POST(
      jsonRequest(samplePayload, {
        authorization: "Bearer test-token-123",
        "content-type": "application/grpc",
      })
    );
    expect(res.status).toBe(415);
    const body = await res.json();
    expect(body.error).toMatch(/http\/json|http\/protobuf/);
  });

  it("decodes a valid application/x-protobuf body", async () => {
    const protoDir = path.join(process.cwd(), "src/lib/otlp/proto");
    const root = new protobuf.Root();
    root.resolvePath = (_origin: string, importPath: string) =>
      path.isAbsolute(importPath) ? importPath : path.join(protoDir, importPath);
    root.loadSync("opentelemetry/proto/collector/metrics/v1/metrics_service.proto");
    const RequestType = root.lookupType(
      "opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceRequest"
    );
    const message = RequestType.fromObject(samplePayload);
    const bytes = RequestType.encode(message).finish();

    ipCounter += 1;
    const request = new NextRequest("https://usage.jays.services/api/otlp/v1/metrics", {
      method: "POST",
      headers: {
        "content-type": "application/x-protobuf",
        authorization: "Bearer test-token-123",
        "x-forwarded-for": `10.0.0.${ipCounter}`,
      },
      body: Buffer.from(bytes),
    });
    const res = await POST(request);
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.accepted).toBe(1);
  });
});
