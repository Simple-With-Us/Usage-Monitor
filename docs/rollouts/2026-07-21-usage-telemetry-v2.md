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

## Updates

- 2026-07-29 (X9): the shared pin in `package.json` is now
  `@jaywedgeworth22/congress-trading-shared#v2.3.0`; the `#v2.0.0` pin recorded above
  is historical. The v2 wire schema, canonical idempotency, and ACK contract are
  unchanged by this bump.
- 2026-07-29 (X2, documentation half): **producer requirement** — producers must
  persist an outbox of unsent events and honor the receiver's backoff signals. A
  `503` with error code `receiver_busy` (or any `retryAfterSeconds` /
  `Retry-After` value in a typed v2 error body) means "retry this exact batch
  later"; the events are deduped by their canonical idempotency keys, so retrying
  is always safe. Fire-and-forget sends without an outbox can silently lose
  events under receiver backpressure. The conforming client lives in the
  `congress-trading-shared` package (producer repos), not here.
