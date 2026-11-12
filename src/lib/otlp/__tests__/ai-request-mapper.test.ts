import { describe, expect, it } from "vitest";
import {
  aiRequestFromSpan,
  mapOtlpLogsToAiRequests,
  normalizeBillingMode,
  projectFromPath,
} from "../ai-request-mapper";
import { claudeLogsPayload, codexApiRequestPayload, codexCompletionPayload } from "./ai-request-fixtures";
import { summarizeAiRequests, percentile } from "@/lib/ai-request-performance";
import type { OtlpExportLogsServiceRequest } from "../types";

describe("ai-request-mapper", () => {
  it("maps only the api_request record out of a mixed Claude batch", () => {
    const result = mapOtlpLogsToAiRequests(claudeLogsPayload() as OtlpExportLogsServiceRequest);
    expect(result.ignored).toBe(1);
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]).toMatchObject({ kind: "complete", harness: "claude-code", inputTokens: 12 });
  });

  it("falls back to client_request_id for the dedupe key", () => {
    const payload = claudeLogsPayload({ requestId: "" });
    const [req] = mapOtlpLogsToAiRequests(payload as OtlpExportLogsServiceRequest).requests;
    expect(req.dedupeKey).toBe("claude-code|creq|c0ffee00-1590");
  });

  it("subtracts cached input for Codex so inputTokens means uncached input", () => {
    const { requests } = mapOtlpLogsToAiRequests(codexCompletionPayload() as OtlpExportLogsServiceRequest);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ kind: "codex-completion", inputTokens: 5000, cacheReadTokens: 45000 });
  });

  it("derives a project from lane and Code paths", () => {
    expect(projectFromPath("/Users/jay/apps/lanes/BotFleet/claude-x")).toBe("BotFleet");
    expect(projectFromPath("/Users/jay/Code/Congress.Trade/src")).toBe("Congress.Trade");
    expect(projectFromPath("/tmp/scratch")).toBe("scratch");
    expect(projectFromPath(undefined)).toBeUndefined();
  });

  it("normalizes billing mode from explicit attributes and Codex auth_mode", () => {
    expect(normalizeBillingMode("Subscription")).toBe("subscription");
    expect(normalizeBillingMode("PAYG")).toBe("payg");
    expect(normalizeBillingMode(undefined, "ApiKey")).toBe("payg");
    expect(normalizeBillingMode(undefined, "Chatgpt")).toBe("subscription");
    expect(normalizeBillingMode(undefined, undefined)).toBeUndefined();
  });

  it("only treats claude_code.llm_request spans as requests", () => {
    expect(aiRequestFromSpan("claude_code.tool", { request_id: "req_1" }, {})).toBeNull();
    const req = aiRequestFromSpan(
      "claude_code.llm_request",
      { request_id: "req_1", success: false, status_code: 529, error: "overloaded" },
      { startTimeUnixNano: "1000000000", endTimeUnixNano: "3000000000" }
    );
    expect(req).toMatchObject({
      dedupeKey: "claude-code|req|req_1",
      durationMs: 2000,
      statusCode: 529,
      error: "overloaded",
    });
  });
});

describe("ai-request-mapper attribution (UM-1599)", () => {
  it("defaults the Codex seat to CODEX when the resource names none", () => {
    for (const payload of [codexApiRequestPayload(), codexCompletionPayload()]) {
      const { requests } = mapOtlpLogsToAiRequests(payload as OtlpExportLogsServiceRequest);
      expect(requests).toHaveLength(1);
      expect(requests[0].seat).toBe("CODEX");
      expect(requests[0].project).toBeUndefined();
    }
  });

  it("keeps a seat and project that OTEL_RESOURCE_ATTRIBUTES put on the Codex resource", () => {
    const payload = codexCompletionPayload() as any;
    payload.resourceLogs[0].resource.attributes.push(
      { key: "seat", value: { stringValue: "claude" } },
      { key: "project", value: { stringValue: "Usage-Monitor" } }
    );
    const [req] = mapOtlpLogsToAiRequests(payload as OtlpExportLogsServiceRequest).requests;
    expect(req).toMatchObject({ seat: "CLAUDE", project: "Usage-Monitor" });
  });

  it("does not default a seat for Claude Code rows", () => {
    const payload = claudeLogsPayload() as any;
    payload.resourceLogs[0].resource.attributes = payload.resourceLogs[0].resource.attributes.filter(
      (a: { key: string }) => a.key !== "seat"
    );
    const [req] = mapOtlpLogsToAiRequests(payload as OtlpExportLogsServiceRequest).requests;
    expect(req.seat).toBeUndefined();
  });

  it("prefers the workspace path over the lowercased vcs.repository.name for project", () => {
    const withBoth = claudeLogsPayload() as any;
    withBoth.resourceLogs[0].scopeLogs[0].logRecords[1].attributes.push({
      key: "vcs.repository.name",
      value: { stringValue: "usage-monitor" },
    });
    expect(mapOtlpLogsToAiRequests(withBoth as OtlpExportLogsServiceRequest).requests[0].project).toBe(
      "Usage-Monitor"
    );
    const onlyVcs = claudeLogsPayload() as any;
    const record = onlyVcs.resourceLogs[0].scopeLogs[0].logRecords[1];
    record.attributes = record.attributes.filter((a: { key: string }) => a.key !== "workspace.host_paths");
    record.attributes.push({ key: "vcs.repository.name", value: { stringValue: "usage-monitor" } });
    expect(mapOtlpLogsToAiRequests(onlyVcs as OtlpExportLogsServiceRequest).requests[0].project).toBe(
      "usage-monitor"
    );
  });

  it("fills servedModel for Claude api_request logs from the only model attribute", () => {
    const [req] = mapOtlpLogsToAiRequests(claudeLogsPayload() as OtlpExportLogsServiceRequest).requests;
    expect(req).toMatchObject({ requestedModel: "claude-opus-5-5", servedModel: "claude-opus-5-5" });
  });

  it("fills servedModel for llm_request spans and lets gen_ai.response.model win", () => {
    const base = { start: "1000000000", end: "3000000000" };
    const span = { startTimeUnixNano: base.start, endTimeUnixNano: base.end };
    const only = aiRequestFromSpan(
      "claude_code.llm_request",
      { request_id: "r1", model: "claude-opus-5-5", "gen_ai.request.model": "claude-opus-5-5" },
      span
    );
    expect(only).toMatchObject({ requestedModel: "claude-opus-5-5", servedModel: "claude-opus-5-5" });
    const explicit = aiRequestFromSpan(
      "claude_code.llm_request",
      { request_id: "r2", "gen_ai.request.model": "claude-opus-5-5", "gen_ai.response.model": "claude-opus-5-5-20261001" },
      span
    );
    expect(explicit).toMatchObject({
      requestedModel: "claude-opus-5-5",
      servedModel: "claude-opus-5-5-20261001",
    });
  });

  it("sets Codex servedModel from response.completed only, never from the pending api_request", () => {
    const completion = mapOtlpLogsToAiRequests(codexCompletionPayload() as OtlpExportLogsServiceRequest).requests[0];
    expect(completion).toMatchObject({ requestedModel: "gpt-6.1-sol", servedModel: "gpt-6.1-sol" });
    const api = mapOtlpLogsToAiRequests(codexApiRequestPayload() as OtlpExportLogsServiceRequest).requests[0];
    expect(api.requestedModel).toBe("gpt-6.1-sol");
    expect(api.servedModel).toBeUndefined();
  });
});

describe("ai-request-performance", () => {
  it("computes nearest-rank percentiles", () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(percentile([1, 2, 3, 4], 0.95)).toBe(4);
  });

  it("summarizes per harness and model, excluding failures from latency", () => {
    const base = {
      harness: "claude-code",
      requestedModel: "claude-opus-5-5",
      servedModel: null,
      inputTokens: 10,
      cacheReadTokens: 80,
      cacheWriteTokens: 10,
      reasoningTokens: null,
      costUsd: 0.01,
      billingMode: "subscription",
      error: null,
    };
    const rows = summarizeAiRequests([
      { ...base, durationMs: 2000, ttftMs: 1000, outputTokens: 100 },
      { ...base, durationMs: 4000, ttftMs: 2000, outputTokens: 400 },
      { ...base, durationMs: 99_000, ttftMs: null, outputTokens: null, error: "overloaded" },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      harness: "claude-code",
      model: "claude-opus-5-5",
      requests: 3,
      errors: 1,
      durationMsP50: 2000,
      durationMsP95: 4000,
      ttftMsP50: 1000,
      outputTokensPerSecP50: 100,
      cacheHitRatio: 0.8,
      costUsd: 0.03,
      billingModes: { subscription: 3 },
    });
  });
});
