import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { NextRequest } from "next/server";
import protobuf from "protobufjs";
import { setupPrismaSqliteTestDb } from "@/lib/__tests__/setup-test-db";
import { tryAcquireIngestAdmission } from "@/lib/ingest-admission";
import { getNamedRateLimiter } from "@/lib/rate-limit";

// Wrap the persistence module so one test can simulate an unexpected
// (non-collision) persistence failure without touching the real database.
const persistenceControl = vi.hoisted(() => ({ failNext: { value: false } }));
vi.mock("@/lib/otlp/cumulative-state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/otlp/cumulative-state")>();
  return {
    ...actual,
    persistOtlpUsageEvents: (
      ...args: Parameters<typeof actual.persistOtlpUsageEvents>
    ) =>
      persistenceControl.failNext.value
        ? Promise.reject(new Error("simulated persistence failure"))
        : actual.persistOtlpUsageEvents(...args),
  };
});

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
  vi.unstubAllEnvs();
  persistenceControl.failNext.value = false;
  // Process-wide named rate limiters (keyed on the token hash / backstop
  // identity since X1, not the per-test rotating IP) — reset between tests.
  getNamedRateLimiter("otlp-metrics-identity", 1_000, 10).reset();
  getNamedRateLimiter("otlp-metrics-unauthenticated", 1_000, 10).reset();
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

  it("fails closed before decoding or writing when OTLP metrics ingest is disabled", async () => {
    vi.stubEnv("OTLP_METRICS_INGEST_ENABLED", "false");
    const res = await POST(
      jsonRequest("not-an-otlp-object", { authorization: "Bearer test-token-123" })
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("300");
    expect(await prisma.externalUsageEvent.count({ where: { sourceApp: "claude-code" } })).toBe(0);
    expect(await prisma.otlpMetricState.count()).toBe(0);
  });

  it("rejects overlapping database ingest before writing", async () => {
    const release = tryAcquireIngestAdmission();
    expect(release).not.toBeNull();
    try {
      const res = await POST(
        jsonRequest(samplePayload, { authorization: "Bearer test-token-123" })
      );
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("5");
      expect(await prisma.externalUsageEvent.count({ where: { sourceApp: "claude-code" } })).toBe(0);
      expect(await prisma.otlpMetricState.count()).toBe(0);
    } finally {
      release?.();
    }
  });

  it("rejects a busy receiver before decoding an otherwise invalid OTLP payload", async () => {
    const release = tryAcquireIngestAdmission();
    expect(release).not.toBeNull();
    try {
      const res = await POST(
        jsonRequest("not-an-otlp-object", { authorization: "Bearer test-token-123" })
      );
      // Before the admission gate moved above decoding this was a 400.
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("5");
      expect(await prisma.externalUsageEvent.count({ where: { sourceApp: "claude-code" } })).toBe(0);
      expect(await prisma.otlpMetricState.count()).toBe(0);
    } finally {
      release?.();
    }
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

  it("accepts a claude-code scoped token when scoped tokens are required", async () => {
    vi.stubEnv("USAGE_INGEST_PRODUCER_TOKENS", "claude-code:scoped-claude-token,codecaps:scoped-caps-token");
    vi.stubEnv("USAGE_INGEST_REQUIRE_SCOPED_TOKENS", "true");

    const unscoped = await POST(jsonRequest(samplePayload, { authorization: "Bearer test-token-123" }));
    expect(unscoped.status).toBe(401);

    const otherProducer = await POST(
      jsonRequest(samplePayload, { authorization: "Bearer scoped-caps-token" })
    );
    expect(otherProducer.status).toBe(403);

    const res = await POST(jsonRequest(samplePayload, { authorization: "Bearer scoped-claude-token" }));
    expect(res.status).toBe(202);
    const rows = await prisma.externalUsageEvent.findMany({ where: { sourceApp: "claude-code" } });
    expect(rows).toHaveLength(1);
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
    expect(rows.map((row) => row.costUsd)).toEqual([
      expect.closeTo(0.0231),
      expect.closeTo(0.0269),
    ]);
    expect(rows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0)).toBeCloseTo(0.05);
    expect(await prisma.otlpMetricState.count()).toBe(1);
  });

  it("drops system.* metrics by default without writing rows (Wave G / E9)", async () => {
    const systemPayload = {
      resourceMetrics: [
        {
          resource: {
            attributes: [
              { key: "host.name", value: { stringValue: "web-01" } },
              { key: "service.name", value: { stringValue: "host" } },
            ],
          },
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "system.cpu.utilization",
                  gauge: {
                    dataPoints: [
                      {
                        asDouble: 0.5,
                        attributes: [{ key: "state", value: { stringValue: "user" } }],
                        timeUnixNano: "1751500060000000000",
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

    const res = await POST(
      jsonRequest(systemPayload, { authorization: "Bearer test-token-123" })
    );
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.ignoredSystemMetrics).toBe(1);
    expect(body.accepted ?? 0).toBe(0);
    expect(
      await prisma.externalUsageEvent.count({ where: { sourceApp: "system-metrics" } })
    ).toBe(0);
  });

  it("persists system.* metrics when OTLP_SYSTEM_METRICS_INGEST_ENABLED=true", async () => {
    vi.stubEnv("OTLP_SYSTEM_METRICS_INGEST_ENABLED", "true");
    const systemPayload = {
      resourceMetrics: [
        {
          resource: {
            attributes: [{ key: "host.name", value: { stringValue: "web-01" } }],
          },
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "system.memory.usage",
                  sum: {
                    aggregationTemporality: 1,
                    isMonotonic: false,
                    dataPoints: [
                      {
                        asDouble: 1024,
                        attributes: [{ key: "state", value: { stringValue: "used" } }],
                        timeUnixNano: "1751500060000000000",
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
    const res = await POST(
      jsonRequest(systemPayload, { authorization: "Bearer test-token-123" })
    );
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.accepted).toBeGreaterThanOrEqual(1);
    expect(body.ignoredSystemMetrics).toBeUndefined();
    expect(
      await prisma.externalUsageEvent.count({ where: { sourceApp: "system-metrics" } })
    ).toBe(1);
  });

  it("advances checkpoint on zero cumulative delta without persisting a zero event (Wave F / E9)", async () => {
    const first = await POST(
      jsonRequest(samplePayload, { authorization: "Bearer test-token-123" })
    );
    expect(first.status).toBe(202);
    expect((await first.json()).accepted).toBe(1);

    // Same cumulative value, later timestamp — pure heartbeat / no-change
    // export. Checkpoint must advance; no new ExternalUsageEvent.
    const zeroDelta = structuredClone(samplePayload);
    const zeroPoint =
      zeroDelta.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0];
    zeroPoint.timeUnixNano = "1751500120000000000";
    // Keep asDouble equal to the first export (0.0231 in samplePayload).
    const zeroResponse = await POST(
      jsonRequest(zeroDelta, { authorization: "Bearer test-token-123" })
    );
    expect(zeroResponse.status).toBe(202);
    const zeroBody = await zeroResponse.json();
    expect(zeroBody.ignoredOutOfOrder).toBe(1);
    // No new persist; accepted stays at 0 for this call (only retries count
    // when an existing key is resubmitted — this is a new point key).
    expect(zeroBody.accepted ?? 0).toBe(0);

    const rows = await prisma.externalUsageEvent.findMany({
      where: { sourceApp: "claude-code" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].costUsd).toBeCloseTo(0.0231);

    const state = await prisma.otlpMetricState.findFirst();
    expect(state).toBeTruthy();
    expect(state!.lastTimeUnixNano).toBe("1751500120000000000");
    expect(state!.lastValue).toBeCloseTo(0.0231);

    // A later positive delta from the advanced checkpoint still works.
    const later = structuredClone(samplePayload);
    const laterPoint =
      later.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0];
    laterPoint.timeUnixNano = "1751500180000000000";
    laterPoint.asDouble = 0.05;
    const laterResponse = await POST(
      jsonRequest(later, { authorization: "Bearer test-token-123" })
    );
    expect(laterResponse.status).toBe(202);
    const laterRows = await prisma.externalUsageEvent.findMany({
      where: { sourceApp: "claude-code" },
      orderBy: { occurredAt: "asc" },
    });
    expect(laterRows).toHaveLength(2);
    expect(laterRows.map((row) => row.costUsd)).toEqual([
      expect.closeTo(0.0231),
      expect.closeTo(0.0269),
    ]);
  });

  it("bounds cumulative checkpoint cardinality without deleting replay protection", async () => {
    vi.stubEnv("OTLP_MAX_CUMULATIVE_SERIES", "1");
    const first = await POST(
      jsonRequest(samplePayload, { authorization: "Bearer test-token-123" })
    );
    expect(first.status).toBe(202);

    const secondSeries = structuredClone(samplePayload);
    secondSeries.resourceMetrics[0].resource.attributes.push({
      key: "session.id",
      value: { stringValue: "a-different-series" },
    });
    const second = await POST(
      jsonRequest(secondSeries, { authorization: "Bearer test-token-123" })
    );
    expect(second.status).toBe(503);
    expect(second.headers.get("retry-after")).toBe("900");
    expect(await second.json()).toMatchObject({ limit: 1 });
    expect(await prisma.otlpMetricState.count()).toBe(1);
    expect(
      await prisma.externalUsageEvent.count({ where: { sourceApp: "claude-code" } })
    ).toBe(1);
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

  it("uses an explicit metadata allowlist, with session.id as the one deliberate exception", async () => {
    // session.id is retained (2026-09-24) for GET /api/cost-by-session -- see
    // mapping-utils.ts's METADATA_ALLOWLIST comment and
    // src/lib/cost-by-session.ts. It is an opaque per-process UUID, not PII,
    // unlike user.email which stays excluded below.
    const payload = structuredClone(samplePayload);
    payload.resourceMetrics[0].resource.attributes.push(
      { key: "user.email", value: { stringValue: "private@example.com" } },
      { key: "project", value: { stringValue: "socratic-trade" } }
    );
    payload.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0].attributes.push({
      key: "session.id",
      value: { stringValue: "kept-session" },
    });
    await POST(jsonRequest(payload, { authorization: "Bearer test-token-123" }));
    const row = await prisma.externalUsageEvent.findFirstOrThrow({
      where: { sourceApp: "claude-code" },
    });
    expect(row.metadata).toMatchObject({
      model: "claude-sonnet-5",
      project: "socratic-trade",
      "session.id": "kept-session",
    });
    expect(row.metadata).not.toMatchObject({ "user.email": expect.anything() });
  });

  it("mirrors dotted project.name resource attribute into metadata.project", async () => {
    const payload = structuredClone(samplePayload);
    payload.resourceMetrics[0].resource.attributes.push({
      key: "project.name",
      value: { stringValue: "congress-trade" },
    });
    await POST(jsonRequest(payload, { authorization: "Bearer test-token-123" }));
    const row = await prisma.externalUsageEvent.findFirstOrThrow({
      where: { sourceApp: "claude-code" },
    });
    expect(row.metadata).toMatchObject({ project: "congress-trade" });
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

  it("rejects mapped points without a stable event timestamp", async () => {
    const payload = structuredClone(samplePayload);
    delete (payload.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0] as {
      timeUnixNano?: string;
    }).timeUnixNano;
    const response = await POST(
      jsonRequest(payload, { authorization: "Bearer test-token-123" })
    );
    expect(response.status).toBe(400);
  });

  it("rejects an oversized chunked body before decoding it", async () => {
    ipCounter += 1;
    const request = new NextRequest("https://usage.jays.services/api/otlp/v1/metrics", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-token-123",
        "x-forwarded-for": `10.0.0.${ipCounter}`,
      },
      body: JSON.stringify({ padding: "x".repeat(1_048_576) }),
    });
    const response = await POST(request);
    expect(response.status).toBe(413);
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
                  sum: {
                    aggregationTemporality: 1,
                    dataPoints: [{ timeUnixNano: "1751500060000000000", asInt: "3" }],
                  },
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

  it("rejects unspecified temporality and negative monotonic sums", async () => {
    const unspecified = structuredClone(samplePayload);
    unspecified.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.aggregationTemporality = 0;
    expect(
      (
        await POST(
          jsonRequest(unspecified, { authorization: "Bearer test-token-123" })
        )
      ).status
    ).toBe(400);

    const negative = structuredClone(samplePayload);
    negative.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.isMonotonic = false;
    negative.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0].asDouble = -1;
    expect(
      (
        await POST(
          jsonRequest(negative, { authorization: "Bearer test-token-123" })
        )
      ).status
    ).toBe(400);
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

describe("POST /api/otlp/v1/metrics rate limiting (X1) and typed 500 (X6)", () => {
  it("limits authenticated traffic per token, not per source IP", async () => {
    // One credential from many distinct source IPs: the 11th request within
    // the window 429s — the bucket follows the authenticated identity.
    for (let index = 1; index <= 10; index += 1) {
      const res = await POST(
        jsonRequest(samplePayload, {
          authorization: "Bearer test-token-123",
          "x-forwarded-for": `10.8.0.${index}`,
        })
      );
      expect(res.status).toBe(202);
    }
    const limited = await POST(
      jsonRequest(samplePayload, {
        authorization: "Bearer test-token-123",
        "x-forwarded-for": "10.8.0.11",
      })
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("30");
  });

  it("does not let unauthenticated hammering through the shared Cloudflare egress IP drain the producer bucket", async () => {
    for (let index = 1; index <= 15; index += 1) {
      const res = await POST(
        jsonRequest(samplePayload, {
          authorization: "Bearer wrong-token",
          "x-forwarded-for": "173.245.48.1",
          "cf-connecting-ip": `198.51.100.${index}`,
        })
      );
      expect(res.status).toBe(401);
    }
    const producer = await POST(
      jsonRequest(samplePayload, {
        authorization: "Bearer test-token-123",
        "x-forwarded-for": "173.245.48.1",
        "cf-connecting-ip": "198.51.100.1",
      })
    );
    expect(producer.status).toBe(202);
  });

  it("returns a typed retryable internal_error body when persistence fails unexpectedly (X6)", async () => {
    persistenceControl.failNext.value = true;
    const res = await POST(
      jsonRequest(samplePayload, { authorization: "Bearer test-token-123" })
    );
    expect(res.status).toBe(500);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({
      ok: false,
      schemaVersion: 2,
      error: {
        code: "internal_error",
        message: "Internal error",
        retryable: true,
        retryAfterSeconds: 30,
      },
    });
    expect(
      await prisma.externalUsageEvent.count({ where: { sourceApp: "claude-code" } })
    ).toBe(0);
  });

  it("rejects an OTLP metrics request with 403 when token is scoped to a foreign producer", async () => {
    vi.stubEnv("USAGE_INGEST_PRODUCER_TOKENS", "socratic-trade:tok-socratic");
    const res = await POST(
      jsonRequest(samplePayload, { authorization: "Bearer tok-socratic" })
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'Credential is not authorized for sourceApp "claude-code"',
    });
  });

  it("accepts an OTLP metrics request when token is scoped to claude-code", async () => {
    vi.stubEnv("USAGE_INGEST_PRODUCER_TOKENS", "claude-code:tok-claude");
    const res = await POST(
      jsonRequest(samplePayload, { authorization: "Bearer tok-claude" })
    );
    expect(res.status).toBe(202);
  });
});

const genAiPayload = {
  resourceMetrics: [
    {
      resource: {
        attributes: [
          { key: "agent.platform", value: { stringValue: "botfleet" } },
          { key: "gen_ai.system", value: { stringValue: "openai" } },
        ],
      },
      scopeMetrics: [
        {
          metrics: [
            {
              name: "gen_ai.client.token.usage",
              unit: "token",
              sum: {
                aggregationTemporality: 2,
                isMonotonic: true,
                dataPoints: [
                  {
                    attributes: [
                      { key: "gen_ai.token.type", value: { stringValue: "input" } },
                      { key: "gen_ai.request.model", value: { stringValue: "gpt-5" } },
                    ],
                    startTimeUnixNano: "1751500000000000000",
                    timeUnixNano: "1751500060000000000",
                    asInt: "88",
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

const cursorAgentGenAiPayload = {
  resourceMetrics: [
    {
      resource: {
        attributes: [{ key: "agent.platform", value: { stringValue: "cursor-agent" } }],
      },
      scopeMetrics: genAiPayload.resourceMetrics[0].scopeMetrics,
    },
  ],
};

const overlapGenAiPayload = {
  resourceMetrics: [
    {
      resource: {
        attributes: [{ key: "agent.platform", value: { stringValue: "openai-codex" } }],
      },
      scopeMetrics: [
        {
          metrics: [
            {
              name: "gen_ai.client.token.usage",
              sum: {
                aggregationTemporality: 2,
                isMonotonic: true,
                dataPoints: [
                  {
                    attributes: [{ key: "gen_ai.token.type", value: { stringValue: "input" } }],
                    startTimeUnixNano: "1751500000000000000",
                    timeUnixNano: "1751500060000000000",
                    asInt: "10",
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

describe("POST /api/otlp/v1/metrics gen_ai mapper", () => {
  it("persists a non-overlap gen_ai token point", async () => {
    const res = await POST(
      jsonRequest(genAiPayload, { authorization: "Bearer test-token-123" })
    );
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.accepted).toBe(1);
    expect(body.ignoredOverlap).toBeUndefined();
    const rows = await prisma.externalUsageEvent.findMany({
      where: { sourceApp: "botfleet" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe("openai");
    expect(rows[0].quantity).toBe(88);
    expect(rows[0].label).toBe("token:input");
  });

  it("skips overlap platforms by default and reports ignoredOverlap", async () => {
    const res = await POST(
      jsonRequest(overlapGenAiPayload, { authorization: "Bearer test-token-123" })
    );
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.accepted).toBe(0);
    expect(body.ignoredOverlap).toBe(1);
    expect(
      await prisma.externalUsageEvent.count({ where: { sourceApp: "openai-codex" } })
    ).toBe(0);
  });

  it("skips cursor-agent gen_ai rows so the admin poller is the billed ledger", async () => {
    const res = await POST(
      jsonRequest(cursorAgentGenAiPayload, { authorization: "Bearer test-token-123" })
    );
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.accepted).toBe(0);
    expect(body.ignoredOverlap).toBe(1);
    expect(
      await prisma.externalUsageEvent.count({ where: { sourceApp: "cursor-agent" } })
    ).toBe(0);
  });

  it("authenticates a cursor-agent scoped token and still skips the overlap rows", async () => {
    vi.stubEnv("USAGE_INGEST_PRODUCER_TOKENS", "cursor-agent:tok-cursor");
    vi.stubEnv("USAGE_INGEST_REQUIRE_SCOPED_TOKENS", "true");
    const denied = await POST(
      jsonRequest(cursorAgentGenAiPayload, { authorization: "Bearer test-token-123" })
    );
    expect(denied.status).toBe(401);
    const res = await POST(
      jsonRequest(cursorAgentGenAiPayload, { authorization: "Bearer tok-cursor" })
    );
    expect(res.status).toBe(202);
    expect(
      await prisma.externalUsageEvent.count({ where: { sourceApp: "cursor-agent" } })
    ).toBe(0);
  });
});

