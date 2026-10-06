import type { EventHint } from "@sentry/core";
import { describe, expect, it } from "vitest";

import {
  sentryBeforeSend,
  sentryBeforeSendLog,
  sentryBeforeSendMetric,
  sentryBeforeSendTransaction,
} from "../sentry-scrubber";

const NO_HINT: EventHint = {};

describe("sentryBeforeSend", () => {
  it("redacts keys whose names contain 'token', 'secret', 'key', 'password', 'passwd', or 'auth'", () => {
    const result = sentryBeforeSend(
      {
        type: "test" as never,
        request: { headers: { authorization: "Bearer real-bearer-token" } },
        extra: {
          apiToken: "real-token-value",
          apiSecret: "real-secret-value",
          apiKey: "real-key-value",
          password: "real-password-value",
          passwd: "real-passwd-value",
          authHeader: "real-auth-value",
          benignValue: "kept-as-is",
        },
        tags: { region: "us-east-1" },
      },
      NO_HINT
    );
    expect(result).not.toBeNull();
    const typed = result as unknown as {
      extra: Record<string, unknown>;
      request: { headers: Record<string, unknown> };
      tags: Record<string, unknown>;
    };
    expect(typed.extra.apiToken).toBe("[REDACTED]");
    expect(typed.extra.apiSecret).toBe("[REDACTED]");
    expect(typed.extra.apiKey).toBe("[REDACTED]");
    expect(typed.extra.password).toBe("[REDACTED]");
    expect(typed.extra.passwd).toBe("[REDACTED]");
    expect(typed.extra.authHeader).toBe("[REDACTED]");
    expect(typed.extra.benignValue).toBe("kept-as-is");
    expect(typed.tags.region).toBe("us-east-1");
    expect(typed.request.headers).toBeUndefined();
  });

  it("preserves Sentry's dynamicSamplingContext.public_key but redacts application sessionKey", () => {
    // Codex review P2: `public_key` MUST be preserved (dynamic sampling
    // breaks otherwise). Codex re-review P2: `sessionKey` is just a
    // naming coincidence, NOT an SDK-owned field, and treating it as
    // safe globally would let callers stash credentials under that key
    // and bypass scrubbing. So sessionKey must now be redacted.
    const result = sentryBeforeSend(
      {
        type: "test" as never,
        sdkProcessingMetadata: {
          dynamicSamplingContext: {
            public_key: "abc123-public-dsn-key",
            trace_id: "kept-trace-id",
          },
          requestSession: { status: "ok" },
        } as unknown as Record<string, unknown>,
        extra: { sessionKey: "stashed-credential-under-this-name" },
      },
      NO_HINT
    );
    expect(result).not.toBeNull();
    const typed = result as unknown as {
      sdkProcessingMetadata: {
        dynamicSamplingContext: { public_key: string; trace_id: string };
        requestSession: { status: string };
      };
      extra: { sessionKey: string };
    };
    expect(typed.sdkProcessingMetadata.dynamicSamplingContext.public_key).toBe(
      "abc123-public-dsn-key"
    );
    expect(typed.sdkProcessingMetadata.dynamicSamplingContext.trace_id).toBe("kept-trace-id");
    expect(typed.sdkProcessingMetadata.requestSession.status).toBe("ok");
    expect(typed.extra.sessionKey).toBe("[REDACTED]");
  });

  it("redacts secrets embedded in URL query strings (Codex P1)", () => {
    const result = sentryBeforeSend(
      {
        type: "test" as never,
        request: {
          url: "https://usage.jays.services/api/bills.ics?token=real-calendar-token-here",
        },
        transaction: "/api/bills.ics?token=another-real-token",
        extra: { urlWithMultipleParams: "/api/x?safe=true&token=secret-value&page=1" },
      },
      NO_HINT
    );
    expect(result).not.toBeNull();
    const typed = result as unknown as {
      request: { url: string };
      transaction: string;
      extra: { urlWithMultipleParams: string };
    };
    expect(typed.request.url).toBe(
      "https://usage.jays.services/api/bills.ics?token=[REDACTED]"
    );
    expect(typed.transaction).toBe("/api/bills.ics?token=[REDACTED]");
    expect(typed.extra.urlWithMultipleParams).toBe("/api/x?safe=true&token=[REDACTED]&page=1");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("real-calendar-token-here");
    expect(serialized).not.toContain("another-real-token");
    expect(serialized).not.toContain("secret-value");
  });

  it("redacts bare query-string credentials without a leading ? (Codex re-review P1)", () => {
    const result = sentryBeforeSend(
      {
        type: "test" as never,
        request: {
          url: "https://usage.jays.services/api/bills.ics?token=url-token",
          query_string: "token=query-string-token&page=2",
        },
      },
      NO_HINT
    );
    expect(result).not.toBeNull();
    const typed = result as unknown as { request: { url: string; query_string: string } };
    expect(typed.request.url).toBe("https://usage.jays.services/api/bills.ics?token=[REDACTED]");
    expect(typed.request.query_string).toBe("token=[REDACTED]&page=2");
  });

  it("redacts common auth-shape URL params (api_key, access_token, refresh_token)", () => {
    const result = sentryBeforeSend(
      {
        type: "test" as never,
        request: {
          url: "https://example.com/x?api_key=ak-real&access_token=at-real&refresh_token=rt-real",
        },
      },
      NO_HINT
    );
    expect(result).not.toBeNull();
    const typed = result as unknown as { request: { url: string } };
    expect(typed.request.url).toBe(
      "https://example.com/x?api_key=[REDACTED]&access_token=[REDACTED]&refresh_token=[REDACTED]"
    );
  });

  it("scrubs Sentry SDK-internal cyclic metadata without recursing (Codex re-review P1)", () => {
    const cyclicScope: Record<string, unknown> = { type: "Scope" };
    cyclicScope.self = cyclicScope; // cycle
    const cyclicIsolationScope: Record<string, unknown> = { type: "IsolationScope" };
    cyclicIsolationScope.self = cyclicIsolationScope; // cycle
    const result = sentryBeforeSend(
      {
        type: "test" as never,
        sdkProcessingMetadata: {
          capturedSpanScope: cyclicScope,
          capturedSpanIsolationScope: cyclicIsolationScope,
          requestSession: { status: "ok" },
        } as unknown as Record<string, unknown>,
      },
      NO_HINT
    );
    expect(result).not.toBeNull();
    const typed = result as unknown as {
      sdkProcessingMetadata: {
        capturedSpanScope: string;
        capturedSpanIsolationScope: string;
        requestSession: { status: string };
      };
    };
    expect(typed.sdkProcessingMetadata.capturedSpanScope).toBe("[SDK_INTERNAL]");
    expect(typed.sdkProcessingMetadata.capturedSpanIsolationScope).toBe("[SDK_INTERNAL]");
    expect(typed.sdkProcessingMetadata.requestSession.status).toBe("ok");
  });

  it("recurses into nested objects and arrays", () => {
    const result = sentryBeforeSend(
      {
        type: "test" as never,
        breadcrumbs: [
          { data: { token: "real" } },
          { message: "kept" },
        ],
        extra: { nested: { apiKey: "real", safe: { child: "kept" } } },
      },
      NO_HINT
    );
    expect(result).not.toBeNull();
    const typed = result as unknown as {
      breadcrumbs: Array<{ data?: { token?: string }; message?: string }>;
      extra: { nested: { apiKey: string; safe: { child: string } } };
    };
    expect(typed.breadcrumbs[0].data?.token).toBe("[REDACTED]");
    expect(typed.breadcrumbs[1].message).toBe("kept");
    expect(typed.extra.nested.apiKey).toBe("[REDACTED]");
    expect(typed.extra.nested.safe.child).toBe("kept");
  });

  it("returns the event unchanged when it is null, undefined, or a non-object", () => {
    expect(sentryBeforeSend(null as unknown as Parameters<typeof sentryBeforeSend>[0], NO_HINT)).toBe(
      null
    );
    expect(
      sentryBeforeSend(undefined as unknown as Parameters<typeof sentryBeforeSend>[0], NO_HINT)
    ).toBe(undefined);
    expect(
      sentryBeforeSend("string" as unknown as Parameters<typeof sentryBeforeSend>[0], NO_HINT)
    ).toBe("string");
    expect(
      sentryBeforeSend(42 as unknown as Parameters<typeof sentryBeforeSend>[0], NO_HINT)
    ).toBe(42);
  });

  it("does not throw when the input is malformed", () => {
    const input: Record<string, unknown> = { extra: {} };
    input.extra = input; // cycle
    expect(() =>
      sentryBeforeSend(
        input as unknown as Parameters<typeof sentryBeforeSend>[0],
        NO_HINT
      )
    ).not.toThrow();
  });
});

describe("sentryBeforeSendTransaction", () => {
  it("scrubs transaction events using the same key-name + URL regex", () => {
    // Mirror the error-path test for the transaction path so we never
    // regress the scrubber contract there.
    const result = sentryBeforeSendTransaction(
      {
        type: "transaction" as never,
        transaction: "/api/bills.ics?token=tx-token",
        sdkProcessingMetadata: {
          dynamicSamplingContext: { public_key: "abc" },
          capturedSpanScope: (() => {
            const c: Record<string, unknown> = {};
            c.self = c;
            return c;
          })(),
        } as unknown as Record<string, unknown>,
      } as unknown as Parameters<typeof sentryBeforeSendTransaction>[0],
      NO_HINT
    );
    expect(result).not.toBeNull();
    const typed = result as unknown as {
      transaction: string;
      sdkProcessingMetadata: {
        dynamicSamplingContext: { public_key: string };
        capturedSpanScope: string;
      };
    };
    expect(typed.transaction).toBe("/api/bills.ics?token=[REDACTED]");
    expect(typed.sdkProcessingMetadata.dynamicSamplingContext.public_key).toBe("abc");
    expect(typed.sdkProcessingMetadata.capturedSpanScope).toBe("[SDK_INTERNAL]");
  });
});

describe("sentryBeforeSendLog", () => {
  it("scrubs log payloads from Sentry.logger.* calls (Codex re-review P2)", () => {
    // This is the explicit motivation for the scrubber: logIngestFailed
    // in src/lib/sentry-ops.ts routes through Sentry.logger, and the
    // attributes it passes (route, reason, etc.) could carry user data
    // in future regressions.
    const result = sentryBeforeSendLog({
      message: { formatted: "ingest failed" },
      attributes: {
        route: "ingest/usage",
        reason: "Error",
        apiToken: "stashed",
      },
    } as unknown as Parameters<typeof sentryBeforeSendLog>[0]);
    expect(result).not.toBeNull();
    const typed = result as unknown as {
      attributes: Record<string, unknown>;
    };
    expect(typed.attributes.route).toBe("ingest/usage");
    expect(typed.attributes.reason).toBe("Error");
    expect(typed.attributes.apiToken).toBe("[REDACTED]");
  });
});

describe("sentryBeforeSendMetric", () => {
  it("scrubs metric payloads from Sentry.metrics.* calls (Codex re-review P2)", () => {
    const result = sentryBeforeSendMetric({
      name: "ingest.failed",
      attributes: {
        route: "ingest/usage",
        apiKey: "stashed",
      },
    } as unknown as Parameters<typeof sentryBeforeSendMetric>[0]);
    expect(result).not.toBeNull();
    const typed = result as unknown as { attributes: Record<string, unknown> };
    expect(typed.attributes.route).toBe("ingest/usage");
    expect(typed.attributes.apiKey).toBe("[REDACTED]");
  });
});
