import { costCoverageHelpText, type CostCoverageKind } from "@/lib/cost-coverage-help";

const ITEMS: ReadonlyArray<{
  kind: CostCoverageKind;
  label: string;
  chipClass: string;
}> = [
  {
    kind: "complete",
    label: "Complete",
    chipClass: "bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200",
  },
  {
    kind: "partial",
    label: "Known",
    chipClass: "bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200",
  },
  {
    kind: "unknown",
    label: "not reported",
    chipClass: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  },
  {
    kind: "legacy_unknown",
    label: "Gap",
    chipClass: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  },
];

/**
 * Always-visible cost-coverage legend (Wave D / D4). Reuses
 * `costCoverageHelpText` so wording matches tooltips elsewhere. Each chip is
 * a `<details>` disclosure (same pattern as ProviderTable.tsx coverage
 * caveats) so touch users without hover can read the full definition.
 */
export default function CostCoverageLegend() {
  return (
    <section
      aria-label="Cost coverage legend"
      className="rounded-xl border border-gray-200 bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-800"
    >
      <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
        Cost coverage
      </p>
      <ul className="mt-2 flex flex-wrap items-start gap-2">
        {ITEMS.map((item) => (
          <li key={item.kind}>
            <details className={`rounded-full text-xs font-medium ${item.chipClass}`}>
              <summary className="inline-flex min-h-7 cursor-pointer list-none items-center rounded-full px-2.5 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 [&::-webkit-details-marker]:hidden">
                {item.label}
              </summary>
              <p className="max-w-56 px-2.5 pb-2 pt-0.5 font-normal leading-relaxed">
                {costCoverageHelpText(item.kind)}
              </p>
            </details>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[11px] text-gray-500 dark:text-gray-400">
        Tap a chip for the full definition. “Known” is a priced subtotal, not
        a complete bill.
      </p>
    </section>
  );
}
