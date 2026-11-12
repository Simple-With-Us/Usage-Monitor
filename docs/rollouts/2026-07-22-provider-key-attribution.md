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
  retirement time. Never-started future mappings remain visible as zero-length canceled history and
  do not block replacements. Providers with attribution history must be deactivated rather than deleted.

The `/attribution` UI supports identity registration, timezone-aware effective binding, atomic
reassignment, project selection, binding close, identity retirement, per-identity current-month
spend, and discovered unmatched references that prefill the mapping form. Mapping rows show their
effective dates and exact connection/account constraints.
Raw provider/API keys are never returned. The optional `ATTRIBUTION_IDENTITY_HMAC_KEY` should stay
stable across deploys; the required `ENCRYPTION_KEY` is a domain-separated fallback. During a key
rotation, retain prior values temporarily in comma-separated
`ATTRIBUTION_IDENTITY_HMAC_PREVIOUS_KEYS` so existing fingerprints continue resolving. Before
removing previous keys, re-enter each raw provider-reported ID via `POST` action
`rehash_identity` so stored digests are rewritten under the current key.
Rotation rejects a logical duplicate found under the current fingerprint or any still-accepted
previous-key fingerprint, including when the selected row is blank or already current.

## Money semantics

The coverage panel scans only shared telemetry schema-v2 `api_key`-scope records for identity
coverage and sums `costUsd` only when coverage is explicitly `point` plus `disjoint`, or `window`
plus `disjoint` with present `windowStart`/`windowEnd` that do not span a binding reassignment or
identity retirement. Spanning or boundsless windows stay unclassified rather than attributing the
whole amount to one identity. Project, provider-connection, billing-account, cumulative,
overlapping, and unknown records are excluded from key counts and remain numerically unclassified.
Point records resolve at their own `occurredAt`, not at month start, so a reassignment within the
month does not move earlier cost. If an event project and binding project disagree, identity cost
remains matched but project coverage fails closed as explicitly conflicted and unattributed.
It does not include provider polling snapshots or account-wide canonical billing totals. That
prevents a per-key breakdown from being added to an account total a second time or from replacing
existing max/dedup rules.

Shared telemetry v2.0 carries `producerKeyRef`, `providerConnectionRef`, and `billingAccountRef`.
It does not have a separate `providerReportedKeyId` field. The monitor therefore treats
`producerKeyRef` only as the producer's non-secret local reference and never interprets or HMAC-matches
it as a provider ID. An administrator binds that exact local reference. Provider-reported IDs are
fingerprinted only when explicitly registered and are reserved for a distinct additive contract
field after receiver and producer backward-compatibility tests; producers must not put credentials or
provider IDs into `producerKeyRef` as a workaround.

## Verification

- Node 24 focused Vitest: 3 files / 41 tests passed.
- Node 24 `tsc --noEmit`: passed.
- Scoped ESLint and `git diff --check`: passed.
- Disposable SQLite `prisma db push --skip-generate`: passed; both new tables, foreign keys,
  uniqueness constraints, and indexes were present.
- Exact reviewed code tree full `npm run verify`: ESLint, TypeScript, 132 files / 1,447 tests,
  receipt worker 8/8, migration/backup/startup/Oracle gates, iOS simulator and Release builds,
  Swift package test build, Safari iOS/macOS builds, and Next production build passed.

PR #761 was externally squash-merged from an earlier head before the final point-time and audit-
authority fixes could be pushed. The corrective PR contains exactly that reviewed code delta; the
earlier merge must not be treated as the final production receipt. No provider credential, provider
API, DNS, writer, scheduler, or manual production-data mutation was performed by this lane.
