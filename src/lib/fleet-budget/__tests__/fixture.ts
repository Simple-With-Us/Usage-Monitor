import type { FleetPolicy } from "../policy";
export const NOW = new Date("2026-10-06T20:00:00.000Z");
export const POLICY: FleetPolicy = {
  softLimitMicros: 500_000, hardLimitMicros: 1_500_000,
  deepseek: { model: "synthetic-deepseek", inputMicrosPerMillion: 1_000_000, cachedInputMicrosPerMillion: 100_000,
    outputMicrosPerMillion: 2_000_000, maxInputTokens: 1_000_000, maxOutputTokens: 100_000,
    source: "https://example.invalid/synthetic-pricing", verifiedAt: "2026-10-06T00:00:00Z", validUntil: "2026-10-10T00:00:00Z" },
  minimax: { model: "synthetic-minimax", inputMicrosPerMillion: 500_000, cachedInputMicrosPerMillion: 50_000,
    outputMicrosPerMillion: 1_000_000, maxInputTokens: 1_000_000, maxOutputTokens: 100_000,
    source: "https://example.invalid/synthetic-pricing", verifiedAt: "2026-10-06T00:00:00Z", validUntil: "2026-10-10T00:00:00Z" },
};
export function input(requestId: string, extra = {}) {
  return { requestId, maxInputTokens: 100_000, maxOutputTokens: 50_000, route: "primary" as const, ...extra };
}
