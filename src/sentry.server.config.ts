// Self error-reporting for THIS app (review finding O4). Imported lazily from
// src/instrumentation.ts register() when NEXT_RUNTIME === "nodejs".
//
// DSN-gated by design: with SENTRY_DSN unset the SDK is never initialized and
// this module is a complete no-op, so CI/dev/production builds and boots never
// require any Sentry configuration. Never hardcode a DSN here.

import * as Sentry from "@sentry/nextjs";

import { nonEmptyEnv, parseTracesSampleRate } from "@/lib/sentry-options";
import {
  sentryBeforeSend,
  sentryBeforeSendSpan,
  sentryPrivacyIntegration,
  sentryBeforeSendLog,
  sentryBeforeSendMetric,
  sentryBeforeSendTransaction,
} from "@/lib/sentry-scrubber";

const dsn = nonEmptyEnv(process.env.SENTRY_DSN);

if (dsn) {
  Sentry.init({
    dsn,
    environment: nonEmptyEnv(process.env.SENTRY_ENVIRONMENT),
    tracesSampleRate: parseTracesSampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE),
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
    profileSessionSampleRate: parseTracesSampleRate(
      process.env.SENTRY_PROFILE_SESSION_SAMPLE_RATE ?? "1"
    ),
    profileLifecycle: "trace",
    // Audit 2026-09-20: any object key whose name contains a sensitive
    // substring (token/secret/key/password/passwd/auth) is replaced with
    // "[REDACTED]" before the event is sent. Defensive guard against
    // future regressions where a thrown Error carries a payload with
    // secret-shaped metadata. See src/lib/sentry-scrubber.ts.
    //
    // Four hooks, all using the same scrubber, because Sentry 10.74
    // routes each payload family through its own beforeSend*:
    //   - beforeSend: ErrorEvent (the original motivation)
    //   - beforeSendTransaction: TransactionEvent (sampled request spans)
    //   - beforeSendLog: Sentry.logger.* payloads (the explicit motivation
    //     in audit finding b176925a, since logIngestFailed uses Sentry.logger)
    //   - beforeSendMetric: Sentry.metrics.* payloads (counters/gauges)
    //
    // The `as unknown as` cast is necessary because @sentry/nextjs
    // re-bundles its own copy of @sentry/core whose event types are
    // structurally identical but nominally distinct from the ones
    // imported inside the scrubber.
    beforeSendSpan: sentryBeforeSendSpan,
    beforeSend: sentryBeforeSend as unknown as Parameters<typeof Sentry.init>[0]["beforeSend"],
    beforeSendTransaction:
      sentryBeforeSendTransaction as unknown as Parameters<typeof Sentry.init>[0]["beforeSendTransaction"],
    beforeSendLog:
      sentryBeforeSendLog as unknown as Parameters<typeof Sentry.init>[0]["beforeSendLog"],
    beforeSendMetric:
      sentryBeforeSendMetric as unknown as Parameters<typeof Sentry.init>[0]["beforeSendMetric"],
    integrations: [sentryPrivacyIntegration(), Sentry.nodeRuntimeMetricsIntegration()],
  });
}
