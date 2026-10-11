import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mapGenAiMetrics,
  OVERLAP_SOURCE_APPS,
  resolveGenAiIdentity,
  shouldMapGenAiPlatform,
} from "../gen-ai-mapper";
import type { OtlpExportMetricsServiceRequest } from "../types";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllEnvs();
});

function genAiRequest(
  metricName: string,
  attrs: Array<{ key: string; value: { stringValue?: string; doubleValue?: number; intValue?: string } }>,
  value: number
): OtlpExportMetricsServiceRequest {
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "fleet-telemetry-relay" } },
            { key: "agent.platform", value: { stringValue: "cursor-agent" } },
          ],
        },
        scopeMetrics: [
          {
            metrics: [
              {
                name: metricName,
                sum: {
                  aggregationTemporality: 2,
                  isMonotonic: true,
                  dataPoints: [
                    {
                      attributes: attrs,
                      startTimeUnixNano: "1751500000000000000",
                      timeUnixNano: "1751500060000000000",
                      asDouble: value,
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
}

describe("resolveGenAiIdentity", () => {
  it("prefers agent.platform over gen_ai.system for sourceApp", () => {
    expect(
      resolveGenAiIdentity({
        "agent.platform": "cursor-agent",
        "gen_ai.system": "anthropic",
        "gen_ai.request.model": "claude-sonnet-5",
      })
    ).toEqual({
      sourceApp: "cursor-agent",
      provider: "anthropic",
      service: "cursor-agent",
      model: "claude-sonnet-5",
    });
  });

  it("falls back to a normalized unknown-agent when nothing is set", () => {
    expect(resolveGenAiIdentity({}).sourceApp).toBe("unknown-agent");
  });
});

describe("shouldMapGenAiPlatform", () => {
  it("skips overlap platforms by default", () => {
    expect(shouldMapGenAiPlatform("openai-codex")).toBe(false);
    expect(shouldMapGenAiPlatform("cursor-agent")).toBe(true);
    for (const app of OVERLAP_SOURCE_APPS) {
      expect(shouldMapGenAiPlatform(app)).toBe(false);
    }
  });

  it("maps overlap platforms when OTLP_GEN_AI_ALLOW_OVERLAP is on", () => {
    vi.stubEnv("OTLP_GEN_AI_ALLOW_OVERLAP", "1");
    expect(shouldMapGenAiPlatform("openai-codex")).toBe(true);
  });

  it("honors an explicit platform allowlist", () => {
    vi.stubEnv("OTLP_GEN_AI_PLATFORM_ALLOWLIST", "cursor-agent,botfleet");
    expect(shouldMapGenAiPlatform("cursor-agent")).toBe(true);
    expect(shouldMapGenAiPlatform("botfleet")).toBe(true);
    expect(shouldMapGenAiPlatform("muse-code")).toBe(false);
  });

  it("is off when the master switch is false", () => {
    vi.stubEnv("OTLP_GEN_AI_ENABLED", "false");
    expect(shouldMapGenAiPlatform("cursor-agent")).toBe(false);
  });
});

describe("mapGenAiMetrics", () => {
  it("maps token usage, cost, and duration", () => {
    const token = mapGenAiMetrics(
      genAiRequest(
        "gen_ai.client.token.usage",
        [
          { key: "gen_ai.token.type", value: { stringValue: "input" } },
          { key: "gen_ai.request.model", value: { stringValue: "gpt-5" } },
        ],
        1200
      )
    );
    expect(token.events).toHaveLength(1);
    expect(token.events[0]).toMatchObject({
      sourceApp: "cursor-agent",
      provider: "cursor",
      metricType: "usage",
      unit: "token",
      quantity: 1200,
      label: "token:input",
      keyRef: "gpt-5",
    });

    const cost = mapGenAiMetrics(
      genAiRequest("gen_ai.usage.cost", [{ key: "gen_ai.request.model", value: { stringValue: "gpt-5" } }], 0.42)
    );
    expect(cost.events[0]).toMatchObject({
      metricType: "cost",
      costUsd: 0.42,
      billingMode: "estimated",
    });

    const duration = mapGenAiMetrics(
      genAiRequest("gen_ai.client.operation.duration", [], 1500)
    );
    expect(duration.events[0]).toMatchObject({
      metricType: "usage",
      quantity: 1500,
      label: "operation_duration_ms",
    });
  });

  it("counts overlap platforms as ignoredOverlap and does not map them", () => {
    const request = genAiRequest(
      "gen_ai.client.token.usage",
      [{ key: "agent.platform", value: { stringValue: "openai-codex" } }],
      10
    );
    const result = mapGenAiMetrics(request);
    expect(result.events).toHaveLength(0);
    expect(result.ignoredOverlap).toBe(1);
  });

  it("tallies unknown metric names without throwing", () => {
    const result = mapGenAiMetrics(
      genAiRequest("gen_ai.client.something_new", [], 1)
    );
    expect(result.events).toHaveLength(0);
    expect(result.unknownMetrics).toEqual([
      { name: "gen_ai.client.something_new", dataPointCount: 1 },
    ]);
  });
});
