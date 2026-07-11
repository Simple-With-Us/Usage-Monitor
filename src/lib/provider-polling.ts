import type { Provider } from "@prisma/client";
import { BUILT_IN_PROVIDERS } from "@/lib/provider-definitions";

const MANUAL_PROVIDER_TYPES = new Set(["generic", "manual"]);
const NO_POLL_BUILT_INS = new Set(
  BUILT_IN_PROVIDERS.filter((provider) => provider.usesApiKey === false).map(
    (provider) => provider.name
  )
);

/**
 * Generic/manual providers are bookkeeping rows. They intentionally have no
 * poll adapter or endpoint, so treating their provider name as a custom
 * adapter produces a false "endpoint is required" failure on every cycle.
 */
export function isManualProvider(
  provider: Pick<Provider, "type" | "name">
): boolean {
  const type = provider.type?.trim().toLowerCase();
  if (MANUAL_PROVIDER_TYPES.has(type)) return true;
  return type === "builtin" && NO_POLL_BUILT_INS.has(provider.name.trim().toLowerCase());
}
