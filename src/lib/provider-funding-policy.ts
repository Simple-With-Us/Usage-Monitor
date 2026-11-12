import { isLlmProviderName } from "@/lib/provider-definitions";

/**
 * Dashboard visibility for ProviderPlan.mustKeepFunded.
 *
 * LLM/AI connections do not need a stay-funded floor (chat inference goes
 * through OpenRouter). Hide the checkbox for those names so the owner is
 * not nudged to turn it on. The API still accepts mustKeepFunded=true, so
 * this can be un-hidden later without a schema or route change.
 */
export function isMustKeepFundedOptionVisible(providerName: string): boolean {
  return !isLlmProviderName(providerName);
}
