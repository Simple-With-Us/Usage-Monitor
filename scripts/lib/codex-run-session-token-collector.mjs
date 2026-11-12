/**
 * Codex usage collector token binding.
 *
 * The Codex collector reads its ingest token with the System Keychain
 * automation identity, as permitted by the owner:  no fleet-secrets
 * executable and no personal CLI session is used.  That identity is shared
 * and is not a per-consumer grant, so it is neither one of the scoped
 * service tokens the other collectors use nor something the owner's login
 * keychain should hold.
 *
 * The read itself lives in scripts/lib/automation-collector-token.mjs;  this
 * file holds only the binding, so it cannot drift from the shared library.
 */
import { createAutomationCollectorTokenResolver } from "./automation-collector-token.mjs";

export * from "./run-session-token-collector.mjs";

export const resolveCollectorToken = createAutomationCollectorTokenResolver();
