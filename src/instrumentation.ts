export function isUsageSchedulerEnabled(
  configured = process.env.USAGE_SCHEDULER_ENABLED
): boolean {
  return configured?.trim().toLowerCase() !== "false";
}

export async function register() {
  // Infisical sole-source-of-truth: load app-level tunable knobs into the
  // in-memory settings cache before anything else boots.  Non-fatal: with no
  // universal-auth credentials (local dev, CI, build) it stays in env-fallback
  // mode; a failed Infisical load degrades loudly to the deploy-time env sync.
  // The import is dynamic (not a top-level static import) so the shared
  // package never enters the edge-runtime (middleware) bundle.
  // See INFISICAL.md and src/lib/app-settings.ts.
  let settingsGet: ((key: string) => string | undefined) | undefined;
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { appSettings } = await import("@/lib/app-settings");
    await appSettings.init();
    // On-demand refresh for operators: `kill -HUP <pid>` re-reads Infisical.
    // The background timer (default 5 min) handles the steady state.
    process.on("SIGHUP", () => {
      void appSettings.refresh();
    });
    settingsGet = (key: string) => appSettings.get(key);
  }

  // Datadog APM + log injection.  Fail closed on missing/partial keys in
  // production runtime (not during `next build`).  Sentry stays DSN-gated
  // and is not replaced.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { resolveDatadogServerConfig } = await import("@/lib/datadog-options");
    const server = resolveDatadogServerConfig();
    if (server.enabled) {
      const { initDatadogTracer } = await import("@/lib/datadog-server");
      initDatadogTracer(server);
    }
  }

  // Self error-reporting (review finding O4). Both config modules are fully
  // DSN-gated internally: with SENTRY_DSN unset they import and no-op, so
  // this costs nothing in CI/dev. Done BEFORE the nodejs early-return below
  // so the edge runtime (middleware) is covered too.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
    // Removed @sentry/profiling-node integration (Seer finding USAGE-MONITOR-3)
    // because loading the native addon synchronously blocked the event loop for 
    // ~11 minutes at startup, stalling client component requests (e.g., /login).
  } else if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }

  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Bound native (non-heap) SQLite memory before any request or scheduler
  // tick can issue a query. Next.js guarantees register() completes before
  // the server accepts a request, so this ordering is safe without an
  // explicit lock. Applied unconditionally - HTTP requests use Prisma even
  // when the polling scheduler below is emergency-disabled. See the
  // comment on applySqliteNativeMemoryPragmas in src/lib/prisma.ts.
  const { applySqliteNativeMemoryPragmas } = await import("@/lib/prisma");
  await applySqliteNativeMemoryPragmas();

  // Record which device/inode DATABASE_URL resolved to now that Prisma has
  // opened it (the pragmas above run a query on the single pooled connection),
  // so /api/ready can later notice the pathname being deleted or swapped out
  // from under the live writer. `SELECT 1` cannot: an open descriptor on an
  // unlinked inode answers it. Never throws; the first readiness probe
  // re-attempts capture if this one could not.
  const { captureDatabaseFileBaseline } = await import("@/lib/runtime-health");
  captureDatabaseFileBaseline();

  // Keep legacy provider evidence, but prevent the retired/dormant built-ins
  // from making another external request. This is a small idempotent update
  // and intentionally runs even when the scheduler is emergency-disabled.
  const { deactivateDecommissionedBuiltInProviders } = await import(
    "@/lib/provider-retirement"
  );
  await deactivateDecommissionedBuiltInProviders();

  // One-time cleanup (not a standing policy): clears any LLM/AI provider's
  // mustKeepFunded flag that predated it, then records completion so it
  // never runs again. The owner remains free to turn Must keep funded back
  // on for any provider from the dashboard; this call is a no-op after its
  // first successful pass. See src/lib/provider-funding-policy.ts.
  const { clearLlmMustKeepFundedFlags } = await import(
    "@/lib/provider-funding-policy"
  );
  await clearLlmMustKeepFundedFlags();

  // Wave K / C10: production should set a distinct USAGE_READ_TOKEN so a
  // compromised read consumer cannot also forge ingest. resolveUsageReadToken
  // already denies the ingest fallback in production; surface a boot-time
  // warning when the dedicated token is missing.
  if (
    process.env.NODE_ENV === "production" &&
    !process.env.USAGE_READ_TOKEN?.trim()
  ) {
    console.warn(
      "[auth] USAGE_READ_TOKEN is unset in production — GET /api/budget-status and dual-auth subscriptions GET will 503 until it is set (ingest fallback is denied in production)"
    );
  }

  // NOTE: an earlier revision warmed the budget-status SWR caches here at
  // boot. It was removed after it crash-looped production: warming
  // computeProjectBudgetStatus runs its internal Promise.all
  // (computeBudgetStatus's ~336k-row groupBy AND sumMonthToDateExternalCost-
  // Attribution's ~336k-row groupBy) concurrently, and two of those
  // aggregations at once peaked past the 512MB instance limit and OOM-killed
  // the instance ~40-100s into every boot. The SWR cache still works fine
  // populated lazily on first request; it just must not be forced at boot on
  // this box. Reducing that per-compute footprint (so warming is safe again)
  // is tracked as a follow-up. See @/lib/budget-status.

  // USAGE_SCHEDULER_ENABLED is a tunable knob owned by the settings service
  // (Infisical cache in production, process.env in env-fallback mode); the
  // process.env fallback covers a key absent from the Infisical cache.
  if (
    !isUsageSchedulerEnabled(
      settingsGet?.("USAGE_SCHEDULER_ENABLED") ?? process.env.USAGE_SCHEDULER_ENABLED
    )
  ) {
    console.warn(
      "[usage-scheduler] disabled by USAGE_SCHEDULER_ENABLED=false"
    );
    const { logSchedulerOutcome } = await import("./lib/sentry-ops");
    void logSchedulerOutcome("disabled", { reason: "USAGE_SCHEDULER_ENABLED=false" });
    return;
  }
  const { startUsagePollingScheduler } = await import("@/lib/usage-recorder");
  startUsagePollingScheduler();
}

// Next 15 `onRequestError` hook: captures errors from Server Components,
// route handlers, and middleware into Sentry (review finding O4). The SDK is
// imported lazily so this module's static import graph is unchanged (the
// webpack dev compiler already struggles with Node builtins via this file —
// see AGENTS.md — and we must not add another edge-analysis edge case).
// captureRequestError is itself a no-op unless a DSN-gated init ran above.
export async function onRequestError(
  ...args: Parameters<typeof import("@sentry/nextjs").captureRequestError>
): Promise<void> {
  const Sentry = await import("@sentry/nextjs");
  Sentry.captureRequestError(...args);
}
