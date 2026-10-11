// Cursor Admin API poller gate.
//
// The Admin API is team-plan only.  The poller stays off unless an operator
// sets CURSOR_ADMIN_POLLER_ENABLED.  A missing key is then a startup error
// so the scheduled job and its Sentry cron monitor are never registered
// half-configured.  This module has no server-only import so sentry-ops can
// refuse a check-in without pulling the poller onto a client graph.

const ENABLED_VALUES = new Set(["true", "1", "on", "yes"]);

export function isCursorAdminPollerEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const raw = env.CURSOR_ADMIN_POLLER_ENABLED?.trim().toLowerCase() ?? "";
  return ENABLED_VALUES.has(raw);
}

export class CursorAdminPollerConfigError extends Error {
  constructor(
    message = "CURSOR_ADMIN_POLLER_ENABLED is set but CURSOR_ADMIN_API_KEY is required.  The Cursor Admin API poller is optional and team-plan only.  Unset CURSOR_ADMIN_POLLER_ENABLED to leave it off, or set the team Admin API key before startup."
  ) {
    super(message);
    this.name = "CursorAdminPollerConfigError";
  }
}

/** No-op when the poller is off.  Throws when it is on without an API key. */
export function assertCursorAdminPollerConfigured(
  env: NodeJS.ProcessEnv = process.env
): void {
  if (!isCursorAdminPollerEnabled(env)) return;
  if (env.CURSOR_ADMIN_API_KEY?.trim()) return;
  throw new CursorAdminPollerConfigError();
}
