# `GET /api/agent-model-mix` — NULL-first BigInt variant + follow-up hardening (2026-09-25)

Follow-up to [`2026-09-25-agent-model-mix-bigint-fix.md`](./2026-09-25-agent-model-mix-bigint-fix.md)
(PR #1546, merged as `0e29da0d`).  That PR fixed the production `RangeError` crash but was
merged by the owner directly before its own adversarial review finished; the review found
a second variant of the same bug class plus three smaller issues.  This PR fixes all of
them, since #1546 was already merged and could not be amended.

## What was wrong

1. **NULL-first variant of the same BigInt crash (P2).**  #1546's fix,
   `COALESCE(CAST(SUM(...) AS REAL), 0)`, still crashed when the FIRST `GROUP BY` bucket's
   matching rows all had a NULL `costUsd`/`quantity`: `SUM()` over all-NULL input is SQL
   NULL, so `COALESCE` fell back to the untyped literal `0`, and Prisma's `$queryRaw` type
   inference re-locked the column to `BigInt` from that `0` exactly as before.  Reproduced
   against real SQLite with a NULL-only first group followed by a fractional-valued later
   group — same `RangeError`, different trigger shape.  Production is not hitting this
   today (the first `sourceApp` alphabetically, `agent-bar`, always reports both fields),
   but any future producer whose `sourceApp` sorts earlier and omits `costUsd`/`quantity`
   would reintroduce the crash.
2. **The sibling aggregate in `cost-by-session.ts` had the identical bug (P2).**  Its
   `COALESCE(SUM(x), 0)` shape has the same NULL-first failure mode, and unlike
   `loadAgentModelMixRows` it has no `try`/`catch` at all, so a multi-session
   `GET /api/cost-by-session` request with an earlier usage-only session would 500.
   Reproduced against real SQLite.
3. **The fail-closed catch logged nothing (P2).**  A future query failure would still
   silently degrade to "no usage this window" with zero trace of why — the same failure
   mode that made the original crash invisible for a full day.
4. **A false precedent claim in `route.ts`'s comment (P3).**  It said the route's lack of
   its own `try`/`catch` matched "the same contract `GET /api/cost-by-session` relies on",
   but `loadCostBySessionRows` has no `try`/`catch` and no fail-closed contract at all —
   the accurate precedent is `loadAnalyticsTokenRows` in `external-usage-events.ts`.
5. **Sentence-gap / stale-status prose (P3).**  `docs/EFFORT-LOG.md`'s row for #1546 still
   said "PR opened, not merged" after the owner had already merged it, and several of the
   PR's own new comment blocks / docs used a single space after mid-paragraph sentence
   breaks instead of the repo's two-space convention.

## The fix

- `src/lib/agent-model-mix.ts` — switched both aggregates from
  `COALESCE(CAST(SUM(...) AS REAL), 0)` to plain `TOTAL(...)`, SQLite's aggregate that
  always returns a REAL and never NULL (a `TOTAL()` over all-NULL/zero input is the float
  `0.0`), so there is no `COALESCE` fallback left for Prisma's type inference to latch
  onto.  The `catch` now logs `console.warn("[agent-model-mix] aggregate query failed;
  returning empty", err)` before returning `[]`.  Module docblock updated with both
  incident notes.
- `src/lib/cost-by-session.ts` — same `TOTAL(...)` fix applied to `loadCostBySessionRows`'s
  `quantity`/`costUsd` aggregates.  (This function still has no `try`/`catch` — that is
  unchanged scope; a genuine query failure there still surfaces as a 500, which is a
  reasonable contract for a synchronous read endpoint and was not itself flagged as a
  problem, only the crash-on-fractional-value bug was.)
- `src/app/api/agent-model-mix/route.ts` — corrected the misleading comment to cite
  `loadAnalyticsTokenRows` as the actual fail-closed precedent instead of the nonexistent
  `cost-by-session` one.
- `src/lib/__tests__/agent-model-mix.db.test.ts` — two new NULL-first regression cases
  (one for `tokens`, one for `costUsd`) plus a new case asserting the query-failure path
  returns `[]` and logs exactly one warning.  All three were confirmed to fail with the
  exact reported `RangeError` against the pre-fix code before being confirmed green after.
- `src/lib/__tests__/cost-by-session.db.test.ts` — one new NULL-first regression case
  (a usage-only session sorting before a fractional-cost session), confirmed to fail with
  the same `RangeError` against the pre-fix code.
- `docs/EFFORT-LOG.md` — corrected the #1546 row's stale "not merged" status.
- Two-space sentence-gap cleanup in the touched files' new/edited prose (module docblocks,
  this doc, and the prior rollout doc).

## Verification performed

- `vitest run src/lib/__tests__/agent-model-mix.test.ts src/lib/__tests__/agent-model-mix.db.test.ts src/app/api/agent-model-mix/__tests__/route.test.ts src/lib/__tests__/cost-by-session.db.test.ts src/lib/__tests__/cost-by-session.test.ts` — 49 tests, all passing (was 20 in the agent-model-mix trio; +7 new across the two `.db.test.ts` files, plus the pre-existing `cost-by-session.test.ts` suite run for regression).
- Confirmed all four new regression tests fail with the exact reported
  `RangeError: The number <N> cannot be converted to a BigInt because it is not an
  integer` against the pre-fix (`COALESCE(...SUM...)`) code, and pass cleanly against the
  `TOTAL(...)` fix — proving both that the bug is real and that the fix closes it.
- `eslint` on all changed files — clean.
- `tsc --noEmit` — no new errors (the same two pre-existing, unrelated errors #1546 already
  documented: a `waitFor` import in `useDashboardData.rangeFetch.test.ts`, and Sentry types
  shadowed by a stray `~/node_modules` — both untouched by this change).
- Live production probe (`GET /api/agent-model-mix?days=7` with `USAGE_READ_TOKEN`) against
  the currently deployed `#1546` fix returned `200` with real, mixed integer/fractional
  `costUsd` data — confirming the NULL-first variant is not (yet) triggering in production,
  consistent with the root-cause analysis above.

## Not done here

- Same scope boundary as #1546: no change to the weekly fleet-mode compliance digest
  script itself, and no live seat-attribution data (`METADATA_ALLOWLIST` still excludes
  `"seat"`).
- Did not add a `degraded`/`queryFailed` flag to the API response shape.  The reviewer
  offered that as a stronger alternative to logging; it would change
  `AgentModelMixReport`'s public shape and the digest script's consumption of it, which is
  a larger, separately-scoped change.  The `console.warn` addition is the reviewer's stated
  minimum bar and directly closes the "silent failure looks like no usage" gap that made
  the original incident hard to diagnose.
