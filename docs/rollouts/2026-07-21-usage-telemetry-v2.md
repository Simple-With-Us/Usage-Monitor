# Usage telemetry v2 receiver rollout

Date: 2026-07-21

## Scope

- Pin immutable `@jaywedgeworth22/congress-trading-shared#v2.0.0` at merge commit
  `19a077a4a8245963775c9fedb462a6741b0a70aa`.
- Validate v2 batches through the shared Zod schema rather than a second hand-written
  wire parser.
- Derive persistence idempotency from the shared canonical `producerId + eventId`
  algorithm.
- Preserve producer instance, producer key, provider connection, billing account, and
  coverage references in event metadata until monitor-owned first-class columns are
  justified.
- Return explicit v2 persistence ACK counts and typed retry/error bodies.
- Retain the existing unversioned parser only for durable v1 receipts and backlog.

Fresh producers must send only v2. Existing durable v1 outbox rows may use the shared
legacy replay adapter. There is no dual-write path.

## Verification

- Shared release independently installed without repository credentials; CJS and ESM
  imports both loaded.
- Focused parser and route tests cover canonical identity, reference preservation,
  schema rejection, ACK counts, and typed authorization errors.
- Full repository verification and production revision receipt are release gates, not
  implied by merge.

## Review remediation (2026-07-22)

- Replaced the GitHub shorthand with an explicit HTTPS dependency and HTTPS
  lockfile resolution; a clean `npm ci` with SSH disabled builds and imports the
  exact `v2.0.0` tag as CJS and ESM.
- The route now recognizes `schemaVersion: 2` from the decoded body, so the
  custom version header is advisory rather than required. Headerless valid v2
  batches and typed validation failures are regression-tested.

## Rollback

Revert the receiver commit while keeping the v1 replay parser. Producers must not be
promoted until this receiver revision is confirmed live, so rollback cannot strand a
v2-only producer behind an older production receiver.
