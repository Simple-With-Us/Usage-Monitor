import Link from "next/link";

export default function NotFound() {
  return (
    <section className="mx-auto flex min-h-64 max-w-lg flex-col items-center justify-center gap-4 text-center">
      <div>
        <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Page not found</h1>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
          The provider or view may have moved or been removed.
        </p>
      </div>
      <Link
        href="/"
        className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      >
        Back to dashboard
      </Link>
    </section>
  );
}
