# Usage compliance: reconciliation schema, ingest acceptance, and the Wave-3 audit layer

**Date:** 2026-07-19 · **Seat:** CLAUDE · **Initiative:** cross-repo usage compliance & OpenRouter
classifier metadata (pickup of the paused MONET handoff).

Authoritative design: `/Users/jay/apps/DESIGN-usage-compliance-classifier.md` — **read its two
`AMENDED` notes**, both of which came out of adversarial review during this work and are now
reflected in shipped code.

---

## What the initiative is

Three workstreams built together across four repos:

1. **Universal ingestion** — every app reliably pushes usage telemetry to the monitor.
2. **Reconciliation / compliance** — the monitor compares each app's *self-reported* usage against
   *provider-verified* usage wherever ground truth exists, and flags drift.
3. **Classifier metadata** — every OpenRouter call carries rich metadata, and its generation id is
   relayed to the monitor so cost can be verified per call.

---

## What landed in this repo

### Wave 1b — schema + ingest acceptance (PR #581, `fbf73f14`) — DEPLOYED

Additive Prisma only:

- `ExternalUsageEvent` gains `providerRequestId` plus `verifiedCostUsd` / `verifiedAt` /
  `verificationStatus` / `verifiedSource`, and two indexes.
- New `ProviderUsageReconciliation` model (period-scoped audit rows).
- `/api/ingest/usage` accepts and persists `providerRequestId`.

Two properties were treated as non-negotiable and proven by test:

- **The idempotency key is byte-identical.** `providerRequestId` is deliberately *not* one of its
  inputs, and is excluded from `comparableEvent`, so a replay carrying a different (or absent)
  generation id still dedupes rather than raising a collision. First write wins; the stored id is
  never overwritten.
- **A producer can never mark its own usage verified.** The `verified*` fields are unreachable from
  the wire at the parse layer, the persist layer, and the replay path. A regression test posts a
  payload claiming `verificationStatus: "match"` through the *real* route and asserts all four
  columns persist as `null`.

`keyRef` on `ProviderUsageReconciliation` is `String @default("")`, **not** nullable — SQLite treats
each `NULL` as distinct in a unique index and Prisma cannot target a `NULL` member of a compound
unique, so a nullable column would have made the period upsert unenforceable. `""` is the
provider-wide sentinel.

### Wave 3 — the audit layer (PR #617)

PR #590 previously landed this inline in `usage-maintenance.ts`. Reading it against `main` before
building on top showed it was **non-functional in production**, and it is superseded here.

**Why #590 could never work:** it selected events on `keyRef startsWith "gen-"`, but the OpenRouter
generation id lives in `providerRequestId`; `keyRef` holds the *API-key reference* (Congress.Trade
pushes `keyRef: apiKeyName`). It therefore matched zero real rows and always returned 0. Its test
passed only because the fixture wrote the generation id *into* `keyRef` — encoding the bug rather
than the producer contract. It also never verified cost at all (it compared `payload.id` to the id it
had just queried and never wrote `verifiedCostUsd`), used a status vocabulary the schema does not
define, never retried, wrote reconciliation rows with `deleteMany` + `create` against a *moving*
`periodEnd = now` (defeating the very unique key that was designed for upsert, non-atomically
destroying history every pass), silently skipped providers whose billing is structurally
unverifiable, and held the single SQLite writer across all of its HTTP calls.

**What replaces it:**

`src/lib/openrouter-generation-verification.ts`
- Selects on `providerRequestId` with the corrected due-scan
  `(verificationStatus IS NULL OR verificationStatus IN ('pending','error'))`. The explicit `IS NULL`
  matters: SQL `IN (NULL, …)` never matches `NULL`, so the original predicate would have skipped
  every freshly-ingested event.
- Bounded to 25 per pass, deterministically ordered, with `truncated` reported so a backlog is
  visible rather than hidden.
- Stores the provider's authoritative `total_cost` as `verifiedCostUsd` + `verifiedAt` +
  `verifiedSource`, and classifies `match` / `discrepancy` on an absolute-OR-ratio tolerance.
- A `null` reported cost counts as `0`, so pushing no cost while the provider charged real money is
  **drift, not a match**.
- A missing or unparseable cost is a **retryable error, never a fabricated `$0`** — a synthetic zero
  would read as "the provider says this was free" and cancel real drift.
- `401/403` stops the pass and reports `degraded` instead of burning every pending event's retry
  budget on one configuration problem. `degraded` now also fails `isUsageMaintenanceHealthy`, so a
  key that cannot read generations can't silently disable the audit layer.
- Retries are capped, and an exhausted event is parked in the **terminal** `unverifiable` status.
  This is load-bearing: `error` is retryable, so parking there would re-select the row forever, reset
  its attempt counter, consume a batch slot every pass, and — because the scan is oldest-first —
  permanently starve newly-ingested events while burning API calls.
- **Network I/O happens outside the write-admission lock** (phase 1), with bounded writes inside it
  (phase 2), matching the discipline `alert-delivery` already follows.

`src/lib/provider-usage-reconciliation.ts`
- Stable UTC month bounds so the unique key is actually addressable, and `upsert` instead of
  delete + create.
- Providers whose catalog `billing.visibility` is `metadata|manual|none` get an explicit
  `unverifiable` row; a verifiable provider with no authoritative snapshot yet gets `pending`.
  Nothing is ever silently skipped.
- Each canonical pushed-cost bucket is credited to exactly **one owning provider row** (resolved via
  the existing `resolveProviderIdentity` tie-break, with a deterministic fallback). `Provider.name`
  has no unique constraint, so without this two same-key rows — e.g. two OpenAI accounts at $60 and
  $40 against a $100 pushed total — would each claim the full total and both report a discrepancy on
  a perfectly reconciled month. Sibling rows are recorded `unverifiable` with a null delta.
- Calls the month-to-date aggregation **once per pass**, never per provider: that helper is on the
  budget-status hot path implicated in the documented boot-OOM incident.

---

## Constraints honored

- No change to the `max()` budget-spend logic in `budget-status.ts`. Reconciliation is a separate
  audit layer beside the money path, and neither job can fail the maintenance tick.
- No new **required** environment variables; all tolerances have built-in defaults.
- No boot-time work added (the OOM incident came from heavy concurrent aggregation at boot).
- Wave 3 is code-only on the already-migrated Wave 1b schema.

## Verification notes

Hosted CI is the authoritative gate for this work. The shared build machine was running at load
130–240 with many concurrent `tsc`/vitest processes from other sessions for most of this effort, and
per the fleet's serialize-gates rule results at that load are noise rather than evidence — several
apparent "failures" during the build were traced to a stale `better-sqlite3` native module and to
30-second test timeouts under that load, not to the diff.

Both Wave-3 defects fixed in the final commit were found by **independent adversarial review, not by
CI** — they are runtime/data-shape bugs that typecheck and single-pass mocked tests cannot see. Both
now carry regression coverage: a multi-pass test proving an exhausted event is never re-fetched, and
a two-same-key-provider test proving a pushed bucket is credited at most once.

## Follow-ups (not in this work)

- **Wave 3 UI** — the per-provider compliance badge/view (verified-coverage %, discrepancy $,
  explicit `unverifiable` label) is not built yet. When it is, keys must render through
  `buildKeyPreview()` (first 6 + last 4), the only sanctioned key formatter.
- The `usage_reconciliation_discrepancy` alert code exists and fires from period rows; thresholds
  may want tuning once real drift data accumulates.
