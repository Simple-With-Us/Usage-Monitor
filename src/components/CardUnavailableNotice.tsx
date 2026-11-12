/**
 * Explicit "this card could not load" state. Cards that fetch their own data
 * must render this instead of `null` on request failure — a monitoring card
 * that silently vanishes reads as "nothing to report", which is the opposite
 * of the truth during an incident. Mirrors the amber banner already used for
 * portfolio load failures in DashboardPortfolioSection.
 */
export default function CardUnavailableNotice({
  title,
  detail,
  onRetry,
}: {
  title: string;
  detail?: string;
  onRetry?: () => void;
}) {
  return (
    <div
      role="status"
      className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200"
    >
      <span className="font-medium">{title}</span>
      {detail ? <span> {detail}</span> : null}
      {onRetry ? (
        <>
          {" "}
          <button
            type="button"
            onClick={onRetry}
            className="font-semibold underline underline-offset-2"
          >
            Retry
          </button>
        </>
      ) : null}
    </div>
  );
}
