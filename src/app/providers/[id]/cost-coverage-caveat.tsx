import { AlertTriangle } from "lucide-react";
import type {
  ProviderCostCoverage,
  ProviderCostCoverageCaveat,
} from "@/components/ProviderCard";

/**
 * Prominent, page-level rendering of a cost coverage caveat (e.g. Cloudflare
 * PayGo usage-based billing being unreadable while the fixed subscription
 * fee is still known). This is the most detailed provider view, so the
 * warning gets its own full-width banner rather than the smaller badge/line
 * treatment used on the dashboard card and settings table - same orange +
 * AlertTriangle treatment as the family row in DashboardProviderWorkspace.tsx.
 *
 * Kept in its own module (rather than inline in page.tsx) so it can be a
 * named export: Next.js's generated route types reject any named export
 * from a page.tsx beyond the handful it recognizes (default, metadata,
 * generateStaticParams, ...), so a pure component/function meant to be unit
 * tested has to live outside the page file itself.
 */
export function CostCoverageCaveatBanner({
  caveat,
}: {
  caveat: ProviderCostCoverageCaveat | null | undefined;
}) {
  if (!caveat) return null;
  return (
    <div className="flex items-start gap-3 rounded-xl border border-orange-200 bg-orange-50 px-4 py-3 text-sm text-orange-800 dark:border-orange-900 dark:bg-orange-950/40 dark:text-orange-200">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div>
        <p className="font-semibold">Cost coverage gap</p>
        <p>{caveat.message}</p>
      </div>
    </div>
  );
}

/**
 * Short label under the "Tracked spend this month" stat. Must never read as
 * "complete cost coverage" when a costCoverageCaveat is present - that
 * caveat exists specifically because coverage is known-incomplete for a
 * documented reason, so pairing it with an unconditional "complete" label
 * would leave this page presenting the same misleading result the caveat
 * feature was built to surface.
 */
export function spendCoverageNoteText(
  spendCoverage: ProviderCostCoverage,
  costCoverageCaveat: ProviderCostCoverageCaveat | null | undefined
): string {
  if (costCoverageCaveat) return "cost coverage gap";
  return spendCoverage === "complete" ? "complete cost coverage" : "cost coverage unknown";
}
