import tracer from "dd-trace";

import type { DatadogServerConfig } from "@/lib/datadog-options";

let initialized = false;

/**
 * Initialize the Node APM tracer.  Safe to call more than once.
 * Does not swallow init errors — a broken tracer must fail closed.
 */
export function initDatadogTracer(config: DatadogServerConfig): void {
  if (!config.enabled || initialized) return;

  tracer.init({
    service: config.service,
    env: config.env,
    version: config.version,
    hostname: config.hostname,
    port: config.port,
    sampleRate: config.sampleRate,
    logInjection: config.logInjection,
    runtimeMetrics: config.runtimeMetrics,
  });
  initialized = true;
  console.info(
    `[datadog] tracer initialized service=${config.service} env=${config.env} site=${config.site}`
  );
}

export function resetDatadogTracerForTests(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("resetDatadogTracerForTests is test-only");
  }
  initialized = false;
}
