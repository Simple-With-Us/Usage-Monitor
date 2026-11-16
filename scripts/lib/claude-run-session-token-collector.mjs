/**
 * Claude usage collector token binding.
 *
 * This collector reads its ingest token with its OWN scoped Infisical
 * service token:  the grant is named "claude-usage-collector-read", it is pinned to one
 * project, to the "/" and "/global-api-keys" folders and to one grant id,
 * and it is read from the owner's login keychain under that same name.  The
 * value is not in the environment, not in a file on disk and not in the
 * shared `fleet-secrets` reader.  A 0600 file is staging only:  it is how
 * a value is handed to the keychain, and it is deleted once the keychain
 * item is in place.
 *
 * The read itself lives in scripts/lib/scoped-collector-token.mjs;  this
 * file holds only the binding, so the read cannot drift between consumers.
 */
import { createScopedCollectorTokenResolver } from "./scoped-collector-token.mjs";

export * from "./run-session-token-collector.mjs";

/** This consumer's own grant:  the name, the label, the id and the scope. */
export const collectorTokenBinding = {
  account: "claude-usage-collector-read",
  label: "Claude usage",
  grantId: "7933c487-9059-430b-b251-b40783639f39",
  project: "8dae6d03-8f12-48b2-adf3-e5c1b881c8c5",
  folders: ["/", "/global-api-keys"],
};

export const resolveCollectorToken = createScopedCollectorTokenResolver(collectorTokenBinding);
