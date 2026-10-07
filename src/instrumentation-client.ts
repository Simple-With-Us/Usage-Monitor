// Browser-side self error-reporting (review finding O4). Next.js picks this
// file up automatically (it replaces the old sentry.client.config convention).
//
// Browser env vars must be NEXT_PUBLIC_* to be inlined at build time, so the
// client is gated on NEXT_PUBLIC_SENTRY_DSN independently of the server-side
// SENTRY_DSN. Unset -> no init -> complete no-op (CI/dev need nothing).

import * as Sentry from "@sentry/nextjs";

import { startDatadogRum } from "@/lib/datadog-rum-client";
import { resolveDatadogRumConfig } from "@/lib/datadog-options";
import { sentryBeforeSend, sentryBeforeSendTransaction, sentryBeforeSendLog, sentryBeforeSendMetric, sentryBeforeSendSpan, sentryPrivacyIntegration } from "@/lib/sentry-scrubber";
import { nonEmptyEnv, parseTracesSampleRate } from "@/lib/sentry-options";

// Build-time RUM (same NEXT_PUBLIC_* bake as Sentry).  Incomplete public
// keys stay dark — do not throw from this module or Next.js white-screens
// login.  Runtime Infisical tokens are picked up by DatadogRumInit.
try {
  const rum = resolveDatadogRumConfig();
  if (rum.enabled) {
    startDatadogRum(rum);
  }
} catch (error) {
  console.error(
    "[datadog] incomplete RUM config; skipping client init",
    error
  );
}

const dsn = nonEmptyEnv(process.env.NEXT_PUBLIC_SENTRY_DSN);

if (dsn) {
  // Replay recordings bypass event hooks.  Keep recording off until separately
  // approved and verified; restoring error transport must not enable recordings.
  Sentry.init({
    dsn,
    environment: nonEmptyEnv(process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT),
    tracesSampleRate: parseTracesSampleRate(
      process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE
    ),
    // v11: `enableLogs` was removed (logs flow via Sentry.logger.* and logging
    // integrations; the Sentry.logger call sites here are unaffected). v11 also
    // replaced `sendDefaultPii` with per-category `dataCollection` - a behavior
    // change, not a rename. This repo never set sendDefaultPii, so v10 was
    // restrictive-by-default while v11 collects everything unless pinned. Keep
    // the v10 posture explicitly (migration guide "Keeping the v10 collection
    // defaults"); the scrubber hooks below remain the last line of defense.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: {
        request: { deny: ["forwarded", "-ip", "remote-", "via", "-user"] },
        response: { deny: ["forwarded", "-ip", "remote-", "via", "-user"] },
      },
      httpBodies: [],
      urlQueryParams: { deny: ["forwarded", "-ip", "remote-", "via", "-user"] },
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      graphQL: { document: false, variables: false },
    },
    beforeSend: sentryBeforeSend,
    beforeSendTransaction: sentryBeforeSendTransaction,
    beforeSendLog: sentryBeforeSendLog,
    beforeSendMetric: sentryBeforeSendMetric,
    beforeSendSpan: sentryBeforeSendSpan,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    integrations: [sentryPrivacyIntegration()],
  });
}

/** Feedback text is excluded; callers use their existing mailto fallback. */
export function openSentryFeedback(): boolean {
  return false;
}

if (typeof window !== "undefined") {
  (window as unknown as { openSentryFeedback?: typeof openSentryFeedback }).openSentryFeedback = openSentryFeedback;
}

// Instruments client-side router navigations. Harmless when init never ran
// (Sentry no-ops without a client).
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;

