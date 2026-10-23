/**
 * Subscription-seat analytics telemetry is an API-equivalent estimate, never
 * cash.  Claude Code OTLP already lands this way; Codex JSONL, Grok Build,
 * Copilot CLI, OpenCode, and Fx session collectors join the same bucket once
 * their feeds ingest.
 *
 * Keep the Claude discriminator exact so Anthropic API usage (a different
 * sourceApp) still bills as cash.  OpenCode also carries real PAYG message-cost
 * rows, so its cost discriminator must inspect the event shape.
 */

export const SUBSCRIPTION_ANALYTICS_SOURCE_APPS = [
  "claude-code",
  "grok-build",
  "openai-codex",
  "antigravity-statusline",
  "github-copilot",
  "deepseek-dsh",
  "opencode",
  "fx",
] as const;

export type SubscriptionAnalyticsSourceApp =
  (typeof SUBSCRIPTION_ANALYTICS_SOURCE_APPS)[number];

export const DERIVED_ANALYTICS_TOKEN_SOURCE_APPS =
  SUBSCRIPTION_ANALYTICS_SOURCE_APPS.filter((sourceApp) => sourceApp !== "claude-code");

/** sourceApp-only seats. Claude Code stays exact (sourceApp AND service)
 *  because `sourceApp=claude-code` without `service=claude-code` is used for
 *  other Anthropic telemetry that must remain cash. */
const SOURCE_APP_ONLY_ANALYTICS = new Set<string>([
  "grok-build",
  "openai-codex",
  "antigravity-statusline",
  "github-copilot",
  "deepseek-dsh",
]);

const OPENCODE_PAYG_PROVIDERS = new Set([
  "anthropic",
  "openai",
  "google-ai",
  "xai",
  "deepseek",
]);

type AnalyticsTelemetryShape = {
  sourceApp: string;
  service?: string | null;
  provider?: string | null;
  metricType?: string | null;
  label?: string | null;
};

function isOpencodePaygCost(input: AnalyticsTelemetryShape): boolean {
  const app = input.sourceApp?.trim().toLowerCase();
  // Existing OpenCode PAYG message-cost rows use the shared estimated-cost
  // wire shape.  Changing it would conflict with persisted event IDs, so
  // distinguish only providers with an explicit PAYG mapping in its parser.
  // The cost row has providerId metadata but no billing-mode metadata, and
  // daily rollups retain neither; this shape survives both storage forms.
  return (
    app === "opencode" &&
    input.service?.trim().toLowerCase() === "opencode" &&
    input.metricType === "cost" &&
    input.label === "api-equivalent" &&
    !!input.provider &&
    OPENCODE_PAYG_PROVIDERS.has(input.provider.trim().toLowerCase())
  );
}

export function isClaudeCodeAnalyticsTelemetry(input: AnalyticsTelemetryShape): boolean {
  return (
    input.sourceApp?.trim().toLowerCase() === "claude-code" &&
    input.service?.trim().toLowerCase() === "claude-code"
  );
}

export function isSubscriptionAnalyticsTelemetry(input: AnalyticsTelemetryShape): boolean {
  if (isClaudeCodeAnalyticsTelemetry(input)) return true;
  const app = input.sourceApp?.trim().toLowerCase();
  if (app === "opencode") return !isOpencodePaygCost(input);
  if (app === "fx") return true;
  return Boolean(app && SOURCE_APP_ONLY_ANALYTICS.has(app));
}

/** Token derivation fill-in: Claude already stores OTLP costUsd as the
 * estimate, so adding tokens x price would double-count. Other seats post
 * tokens (and optional vendor ticks) and need the catalog estimate. */
export function shouldDeriveAnalyticsTokenEstimate(input: AnalyticsTelemetryShape): boolean {
  if (isClaudeCodeAnalyticsTelemetry(input)) return false;
  return isSubscriptionAnalyticsTelemetry(input);
}
