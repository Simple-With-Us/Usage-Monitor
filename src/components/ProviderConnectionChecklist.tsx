import Link from "next/link";

export type ConnectionChecklistItem = {
  id: string;
  label: string;
  done: boolean;
  detail?: string;
  href?: string;
};

/**
 * Post-add / push-only setup checklist (Wave D / D5). Presentational only —
 * callers compute done/detail from provider state.
 */
export default function ProviderConnectionChecklist({
  title = "Connection checklist",
  items,
  pushOnlyHint = false,
}: {
  title?: string;
  items: ConnectionChecklistItem[];
  /** Show OTLP/push setup pointer for blind/push-primary providers. */
  pushOnlyHint?: boolean;
}) {
  return (
    <section
      aria-label={title}
      className="rounded-xl border border-gray-200 bg-white px-4 py-4 dark:border-gray-700 dark:bg-gray-800"
    >
      <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
      <ul className="mt-3 space-y-2">
        {items.map((item) => (
          <li key={item.id} className="flex items-start gap-2 text-sm">
            <span
              aria-hidden="true"
              className={`mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                item.done
                  ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                  : "bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-300"
              }`}
            >
              {item.done ? "✓" : "·"}
            </span>
            <div className="min-w-0">
              {item.href ? (
                <Link
                  href={item.href}
                  className="font-medium text-blue-600 hover:underline dark:text-blue-400"
                >
                  {item.label}
                </Link>
              ) : (
                <span className="font-medium text-gray-900 dark:text-gray-100">
                  {item.label}
                </span>
              )}
              {item.detail && (
                <p className="text-xs text-gray-500 dark:text-gray-400">{item.detail}</p>
              )}
            </div>
          </li>
        ))}
      </ul>
      {pushOnlyHint && (
        <div className="mt-3 rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-900 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-100">
          <p className="font-semibold">Send usage from the app</p>
          <p className="mt-1">
            This provider does not offer a safe account report. Send usage from the app that spends it, or from Claude Code&apos;s metrics feed.
            {"\u00A0 "}
            Set a monthly budget in Settings so alerts still fire.
          </p>
        </div>
      )}
    </section>
  );
}

export function buildProviderConnectionChecklist(input: {
  providerId: string;
  hasSnapshot: boolean;
  hasBudget: boolean;
  spendCoverage: string | null | undefined;
  isBlindOrPushOnly: boolean;
  lastFetchedAt: string | null | undefined;
}): ConnectionChecklistItem[] {
  return [
    {
      id: "poll-or-push",
      label: input.isBlindOrPushOnly
        ? "Usage is sent from the app"
        : "Usage Monitor can read this account",
      done: input.hasSnapshot || input.isBlindOrPushOnly,
      detail: input.isBlindOrPushOnly
        ? "This provider has no account report. Cost arrives only when an app sends it."
        : input.hasSnapshot
          ? "At least one usage snapshot exists."
          : "Waiting for the first successful read.",
      href: `/providers/${input.providerId}`,
    },
    {
      id: "snapshot",
      label: "Usage snapshot present",
      done: input.hasSnapshot,
      detail: input.lastFetchedAt
        ? `Last sync ${new Date(input.lastFetchedAt).toLocaleString()}`
        : "No snapshot yet.",
      href: `/providers/${input.providerId}`,
    },
    {
      id: "cost-channel",
      label: "Cost channel known",
      done:
        input.spendCoverage === "complete" || input.spendCoverage === "partial",
      detail:
        input.spendCoverage === "complete"
          ? "Coverage complete."
          : input.spendCoverage === "partial"
            ? "Partial (known) cost only."
            : "Cost not reported yet.",
    },
    {
      id: "budget",
      label: "Monthly budget set",
      done: input.hasBudget,
      detail: input.hasBudget
        ? "Budget is configured for alerts."
        : "Set a budget so thresholds and projections work.",
      href: `/providers/${input.providerId}`,
    },
  ];
}
