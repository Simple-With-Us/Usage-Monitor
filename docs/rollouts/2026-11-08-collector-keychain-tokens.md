# Per-Consumer Collector Tokens In The Mac Login Keychain

Eight collector bindings read through their own scoped Infisical service tokens in the owner's login keychain instead of plaintext files.  The ninth, Codex, accepts only Infisical-synced values injected for its own consumer.  The nine binding files are tracked, with shared resolution and the per-consumer differences held in thin bindings.

## Why The Files Were Missing

The nine files were never in a Git ref.  A search of every remote and local ref of Usage-Monitor, and of every blob in the local object store, found no copy of them and no trace of a deletion: the read and the binding never existed in the repository's history.  They existed only as an untracked working-tree copy in the Mac lane that last installed the collectors, and the installer copies with `rsync --delete`, so the next clean install would have removed them and every collector that imported one would have failed to load.

The files were near-identical forks of `scripts/lib/run-session-token-collector.mjs`, each about four hundred lines, differing only in four constants: the path of the plaintext token file, the human label used in error messages, the token's own name, and the pinned grant id.  They were also stale: they predated `configureCollectorSentryToken`, `codexSessionCwd`, `botFleetWorkspaceRoots`, the `reportMissing` and `readDirectory` options on `walkFiles`, and the strict-injected-secrets guard, so a collector running one of them was not running the shared library the rest of the repository had.

## The Rule

A secret lives in the secret store of the host that consumes it.  A Mac consumer keeps its value in the owner's login keychain.  A server consumer never reaches for the Mac keychain, and a Mac consumer never reaches for a server-side file.  A 0600 file on disk is staging only: it is how a value is handed to the keychain, and it is deleted once the keychain item is in place.

The keychain item is one generic-password item per token.  The service is `infisical-service-token` and the account is the token's own registry name, so a reader that holds the registry row finds the item by that name.  The value is never in the environment, never in a LaunchAgent plist and never in the shared `fleet-secrets` reader.

The login keychain is reachable only from the owner's GUI session.  A launchd agent bootstrapped into the user's GUI session is in that session; a plain shell over SSH is not, and `security` there answers that interaction is not allowed.  A collector outside that session therefore fails closed and says the keychain was locked, rather than reaching for another credential.

## What Is In The Repository

`scripts/lib/keychain-service-token.mjs` reads one item from the login keychain and reports which refusal it was: the item was not there, the keychain refused the read, or the read failed.  It never logs the value, and it never puts the item's attributes into an error.

`scripts/lib/scoped-collector-token.mjs` is the one implementation of the scoped read.  It takes the consumer's token from the keychain, refuses it unless it carries the grant id that consumer was given, and then checks the token's own metadata against the binding before any secret is read: the project, the token's name, the grant id, the folder scope, the read-only permission and the expiry.  A token that is not the one that was granted stops the collector there.

The two Infisical responses are external, so neither is read field by field before it is validated: the service-token metadata and the secret body are parsed through zod schemas, a malformed or hostile body is refused whole, and only the validated shape reaches the binding check or the secret map.  The known fields are still checked against the binding exactly as before.

The resolver honours COLLECTOR_STRICT_INJECTED_SECRETS=1 as environment-only, the same way the shared resolver does, so a host that asked for environment-only resolution never reaches the login keychain and never makes an Infisical request.  The lookup is built once per resolver and shared, so the keychain read, the metadata request and the per-folder fetches happen once per run rather than once per name the collector asks for.

`scripts/lib/codex-run-session-token-collector.mjs` forces the shared resolver's injected-secrets mode on every call.  It accepts `CODEX_INGEST_TOKEN` before `USAGE_INGEST_TOKEN` from its supplied environment and returns no token when both are absent.  A caller cannot enable runtime lookups by supplying a lookup function or disabling strict mode.  The former System keychain automation reader is removed; Codex performs no keychain read, universal-auth login, CLI lookup or default-folder discovery.

The nine per-consumer files under `scripts/lib/` are thin and re-export the shared library.  Eight override the resolver with the scoped reader; their binding data is the token's account name, the human label, the pinned grant id, the project and the folders.  All eight scoped consumers share one project, the root folder and the global API keys folder, and read permission only.  Codex overrides the shared resolver only to require injected values.  The shared implementations keep reads from drifting between consumers.

## The Entry Points

Each of the nine collectors now imports its own binding instead of the shared library, and awaits the resolver.  The eight other collectors, which have no per-consumer grant, keep the shared library and are unchanged.

The Codex collector's resolver stays synchronous and preserves the shared library's public exports and option shape.  It copies the supplied environment before forcing injected mode, leaving caller options and environment unchanged.  Awaiting its result remains supported.

## The Install Order

The plaintext files are deleted only after the merged collectors are deployed and proven to read the keychain.  The order is the same one the Mac resource watcher used: install the keychain items, deploy the merged collectors, prove the read, then overwrite the plaintext files with zeros and remove them.  A collector that cannot find its keychain item says so and stops; it never falls back to a file.

## The Test

`scripts/collector-keychain.node-test.mjs` runs under Node's own test runner as part of the collector runtime gate.  Every keychain read goes through an injected stand-in for `security`, so the test never touches the real keychain.  It covers the item lookup and its arguments, the three refusals and how they are told apart, the refusal to read an invalid account name, the grant id check, the malformed-token refusal, the environment taking precedence over the keychain, the metadata binding refusal, the refusal of a malformed Infisical body, the strict mode that reaches neither the keychain nor Infisical, the shared lookup that reads the keychain once, and the rule that a failed read never carries the value.  It pins the eight scoped bindings to their own accounts, labels, grant ids, project and folders.  Codex fixtures exercise the actual wrapper and shared resolver in bounded isolated child processes, guard commands with inert authentication traps, and reject provider calls.  They verify injected name priority, changed values between calls, absent and partial bootstrap, immutable caller options and the inability to bypass injected mode.  The suite also checks each entry point's binding import and awaited resolver, the other collectors' shared imports, and the absence of plaintext token readers.

## What Is Not Covered Here

The Codex source change does not qualify an actual grant or installed injector.  Its own service-token custody, exact project/prod/folder/read metadata, finite expiry, producer injection and installed collector acceptance remain separate gates.  No account, grant id or folder is inferred, and the generic CLI resolver's compatibility lookups do not establish that qualification.

The ninth plaintext file on the Mac, `fleet-zulip-client-read`, is not a collector token and has no consumer that a search of the Mac's applications, launch agents, secrets directory and configuration found.  It is moved to the keychain on its own footing, not by this change.

The nine collector grants have no row in the Fleet-OPS registry.  The registry names each service token and where its value lives, and a reader holding the registry row is how a keychain item is found, so the rows belong with this change and are filed separately.
