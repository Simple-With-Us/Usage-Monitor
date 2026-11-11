"use client";

import { useEffect } from "react";
import Link from "next/link";
import * as Sentry from "@sentry/nextjs";
import { ReportProblemButton } from "@/components/ReportProblemButton";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
    try {
      Sentry.captureException(error);
    } catch {
      /* Sentry not initialized in this env; never let observability break the UI */
    }
    const ddRum = (globalThis as { DD_RUM?: { addError?: (e: unknown) => void } }).DD_RUM;
    if (ddRum?.addError) {
      try {
        ddRum.addError(error);
      } catch {
        /* ignore — never let observability break the UI */
      }
    }
  }, [error]);

  return (
    <section
      aria-labelledby="app-error-title"
      className="mx-auto flex min-h-64 max-w-lg flex-col items-center justify-center gap-4 rounded-xl border border-red-200 bg-red-50 px-6 py-10 text-center dark:border-red-900 dark:bg-red-950/30"
    >
      <div>
        <h1 id="app-error-title" className="text-xl font-semibold text-gray-900 dark:text-gray-100">
          This view could not be loaded
        </h1>
        <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">
          Your saved data was not changed. Retry the view, or return to the dashboard.
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-3">
        <button
          type="button"
          onClick={reset}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-900"
        >
          Retry
        </button>
        <Link
          href="/"
          className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
        >
          Dashboard
        </Link>
        <ReportProblemButton className="rounded-lg px-4 py-2 text-sm font-medium text-gray-600 underline underline-offset-2 hover:text-gray-900 dark:text-gray-300 dark:hover:text-gray-100">
          Report a Problem
        </ReportProblemButton>
      </div>
    </section>
  );
}
