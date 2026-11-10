# `GET /api/agent-model-mix` — production BigInt crash fix (2026-09-25)

Follow-up to [`2026-09-24-agent-model-mix.md`](./2026-09-24-agent-model-mix.md) (PR #1539).
That endpoint shipped with a real bug that made it 500 (masked as an empty result) on
every production call; PR #1541 landed a temporary diagnostic to find the cause.  This PR
fixes the root cause and removes the diagnostic.

**Status: merged and deployed** (PR #1546, merge commit `0e29da0d`, live-verified
`GET /api/agent-model-mix?days=7` returning `200` with real fleet data).  A second,
narrower bug in the same aggregate class survived this PR's own adversarial review and is
fixed in the follow-up: [`2026-09-25-agent-model-mix-null-first-fix.md`](./2026-09-25-agent-model-mix-null-first-fix.md).

## What was wrong

Production returned an empty `rows: []` on every call despite confirmed real
`ExternalUsageEvent` data (`pushedUnpricedEventCount: 3718` for the `anthropic` provider
that month, per `/api/budget-status`).  `loadAgentModelMixRows`'s `catch` swallowed the
real error to `[]`, so the empty result looked like "no fleet usage this window" instead
of a query failure.

PR #1541 temporarily rethrew instead of swallowing, so the route's own catch could surface
the raw error.  Hitting the live endpoint with `USAGE_READ_TOKEN` returned:

```
RangeError: The number 0.3498095 cannot be converted to a BigInt because it is not an integer
```

## Root cause

`loadAgentModelMixRows`'s aggregate summed `tokens`/`costUsd` with
`SUM(CASE WHEN ... THEN <column> ELSE 0 END)`, with no explicit cast.  SQLite has no fixed
column types (per-value storage classes only); Prisma's `$queryRaw` type inference for
SQLite samples the FIRST returned row's runtime storage class per column to decide how to
deserialize every row in that column.  When the first `GROUP BY` bucket's sum happened to
land on an exact integer (e.g. a group with no matching `'cost'` events sums its `costUsd`
CASE to literal `0`), Prisma inferred `Int64`/`BigInt` for that whole column — then threw
converting a LATER group's genuinely fractional dollar amount (`0.3498095`) to BigInt.

Reproduced locally against a real SQLite database (not a mock) before the fix, confirmed
gone after.  See `src/lib/__tests__/agent-model-mix.db.test.ts`'s first test and its
docblock for the exact repro shape, and `agent-model-mix.ts`'s module docblock for the
same note in the source.  This is the same class of gap
`cost-by-session.db.test.ts` (PR #1534) exists to close — a mocked-Prisma unit test
cannot catch a bug in how the real driver infers a *computed* column's type, because the
mock never touches real SQLite runtime typing.

## The fix

- `src/lib/agent-model-mix.ts` — wrapped both `SUM(CASE ...)` aggregates in
  `CAST(... AS REAL)`, so the column is always reported as floating point regardless of
  which group SQLite happens to return first.  Restored the `catch { return []; }`
  fail-closed contract (matching `loadAnalyticsTokenRows`'s convention) now that the
  underlying error is fixed, removing PR #1541's temporary rethrow.
- `src/app/api/agent-model-mix/route.ts` — removed the temporary diagnostic catch that
  returned the raw error message and stack trace in the response body (a real
  information-disclosure issue if it had stayed — every 500 leaked file paths and
  internal error text to any caller with a read token).  The route no longer needs its own
  try/catch: `loadAgentModelMixRows` fails closed internally, the same fail-closed
  convention `loadAnalyticsTokenRows` uses in `external-usage-events.ts` (**not** the same
  contract as `GET /api/cost-by-session` — see the follow-up doc for why that comparison
  was wrong and has since been corrected in the route's own comment).
- `src/lib/__tests__/agent-model-mix.db.test.ts` — new.  Exercises
  `loadAgentModelMixRows` against a real throwaway SQLite database (never the dev
  `data`/`dev.db`), reproducing the exact production shape (an exact-zero-cost group
  before a fractional-cost group) plus general grouping/window-filtering coverage.

## Verification performed

- `vitest run src/lib/__tests__/agent-model-mix.test.ts src/lib/__tests__/agent-model-mix.db.test.ts src/app/api/agent-model-mix/__tests__/route.test.ts` — 20 tests, all passing (was 16; +4 new `.db.test.ts` cases).
- `eslint` on the changed files — clean.
- `tsc --noEmit` — no new errors.
- Reproduced the exact production `RangeError` locally against a real SQLite db before the
  fix; confirmed it no longer occurs after the `CAST(... AS REAL)` change, using the same
  seed shape now codified in `agent-model-mix.db.test.ts`.
- Live production probe (`GET /api/agent-model-mix?days=7` with `USAGE_READ_TOKEN`)
  confirmed the `500 debug_query_failed` response and captured the real error before this
  fix was written.
- Post-merge: `/api/ready` confirmed deployed revision `0e29da0d`; a fresh live probe of
  `GET /api/agent-model-mix?days=7` returned `200` with correctly mixed integer-zero and
  fractional `costUsd` values in the same result set — exactly the shape that used to crash.

## Not done here

- Seat attribution is still not live (`METADATA_ALLOWLIST` doesn't include `"seat"` yet) —
  unchanged from the original PR, tracked separately.
- No change to the weekly fleet-mode compliance digest script itself
  (`ai-fleet-coordinator/scripts/weekly-fleet-mode-digest.mjs`) — this PR only fixes the
  UM endpoint it polls.  The digest's own `--dry-run` against live UM is still outstanding
  (needs `SENTRY_AUTH_TOKEN_FULLSCOPE`, outside this repo's scope).
- A second bug in the same aggregate class (a NULL-first group, rather than an
  exact-integer-zero-first group) survived this PR's own tests and was only caught in
  adversarial review — see the follow-up doc linked at the top of this file.
