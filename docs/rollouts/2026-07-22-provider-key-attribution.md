# Provider key attribution

## Outcome

An account/admin billing credential can report usage for several provider keys without exposing
those API keys. Usage Monitor now has a separate, auditable identity layer for that case:

- `ProviderKeyIdentity` stores an operator alias/description and, when supplied, only an
  HMAC-SHA256 fingerprint of the provider-reported stable opaque key ID.
- `ProviderKeyBinding` maps one exact `producerId` + `producerKeyRef` to the identity and optional
  project for a half-open effective period. Reassignment closes the old binding before creating a
  new one; similar labels never match.
- `providerConnectionRef` and `billingAccountRef` are optional exact contextual constraints. They
  cannot identify a key by themselves.
- Missing, unknown, or conflicting keys remain explicit `unattributed` results. Ambiguity fails
  open instead of assigning spend.
- Retiring an identity closes active mappings but preserves resolution for observations before the
  retirement time. Providers with attribution history must be deactivated rather than deleted.

The `/attribution` UI supports identity registration, effective binding, project selection,
binding close, identity retirement, per-identity current-month spend, and an unmatched bucket.
Raw provider/API keys are never returned. The optional `ATTRIBUTION_IDENTITY_HMAC_KEY` should stay
stable across deploys; the required `ENCRYPTION_KEY` is a domain-separated fallback.

## Money semantics

The coverage panel scans shared telemetry schema-v2 records for identity coverage, but sums
`costUsd` only when coverage is explicitly `point|window` plus `disjoint`. Cumulative,
overlapping, and unknown cost records remain numerically unclassified. It does not include provider
polling snapshots or account-wide canonical billing totals, and its response says so. That prevents
a per-key breakdown from being added to an account total a second time or from replacing existing
max/dedup rules.

Shared telemetry v2.0 carries `producerKeyRef`, `providerConnectionRef`, and `billingAccountRef`.
It does not have a separate `providerReportedKeyId` field. For v2.0, an opaque provider-reported
stable key reference may be the `producerKeyRef`; the monitor HMAC-compares that reference to
registered provider identities before consulting administrator bindings. A distinct additive contract field can be
considered only after the receiver and producers land with backward-compatibility tests.

## Verification

- Node 24 focused Vitest: 3 files / 26 tests passed.
- Node 24 `tsc --noEmit`: passed.
- Scoped ESLint and `git diff --check`: passed.
- Disposable SQLite `prisma db push --skip-generate`: passed; both new tables, foreign keys,
  uniqueness constraints, and indexes were present.

No production database, provider credential, provider API, deploy, DNS, writer, or scheduler was
changed by this implementation lane.
