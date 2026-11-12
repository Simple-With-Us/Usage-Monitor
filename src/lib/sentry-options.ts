// Shared, dependency-free options for the app's OWN Sentry SDK init
// (review finding O4: self error-reporting, off by default).
//
// Kept separate from the sentry.server/edge/client config files so all three
// runtimes parse env vars identically. Everything here is a pure function on
// strings — safe to import from the client (browser) bundle as well.

/**
 * Parses SENTRY_TRACES_SAMPLE_RATE (or its NEXT_PUBLIC_ client twin).
 * Defaults to 0.2 (20% baseline distributed tracing) when omitted.
 * Non-numeric or negative values fall back to 0; values above 1 are clamped to 1.
 */
export function parseTracesSampleRate(raw: string | undefined): number {
  if (raw === undefined || raw === null || raw.trim() === "") return 0.2;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.min(parsed, 1);
}

/** Trims an env var to a non-empty value, else undefined. */
export function nonEmptyEnv(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/** Only the existing configured HTTPS Sentry intake belongs in browser CSP. */
export function sentryConnectSrcOrigins(raw = process.env.NEXT_PUBLIC_SENTRY_DSN): string[] {
  if (!raw?.trim()) return [];
  try {
    const dsn = new URL(raw.trim());
    if (dsn.protocol !== "https:" ||
        !/^o\d+\.ingest(?:\.[a-z]+)?\.sentry\.io$/.test(dsn.hostname) ||
        !/^[a-f\d]+$/i.test(dsn.username) || dsn.password || dsn.port || dsn.search || dsn.hash ||
        !/^\/\d+$/.test(dsn.pathname)) return [];
    return [dsn.origin];
  } catch { return []; }
}
