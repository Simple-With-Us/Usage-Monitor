/**
 * Plain-language explanations for the cost-coverage states (see
 * `ProviderCostCoverage` in ProviderCard.tsx / `ExternalCostCoverage` in
 * ExternalTelemetryPanel.tsx - same four states, described here once so the
 * wording stays consistent everywhere a "known" / "(partial)" label shows
 * up: ProviderTable, ProviderCard, DashboardProviderWorkspace, and the
 * provider detail page.
 *
 * This is presentation-only help text (surfaced via a `title` tooltip next
 * to the label) - it does not change any coverage classification or
 * accounting. Prompted by the owner asking what "known" / "known partial"
 * actually meant.
 */

export type CostCoverageKind = "complete" | "partial" | "unknown" | "legacy_unknown";

export function costCoverageHelpText(coverage: CostCoverageKind): string {
  switch (coverage) {
    case "complete":
      return "Every usage event for this period has a known price, so this figure is the full cost.";
    case "partial":
      return '"Known" means the priced subtotal only, from events that have a known price. It excludes unpriced usage, so the true total is at least this much and may be higher.';
    case "legacy_unknown":
      return "Historical data from before cost coverage was tracked for this provider - pricing completeness for this period is unknown, so this amount is not confirmed as the full cost.";
    case "unknown":
    default:
      // Deliberately does not spell out the digits "0.00" here - several
      // tests assert the rendered HTML never contains that literal string
      // for unknown-cost cases, precisely to guard against ever implying an
      // authoritative zero. "an authoritative zero" conveys the same point
      // in prose without tripping that guard.
      return "No usage events have a known price yet, so cost is not reported. This is not the same as an authoritative zero - it means cost is unverified, not confirmed to be nothing.";
  }
}
