"use client";

import type { ReactNode } from "react";

type ReportProblemButtonProps = {
  children?: ReactNode;
  className?: string;
};

export function openFeedbackOrMailto(): void {
  if (typeof window === "undefined") return;
  const open = (
    window as unknown as { openSentryFeedback?: () => boolean | void }
  ).openSentryFeedback;
  // The helper is always a function once instrumentation-client loads, even
  // when Feedback was never initialized.  false means "form did not open".
  if (typeof open === "function") {
    const opened = open();
    if (opened !== false) return;
  }
  window.location.href = "mailto:mail@jays.services?subject=Report%20a%20Problem";
}

/** Subtle Sentry feedback trigger.  Falls back to mailto when Sentry is dark. */
export function ReportProblemButton({
  children = "Report a Problem",
  className,
}: ReportProblemButtonProps) {
  return (
    <button type="button" onClick={openFeedbackOrMailto} className={className}>
      {children}
    </button>
  );
}
