import { describe, expect, it } from "vitest";
import {
  DERIVED_ANALYTICS_TOKEN_SOURCE_APPS,
  isClaudeCodeAnalyticsTelemetry,
  isSubscriptionAnalyticsTelemetry,
  shouldDeriveAnalyticsTokenEstimate,
} from "../subscription-analytics";

describe("subscription analytics discriminators", () => {
  it("keeps Claude Code OTLP exact so Anthropic API usage stays cash", () => {
    expect(
      isClaudeCodeAnalyticsTelemetry({ sourceApp: "claude-code", service: "claude-code" })
    ).toBe(true);
    expect(
      isClaudeCodeAnalyticsTelemetry({ sourceApp: "anthropic", service: "messages" })
    ).toBe(false);
    expect(
      isClaudeCodeAnalyticsTelemetry({ sourceApp: "claude-code", service: "api" })
    ).toBe(false);
  });

  it("does not treat claude-code sourceApp alone as analytics", () => {
    expect(
      isSubscriptionAnalyticsTelemetry({ sourceApp: "claude-code", service: null })
    ).toBe(false);
  });

  it("treats Codex, Grok Build, and Copilot CLI session ingest as analytics, not cash", () => {
    expect(
      isSubscriptionAnalyticsTelemetry({ sourceApp: "openai-codex", service: "codex-cli" })
    ).toBe(true);
    expect(
      isSubscriptionAnalyticsTelemetry({ sourceApp: "grok-build", service: "grok-cli" })
    ).toBe(true);
    expect(
      isSubscriptionAnalyticsTelemetry({
        sourceApp: "github-copilot",
        service: "copilot-cli",
      })
    ).toBe(true);
    expect(
      isSubscriptionAnalyticsTelemetry({ sourceApp: "openai", service: "responses" })
    ).toBe(false);
    expect(
      isSubscriptionAnalyticsTelemetry({ sourceApp: "xai", service: "chat" })
    ).toBe(false);
    expect(
      isSubscriptionAnalyticsTelemetry({ sourceApp: "github", service: "copilot" })
    ).toBe(false);
    expect(
      isSubscriptionAnalyticsTelemetry({
        sourceApp: "fleet-usage-collector",
        service: "grok-cli",
      })
    ).toBe(false);
  });

  it("treats OpenCode and Fx session estimates as analytics, not cash", () => {
    expect(
      isSubscriptionAnalyticsTelemetry({ sourceApp: "opencode", service: "opencode" }),
    ).toBe(true);
    expect(
      isSubscriptionAnalyticsTelemetry({ sourceApp: "fx", service: "fx" }),
    ).toBe(true);
    expect(DERIVED_ANALYTICS_TOKEN_SOURCE_APPS).toContain("opencode");
    expect(DERIVED_ANALYTICS_TOKEN_SOURCE_APPS).toContain("fx");
    expect(shouldDeriveAnalyticsTokenEstimate({ sourceApp: "opencode", service: "opencode" })).toBe(true);
    expect(shouldDeriveAnalyticsTokenEstimate({ sourceApp: "fx", service: "fx" })).toBe(true);
  });

  it("keeps only the existing OpenCode PAYG message-cost shape in cash", () => {
    const cost = {
      sourceApp: "opencode",
      service: "opencode",
      metricType: "cost",
      label: "api-equivalent",
    };
    for (const provider of ["anthropic", "openai", "google-ai", "xai", "deepseek", "openrouter", "bedrock", "azure"]) {
      expect(isSubscriptionAnalyticsTelemetry({ ...cost, provider })).toBe(false);
    }
    for (const provider of ["minimax", "muse-code", "opencode", " "]) {
      expect(isSubscriptionAnalyticsTelemetry({ ...cost, provider })).toBe(true);
    }
    expect(isSubscriptionAnalyticsTelemetry({ ...cost, provider: "anthropic", label: "other" })).toBe(true);
    expect(isSubscriptionAnalyticsTelemetry({ ...cost, provider: "anthropic", metricType: "usage", label: "token:input" })).toBe(true);
    expect(isSubscriptionAnalyticsTelemetry({ ...cost, provider: "anthropic", service: "other" })).toBe(true);
    expect(isSubscriptionAnalyticsTelemetry({ ...cost, provider: "anthropic", sourceApp: "fx" })).toBe(true);
  });

  it("does not double-count Claude OTLP costUsd with token derivation", () => {
    expect(
      shouldDeriveAnalyticsTokenEstimate({
        sourceApp: "claude-code",
        service: "claude-code",
      })
    ).toBe(false);
    expect(
      shouldDeriveAnalyticsTokenEstimate({
        sourceApp: "openai-codex",
        service: "codex-cli",
      })
    ).toBe(true);
    expect(DERIVED_ANALYTICS_TOKEN_SOURCE_APPS).toEqual([
      "grok-build",
      "openai-codex",
      "antigravity-statusline",
      "github-copilot",
      "deepseek-dsh",
      "opencode",
      "fx",
    ]);
  });
});
