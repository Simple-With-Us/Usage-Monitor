export default function Loading() {
  return (
    <div role="status" aria-live="polite" className="space-y-6 animate-pulse">
      <span className="sr-only">Loading Usage Monitor</span>
      <div className="h-8 w-48 rounded bg-gray-200 dark:bg-gray-700" />
      <div className="h-24 rounded-xl border border-gray-200 bg-gray-100 dark:border-gray-700 dark:bg-gray-800" />
      <div className="h-80 rounded-xl border border-gray-200 bg-gray-100 dark:border-gray-700 dark:bg-gray-800" />
    </div>
  );
}
