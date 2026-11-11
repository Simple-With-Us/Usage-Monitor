import { datadogLogs } from "@datadog/browser-logs";
import { datadogRum } from "@datadog/browser-rum";

import type { DatadogRumConfig } from "@/lib/datadog-options";

let started = false;

export function isDatadogRumStarted(): boolean {
  return started;
}

/**
 * Browser RUM + logs.  Session replay stays at 0 so this does not open a
 * new Datadog product on an org that does not already have RUM replay.
 * Errors stay visible (forwarded, never swallowed).
 */
export function startDatadogRum(config: DatadogRumConfig): void {
  if (!config.enabled || started) return;

  datadogRum.init({
    applicationId: config.applicationId,
    clientToken: config.clientToken,
    site: config.site,
    service: config.service,
    env: config.env,
    version: config.version,
    sessionSampleRate: config.sessionSampleRate,
    sessionReplaySampleRate: config.sessionReplaySampleRate,
    trackUserInteractions: true,
    trackResources: true,
    trackLongTasks: true,
    defaultPrivacyLevel: "mask-user-input",
    allowedTracingUrls: [
      { match: /https:\/\/usage\.jays\.services/, propagatorTypes: ["datadog"] },
      {
        match: /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/,
        propagatorTypes: ["datadog"],
      },
    ],
  });

  datadogLogs.init({
    clientToken: config.clientToken,
    site: config.site,
    service: config.service,
    env: config.env,
    version: config.version,
    forwardErrorsToLogs: true,
    forwardConsoleLogs: ["error", "warn"],
    sessionSampleRate: config.sessionSampleRate,
  });

  started = true;
}

export function resetDatadogRumForTests(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("resetDatadogRumForTests is test-only");
  }
  started = false;
}
