# One-time ST Gemini Infisical bootstrap

## Scope

This is a one-time server-side migration, not bidirectional credential sync.
It can only consider Provider `4a888d41-3988-4774-86d8-67d7aa14d7e2` and can
only create the shared `GEMINI_API_KEY` at the Socratic.Trade Infisical project
`39d93bb7-76f9-498c-8b50-a7def52e072f`, environment `prod`, path `/`.

The bootstrap never updates or deletes an Infisical secret. The normal
Infisical-to-monitor pull remains the steady-state direction and binds the
newly created value only after a successful bootstrap and exact bounded
post-create read prove the fixed scope contains the validated fingerprint.

## Preconditions

- The fixed provider is active, builtin Google AI, allocated exactly 100% and
  exclusively to `SocraticTrade.com`, and has no CT/shared Infisical binding.
- Its latest successful Gemini key validation is at most 24 hours old and its
  server-only credential fingerprint matches the currently encrypted key.
- The ST Universal Auth credentials are configured.
- A value-disabled list preflight succeeds for the exact fixed scope, followed
  by an exact read proving `GEMINI_API_KEY` is missing.
- The provider generation and key fingerprint remain unchanged on the final
  re-read immediately before the create request.
- A successful create response is followed by an exact value-bearing read of
  the fixed project/environment/path/name/type. The value fingerprint must
  equal the freshly validated monitor key before the same-cycle pull proceeds.
  Infisical v4 response identity is checked using its documented fields:
  `workspace` (the fixed ST project ID), `secretKey`, `type`, `environment`,
  and `secretPath`. The POST response must contain the first four exact fields;
  Infisical omits `secretPath` there. The authoritative post-create GET must
  contain all five, including `secretPath=/`, plus the expected value
  fingerprint. Request-side `projectId` is never accepted as response proof.
  Ordinary steady-state secret reads remain value-compatible when upstream
  omits response identity metadata.

Any failed or ambiguous precondition stops before creation. An existing equal
value is a no-op; an existing different value is a hard conflict. While the
one-time flag is enabled, every non-success bootstrap outcome also suppresses
only the ST Gemini mapping in the immediately following normal pull, so a
conflicting remote value cannot replace the validated monitor credential.
Other provider mappings continue to sync normally.

The initial-binding equality guard is permanent and does not depend on the
one-time flag. While the fixed provider remains unbound, every ordinary ST
Gemini pull must prove that the remote fingerprint equals the provider's fresh,
successful fingerprint-bound validation. A differing remote value remains
blocked after the flag is disabled. Once that equal value establishes the
exact ST binding, Infisical resumes its normal source-of-truth role and later
remote key rotations are allowed.

## Reviewed production procedure

1. Confirm a fresh successful provider validation and healthy provider polling.
2. Set only `INFISICAL_ST_GEMINI_BOOTSTRAP_ENABLED=true` on the Render service.
3. Observe the sanitized `[infisical-st-gemini-bootstrap]` result. It contains
   only provider ID, status, attempted, and an optional bounded error code.
4. Confirm status `created` or `already_present_same`. For `created`, this means
   the exact post-create verification read matched. Then confirm the normal
   one-way sync attached the ST Infisical binding without creating a duplicate.
5. Immediately set `INFISICAL_ST_GEMINI_BOOTSTRAP_ENABLED=false`.

For `conflict`, `ineligible`, or `error`, disable the flag and investigate.
Do not retry by PATCH/upsert and do not delete anything automatically.
Disabling the flag cannot bypass a conflict: the permanent initial-binding
guard continues preserving the validated monitor key until the remote value is
equal or an administrator performs a separate reviewed reconciliation.

The currently configured `agentic-trading` machine identity has broad project
Admin access and is permitted here only for this reviewed one-time bootstrap.
Follow-up hardening should give Usage Monitor a dedicated allowlisted ST reader
and use a separate temporary create-only writer for future migrations; do not
downgrade the application identity without first auditing Socratic.Trade's own
secret requirements.

## Rollback

Because the operation is create-only and leaves the monitor credential intact,
rollback is limited to an explicit administrator deleting the exact newly
created Infisical secret/version. The normal pull retains last-known-good
monitor credentials when a source becomes missing. If the pull already attached
the new ST binding, remove only that binding with the provider configuration
generation guard as a separate reviewed operation.
