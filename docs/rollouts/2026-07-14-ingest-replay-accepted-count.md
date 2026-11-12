# Generic ingest replay accepted-count correction

## Summary

Corrected the generic usage-ingest response so `accepted` reports only rows
newly inserted by the current request. A byte-identical idempotent replay still
returns HTTP 202, but now reports `accepted: 0` instead of implying that another
row was written.

## Why

The production recovery smoke sent one zero-cost event and one identical replay.
Readback proved that SQLite stored exactly one row, while both responses reported
`accepted: 1`. The persister returned `activeEvents.length`, which includes
already-existing compatible rows; its adjacent `newEvents` collection already
represented the intended newly inserted count.

The result contract is now explicit:

- `attempted`: submitted inputs.
- `persisted`: rows newly inserted by this call.
- `skippedPrunedDuplicates`: inputs blocked by retention tombstones.
- Active idempotent replays: valid requests that add zero persisted rows.

## Files

- `src/lib/external-usage-events.ts`
- `src/lib/__tests__/retention-integration.test.ts`
- `src/app/api/ingest/usage/__tests__/route.test.ts`
- `AGENTS.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-07-14-ingest-replay-accepted-count.md`
- `/Users/jay/apps/API-USAGE-MONITOR-EFFORT-LOG.md` (branch-neutral live board)

## Verification

All Node commands use Node `24.18.0` through the repository-required Node 24
PATH.

```bash
npx vitest run src/lib/__tests__/retention-integration.test.ts src/app/api/ingest/usage/__tests__/route.test.ts
# passed: 2 files / 10 tests

npx eslint src/lib/external-usage-events.ts src/lib/__tests__/retention-integration.test.ts src/app/api/ingest/usage/__tests__/route.test.ts
# passed

npm run typecheck
# passed

git diff --check
# passed
```

The complete gate also passed:

```bash
npm run verify
# ESLint passed
# TypeScript passed
# Vitest passed: 76 files / 462 tests
# safe-migration reproduction passed
# SQLite backup checks passed
# startup configuration checks passed
# Next.js production build passed
```

Hosted PR gates and exact-revision production confirmation remain pending.

An independent read-only reviewer returned no P0-P2 findings and confirmed the
persister semantics, database coverage, and route compatibility. Its
non-blocking suggestion was applied: route mocks now include `attempted`, the
replay regression asserts the complete response body, and it proves the shared
ingest admission token is released. The two focused tests, scoped ESLint,
TypeScript, and `git diff --check` all re-passed on that exact tree.

## Follow-ups

- Open a ready PR, require all hosted gates, merge, and verify the exact revision
  live through read-only health evidence.
- Do not send another production smoke solely for this correction; the two
  already-recorded zero-cost recovery events are sufficient persistence evidence.
