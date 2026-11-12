# `GET /api/agent-model-mix` — fleet-wide model mix rollup (2026-09-24)

Item 3 of 4 in the Sentry agent-telemetry plan.  Items 1 (board session linkage) and 2
(UM cost-by-session view) are separate, sibling-session slices and are not touched here.
This item adds one bounded, read-only endpoint for a weekly "fleet-mode compliance
digest" script (built in parallel, in a different repo) to poll.

## What changed

- `src/lib/agent-model-mix.ts` — `loadAgentModelMixRows(windowStart, windowEnd)`, one
  bounded `prisma.$queryRaw` + `Prisma.sql` aggregate over `ExternalUsageEvent`, grouped
  by `sourceApp`, `provider`, `keyRef` (the model identifier field in this schema),
  `json_extract("metadata", '$.seat')`, and `json_extract("metadata", '$.project')`.
  Fleet-wide by design — every `sourceApp`, not filtered to `claude-code`.  Follows the
  `loadAnalyticsTokenRows` idiom in `src/lib/external-usage-events.ts` (fails closed to
  `[]` when the test Prisma client has no `$queryRaw`).
- `buildAgentModelMixReport(rows, windowStart, windowEnd, days, generatedAt)` — the pure
  reducer.  It never calls `new Date()` internally; the caller supplies every timestamp,
  so its unit tests use plain literal `Date` fixtures with no `vi.useFakeTimers()`.
- `src/app/api/agent-model-mix/route.ts` — `GET /api/agent-model-mix?days=7` (default
  trailing 7 days, 1-90 inclusive).  Also accepts an explicit `since`/`until` ISO pair for
  ad hoc ranges (both required together; `until` must be after `since`).  Dual-auth:
  dashboard session cookie OR the dedicated `USAGE_READ_TOKEN` bearer
  (`isUsageReadAuthorized`, with the documented non-production/break-glass ingest-token
  fallback) — the same pattern `GET /api/budget-status` uses, copied field-for-field
  (503 when no read token is configured and there is no session; 401 for a bad
  credential).
- `src/middleware.ts`'s `isPublicPath()` gained a `/api/agent-model-mix` (and trailing-
  slash) exclusion, matching the existing `/api/export/daily-rollups` entry's pattern and
  comment — without it, a bearer-token request 401s at the session gate before the
  route's own auth ever runs.

## Response shape

```json
{
  "windowStart": "2026-09-17T00:00:00.000Z",
  "windowEnd": "2026-09-24T00:00:00.000Z",
  "days": 7,
  "generatedAt": "2026-09-24T01:23:45.000Z",
  "seatDataAvailable": false,
  "costSemantics": "estimated_api_equivalent_not_authoritative",
  "billingMode": "estimated",
  "rows": [
    {
      "sourceApp": "claude-code",
      "provider": "anthropic",
      "model": "claude-sonnet-5",
      "seat": null,
      "project": "usage-monitor",
      "tokens": 1234567,
      "costUsd": 12.34,
      "eventCount": 42
    }
  ],
  "totals": { "tokens": 0, "costUsd": 0, "eventCount": 0 }
}
```

Rows are sorted by `tokens` desc, then `costUsd` desc, then `sourceApp`/`provider`/`model`
ascending as a deterministic tiebreak, so the biggest fleet consumers sort first.
`tokens` sums `quantity` where `metricType = 'usage' AND unit = 'token'`; `costUsd` sums
`costUsd` where `metricType = 'cost'`; `eventCount` is `COUNT(*)` for the group across all
`metricType`s.  Both figures are the same class of analytics-only, API-equivalent
estimate as `llm-burn.ts` and `claude-cost-check.ts` — never authoritative cash.

## Verification performed

- `npx --no-install vitest run src/lib/__tests__/agent-model-mix.test.ts src/app/api/agent-model-mix/__tests__/route.test.ts` — 16 tests, all passing.
- `npm run lint` — clean, no new warnings.
- `npx --no-install tsc --noEmit` — no new errors (the two pre-existing, unrelated
  `waitFor`/Sentry-types errors from a stray `/Users/jay/node_modules` shadowing this
  worktree are unchanged).
- `npm run build` — succeeds.

## Not done here

- Seat attribution is not yet live.  `src/lib/otlp/mapping-utils.ts`'s
  `METADATA_ALLOWLIST` does not include `"seat"` (confirmed 2026-09-24), so every
  aggregated row's `seat` is currently `null` and `seatDataAvailable` is always `false`.
  That is expected, not a bug — extending the allowlist is a separate, already-tracked
  piece of work by a different concurrent worker, out of scope here.
- `project` is read via `json_extract("metadata", '$.project')`, the raw producer-supplied
  name, not the resolved `ExternalUsageEvent.projectId` foreign key.  A row whose project
  name hasn't been resolved to a `Project` row (see `src/lib/project-resolver.ts`) still
  reports its raw metadata project name here; this endpoint does not join `Project`.
- No change to items 1 or 2 of the Sentry agent-telemetry plan (board session linkage,
  UM cost-by-session view) — `src/lib/cost-by-session.ts` did not exist on `origin/main`
  as of this change, so this endpoint follows `src/lib/llm-burn.ts`'s cost-semantics
  phrasing convention instead.
