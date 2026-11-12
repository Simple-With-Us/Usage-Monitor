"use client";

import Link from "next/link";
import OperationsOverview from "@/components/OperationsOverview";

export default function OpsPageClient() {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Ops</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Receipt inbox and sibling service health — not part of your spend totals.
          </p>
        </div>
        <Link
          href="/#operations"
          className="inline-flex min-h-11 items-center rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
        >
          View on Overview
        </Link>
      </div>
      <OperationsOverview />
    </div>
  );
}
