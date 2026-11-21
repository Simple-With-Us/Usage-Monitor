/**
 * Codex usage collector token binding.
 *
 * Only Infisical-synced values injected for this consumer are accepted.
 * Its own grant, injector and installed delivery require qualification;
 * this binding never discovers credentials or authenticates at runtime.
 */
import { resolveCollectorToken as resolveInjectedToken } from "./run-session-token-collector.mjs";

export * from "./run-session-token-collector.mjs";

export function resolveCollectorToken(names, options = {}) {
  return resolveInjectedToken(names, {
    ...options,
    env: { ...(options.env ?? process.env), COLLECTOR_STRICT_INJECTED_SECRETS: "1" },
  });
}
