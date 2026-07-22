# Provider key attribution

## Outcome

An account/admin billing credential can report usage for several provider keys without exposing
those API keys. Usage Monitor now has a separate, auditable identity layer for that case:

- `ProviderKeyIdentity` stores an operator alias/description and, when supplied, only an
  HMAC-SHA256 fingerprint of the provider-reported stable opaque key ID.
- `ProviderKeyBinding` maps one exact `producerId` + `producerKeyRef` to the identity and optional
  project for a half-open effective period. Reassignment closes the old binding and creates its
  replacement in one transaction at one timestamp; similar labels never match. The selected project
  name is authoritative, immutable history, so a later rename or deletion cannot change the label or
  whether historical usage is project-attributed.
- `providerConnectionRef` and `billingAccountRef` are optional exact contextual constraints. They
  cannot identify a key by themselves. A blank constraint is an explicit wildcard, and the UI warns
  that such a binding is broad-scope.
- Missing, unknown, or conflicting keys remain explicit `unattributed` results. Ambiguity fails
  open instead of assigning spend.
- Retiring an identity closes active mappings but preserves resolution for observations before the
  retirement time. Providers with attribution history must be deactivated rather than deleted.

The `/attribution` UI supports identity registration, timezone-aware effective binding, atomic
reassignment, project selection, binding close, identity retirement, per-identity current-month
spend, and discovered unmatched references that prefill the mapping form. Mapping rows show their
effective dates and exact connection/account constraints.
Raw provider/API keys are never returned. The optional `ATTRIBUTION_IDENTITY_HMAC_KEY` should stay
stable across deploys; the required `ENCRYPTION_KEY` is a domain-separated fallback. During a key
rotation, retain prior values temporarily in comma-separated
`ATTRIBUTION_IDENTITY_HMAC_PREVIOUS_KEYS` so existing fingerprints continue resolving.

## Money semantics

The coverage panel scans only shared telemetry schema-v2 `api_key`-scope records for identity
coverage and sums `costUsd` only when coverage is explicitly `point|window` plus `disjoint`.
Project, provider-connection, billing-account, cumulative, overlapping, and unknown records are
excluded from key counts and remain numerically unclassified. It does not include provider polling
snapshots or account-wide canonical billing totals. That prevents a per-key breakdown from being
added to an account total a second time or from replacing existing max/dedup rules.

Shared telemetry v2.0 carries `producerKeyRef`, `providerConnectionRef`, and `billingAccountRef`.
It does not have a separate `providerReportedKeyId` field. The monitor therefore treats
`producerKeyRef` only as the producer's non-secret local reference and never interprets or HMAC-matches
it as a provider ID. An administrator binds that exact local reference. Provider-reported IDs are
fingerprinted only when explicitly registered and are reserved for a distinct additive contract
field after receiver and producer backward-compatibility tests; producers must not put credentials or
provider IDs into `producerKeyRef` as a workaround.

## Verification

- Node 24 focused Vitest: 3 files / 32 tests passed.
- Node 24 `tsc --noEmit`: passed.
- Scoped ESLint and `git diff --check`: passed.
- Disposable SQLite `prisma db push --skip-generate`: passed; both new tables, foreign keys,
  uniqueness constraints, and indexes were present.

No production database, provider credential, provider API, deploy, DNS, writer, or scheduler was
changed by this implementation lane.
