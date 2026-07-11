import type { Provider } from "@prisma/client";

const MANUAL_PROVIDER_TYPES = new Set(["generic", "manual"]);

/**
 * Generic/manual providers are bookkeeping rows. They intentionally have no
 * poll adapter or endpoint, so treating their provider name as a custom
 * adapter produces a false "endpoint is required" failure on every cycle.
 */
export function isManualProvider(
  provider: Pick<Provider, "type">
): boolean {
  return MANUAL_PROVIDER_TYPES.has(provider.type?.trim().toLowerCase());
}
