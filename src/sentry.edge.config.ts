// Edge-runtime twin of src/sentry.server.config.ts (middleware only). Same
// DSN gating: no SENTRY_DSN -> no init -> complete no-op.

import * as Sentry from "@sentry/nextjs";

import { nonEmptyEnv, parseTracesSampleRate } from "@/lib/sentry-options";
import { sentryBeforeSend, sentryBeforeSendTransaction } from "@/lib/sentry-scrubber";

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
    // Mirror the server config's defensive scrubber for both error and
    // transaction paths. The middleware can emit sampled request
    // transactions (e.g. /api/bills.ics?token=...) and those go through
    // beforeSendTransaction, not beforeSend — installing only the error
    // hook would let transaction URLs leak unsanitized. See
    // src/lib/sentry-scrubber.ts. The `as unknown as` cast matches the
    // server config's note about @sentry/nextjs's nested @sentry/core copy.
    beforeSend: sentryBeforeSend as unknown as Parameters<typeof Sentry.init>[0]["beforeSend"],
    beforeSendTransaction:
      sentryBeforeSendTransaction as unknown as Parameters<typeof Sentry.init>[0]["beforeSendTransaction"],
  });
}
