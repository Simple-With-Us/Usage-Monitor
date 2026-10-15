/**
 * Honesty rules for coding-agent usage numbers.
 *
 * A missing feed must never render as "little to no usage."  Zero tokens
 * with no trustworthy telemetry is "not reported," not a confirmed idle
 * seat.  Two spaces between sentences in every note a human reads.
 */

export type TokenTelemetryKind =
  | "otlp"
  | "session_jsonl"
  | "billing_api"
  | "character_estimate"
  | "none";

export type TelemetryAccuracy = "reported" | "none_in_window" | "unavailable";

export interface TelemetryAccuracyInput {
  name: string;
  tokenTelemetryKind: TokenTelemetryKind;
  totalTokens: number;
  isRunningOnMac: boolean;
  unavailableReason?: string;
}

export interface TelemetryAccuracyResult {
  accuracy: TelemetryAccuracy;
  usageIsReliable: boolean;
  label: string;
  note: string;
}

export function isReliableTokenTelemetryKind(
  kind: TokenTelemetryKind,
): boolean {
  return kind === "otlp" || kind === "session_jsonl" || kind === "billing_api";
}

export function resolveTelemetryAccuracy(
  input: TelemetryAccuracyInput,
): TelemetryAccuracyResult {
  const {
    name,
    tokenTelemetryKind,
    totalTokens,
    isRunningOnMac,
    unavailableReason,
  } = input;

  if (
    tokenTelemetryKind === "none" ||
    tokenTelemetryKind === "character_estimate"
  ) {
    return {
      accuracy: "unavailable",
      usageIsReliable: false,
      label: "not reported",
      note:
        unavailableReason ??
        `${name} does not report token usage.  This is not zero usage.`,
    };
  }

  if (totalTokens > 0) {
    return {
      accuracy: "reported",
      usageIsReliable: true,
      label: "reported",
      note:
        tokenTelemetryKind === "otlp"
          ? `${name} token counts come from the live OTLP stream.`
          : tokenTelemetryKind === "billing_api"
            ? `${name} token counts and billed cost come from the vendor Admin API.`
            : `${name} token counts come from local session logs.  They are estimates, not a vendor invoice.`,
    };
  }

  if (isRunningOnMac) {
    return {
      accuracy: "unavailable",
      usageIsReliable: false,
      label: "not reported",
      note: `${name} is running on the Mac but no token events arrived in this window.  This is not confirmed as zero usage.`,
    };
  }

  if (tokenTelemetryKind === "otlp") {
    return {
      accuracy: "none_in_window",
      usageIsReliable: true,
      label: "no events in this window",
      note: `No OTLP usage events for ${name} in this window.`,
    };
  }

  return {
    accuracy: "none_in_window",
    usageIsReliable: false,
    label: "not reported",
    note: `No session events for ${name} in this window.  This is not a confirmed zero.`,
  };
}

export function formatAgentTokenValue(
  platform: { usageIsReliable: boolean; totalTokens: number },
  formatTokens: (tokens: number) => string,
): string {
  if (!platform.usageIsReliable) return "not reported";
  return formatTokens(platform.totalTokens);
}

export function formatAgentMoneyValue(
  platform: { usageIsReliable: boolean },
  amount: number,
  formatCurrency: (usd: number) => string,
): string {
  if (!platform.usageIsReliable) return "not reported";
  return formatCurrency(amount);
}

export function formatAgentSeatPrimary(platform: {
  monthlySeatCostUsd: number;
  bundledOffsetUsd: number | null;
}): string {
  if (!(platform.monthlySeatCostUsd > 0)) return "Not billed";
  if (platform.bundledOffsetUsd != null && platform.bundledOffsetUsd > 0) {
    return `$${platform.monthlySeatCostUsd}/mo net`;
  }
  return `$${platform.monthlySeatCostUsd}/mo`;
}

export function telemetryIncompleteNoteFor(
  unreliableNames: readonly string[],
): string | null {
  if (unreliableNames.length === 0) return null;
  if (unreliableNames.length === 1) {
    return `Token totals omit ${unreliableNames[0]} because that seat is not reporting usage.`;
  }
  if (unreliableNames.length === 2) {
    return `Token totals omit ${unreliableNames[0]} and ${unreliableNames[1]} because those seats are not reporting usage.`;
  }
  const head = unreliableNames.slice(0, -1).join(", ");
  const last = unreliableNames[unreliableNames.length - 1];
  return `Token totals omit ${head}, and ${last} because those seats are not reporting usage.`;
}
