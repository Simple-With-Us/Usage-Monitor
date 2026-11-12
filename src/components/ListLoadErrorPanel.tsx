/**
 * "This list failed to load" panel for tables that would otherwise fall through
 * to their empty state. An outage must never render as "nothing configured
 * yet" — that reads as an empty account and invites duplicate setup. Shaped
 * like the empty-state panels it replaces so the tab layout does not shift.
 */
export default function ListLoadErrorPanel({
  message,
  detail,
  onRetry,
}: {
  message: string;
  detail?: string | null;
  onRetry?: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-xl border border-gray-200 bg-white py-16 text-center dark:border-gray-700 dark:bg-gray-800">
      <p role="alert" className="px-6 text-red-600 dark:text-red-300">
        {message}
        {detail ? ` ${detail}` : ""}
      </p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-900"
        >
          Retry
        </button>
      )}
    </div>
  );
}
