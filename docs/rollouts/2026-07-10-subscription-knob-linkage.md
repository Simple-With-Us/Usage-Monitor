# 2026-07-10 — subscription -> knob linkage phase 1

PR: https://github.com/Simple-With-Us/api-usage-monitor/pull/83 (`claude/subscription-knob-linkage`,
OPEN, not merged — CLAUDE #agent-sync claim 2026-07-10, sonnet subagent in an isolated worktree).

## Summary
- Added `knobEnv Json?` to both `ProviderPlan` (free-tier baseline) and `Subscription` (per-plan
  override) so the monitor becomes the machine-readable source of truth for which env-var knobs
  (`PROVIDER_QUOTA_*` / `PROVIDER_RATE_LIMIT_*` / other toggles) a consuming app — Socratic.Trade —
  should apply for a given provider's active/considered plan.
- Added a new subscription status, `considering` (alongside `active | paused | canceled`), so a
  candidate paid tier can be modeled and its `knobEnv` compared before it's purchased. It never
  generates charges — `materializeDueSubscriptions` queries `status: "active"` at the DB level, so
  `considering`/`paused`/`canceled` are all excluded identically; added a regression test proving it.
- `GET /api/subscriptions` now accepts EITHER the dashboard session cookie OR a bearer/
  `x-usage-ingest-token` (`USAGE_READ_TOKEN` falling back to `USAGE_INGEST_TOKEN` — mirrors
  `GET /api/budget-status`), via a new `isUsageReadAuthorized` helper in `src/lib/ingest-auth.ts`
  and a narrowly-scoped middleware exclusion. `POST /api/subscriptions` stays session-cookie-only —
  see "Auth deviation" below, this needed an explicit in-route check it didn't have before.
- Every element of the (still bare top-level array) `GET /api/subscriptions` response now also
  carries `knobEnv` (effective: this subscription's own override, else the provider's free-tier
  `ProviderPlan.knobEnv`) and `freeTierKnobEnv` (always the provider's free-tier map, regardless of
  override — lets a consumer diff "what I'd get free" vs "what this plan actually implies").
- Added `scripts/seed-provider-subscriptions.mjs`, a standalone idempotent one-time seed for the
  real provider/subscription/knobEnv data (see "Seed data" below).

## Why
- Owner-directed 2026-07-10 (background agent, isolated worktree off `main`): the monitor should be
  the single source of truth for "what plan am I on and what does it imply", rather than that
  living only in the owner's head / a marketing comparison page. This is phase 1 (data model + read
  API); a Mac-side sync script (monitor -> Infisical) and a UI usage-vs-plan-limit comparison are
  explicitly out of scope here (see live effort board).

## Files
- `prisma/schema.prisma`
- `src/lib/__tests__/setup-test-db.ts`
- `src/lib/subscriptions.ts`
- `src/lib/subscription-input.ts`
- `src/lib/__tests__/subscription-input.test.ts` (new)
- `src/lib/ingest-auth.ts`
- `src/middleware.ts`
- `src/__tests__/middleware.test.ts`
- `src/app/api/subscriptions/route.ts`
- `src/app/api/subscriptions/__tests__/route.test.ts` (new)
- `src/app/api/subscriptions/[id]/route.ts`
- `src/lib/__tests__/subscription-materializer.test.ts`
- `src/components/AddSubscriptionModal.tsx`
- `src/components/SubscriptionsPanel.tsx`
- `scripts/seed-provider-subscriptions.mjs` (new)
- `docs/EFFORT-LOG.md`

## Verification
```
npx prisma generate
npm run lint       # eslint . — clean
npx tsc --noEmit   # clean
npm test           # 20 files / 141 tests passed
npm run build      # next build — clean
```
Additionally, manually verified the schema change is genuinely additive (see "migrate-safe.mjs is
currently broken" below for why this needed hand-verification rather than trusting the deploy-time
script): built an old-shape SQLite DB from the pre-change schema (`git show bc2281d:prisma/schema.prisma`),
then ran a plain `npx prisma db push` against it with the NEW schema — it applied the two new
`knobEnv` columns cleanly with **no** `--accept-data-loss` needed, confirming the change is
non-destructive.

## Auth deviation from the plan (flagged, not a scope change)
The plan says "GET /api/subscriptions then accepts bearer token OR session cookie; POST stays
session-cookie-only" — implemented exactly as specified, but note the mechanism: before this PR,
`POST /api/subscriptions` had **no auth check of its own** — it relied entirely on
`src/middleware.ts`'s session-cookie gate covering the whole `/api/subscriptions` path. Excluding
the collection route from that gate (necessary so `GET` can self-authenticate) means POST would
have gone **completely unauthenticated** without an explicit in-route check. Added one
(`hasSessionCookie(request)` at the top of `POST`, returning 401 otherwise) — this is required, not
optional, for the plan's own "POST stays session-cookie-only" requirement to actually hold. Covered
by a regression test (`route.test.ts`: a valid read token but no session cookie still 401s POST).

The middleware exclusion itself is deliberately narrower than the existing `api/budget-status`
exclusion: `api/subscriptions/?$` (anchored to end-of-string) matches only the exact collection path
(`/api/subscriptions` or `/api/subscriptions/`), NOT `(?:/|$)` — which would also swallow
`/api/subscriptions/<id>` sub-paths. The `[id]` PUT/DELETE routes are untouched and remain fully
session-gated by the middleware, exactly as before. Regression-tested in `middleware.test.ts`.

## IMPORTANT — pre-existing, unrelated, deploy-blocking bug discovered: `scripts/migrate-safe.mjs`
While manually verifying this PR's schema change would actually apply safely in prod, discovered
that **`scripts/migrate-safe.mjs`'s core safety mechanism is currently broken**, independent of
this PR: it shells out to `prisma db push --dry-run`, but `--dry-run` is **not a valid flag** for
`prisma db push` in the pinned Prisma version (`6.19.3` — confirmed via `npx prisma db push --help`,
no dry-run option exists; also confirmed exact pin in `package-lock.json`). Reproduced locally:
against ANY existing SQLite DB (not just one needing this PR's change), `migrate-safe.mjs` prints
`ERROR: prisma db push --dry-run failed: ... unknown or unexpected option: --dry-run` and
**exits 1** — before it ever gets to check whether there are even any pending changes.

`scripts/start-with-litestream.sh` runs `node scripts/migrate-safe.mjs` unconditionally at
**every** container start once the persistent disk already has a DB file (i.e. every deploy after
the very first one) — so on the very next deploy where Render's disk already has `/data/prod.db`,
the start command will fail before `npm start` ever runs. `render.yaml` has no `autoDeploy: false`
override, so this is a real, live risk for the *next* push to `main` that triggers a Render
autodeploy, whether or not it touches `prisma/schema.prisma` — the crash is unconditional on
`dbExists`, not on there being an actual diff.

Only the `dbExists === false` (fresh disk, first-ever deploy) branch is unaffected, since it skips
the dry-run step entirely.

**Not fixed here** — out of this PR's approved scope (a genuinely separate, orthogonal bug), and it
deserves its own focused fix + test rather than a rushed patch riding along on this diff. Flagged to
the owner/fleet via a spawned follow-up task. Two independently-confirmed-safe mitigations, either
works:
1. Fix `migrate-safe.mjs` to stop using the non-existent `--dry-run` flag — a plain `npx prisma db
   push` (no flags) already fails safely on a destructive change (requires `--accept-data-loss` to
   proceed) and succeeds directly on an additive one (verified above), so the dry-run pre-check may
   not even be necessary anymore — or replace it with `prisma migrate diff` against the live DB.
2. Before the next deploy, manually run `npx prisma db push` from Render's Shell tab to apply
   whatever schema changes are pending (confirmed safe for this PR's changes above), so the
   startCommand's `migrate-safe.mjs` call finds nothing to do... except it will **still crash**
   regardless, since the crash is unconditional on `dbExists`, not on there being a diff. So (2)
   alone does NOT unblock a deploy — (1) is required before this (or any) schema change can ship via
   the normal autodeploy path.

## Seed data (`scripts/seed-provider-subscriptions.mjs`)
Standalone, idempotent (provider lookup is case-insensitive find-or-create; subscription lookup is
by `(providerId, name)` — skips if already present; `ProviderPlan.knobEnv` is written only if
currently `null`). Not run yet against prod — run **exactly once**, after this PR is merged AND
deployed (see the migrate-safe.mjs blocker above — the schema change must actually be live first):

```
# from Render's Shell tab for the deployed api-usage-monitor web service
node scripts/seed-provider-subscriptions.mjs
```

Seeds:
- `massive` "Stocks Starter" — active, $29/mo (annual $288/yr noted), `knobEnv`
  `{"MASSIVE_REST_MAX_CALLS_PER_MINUTE":"100"}`
- `fmp` "Starter" — active, $22/mo (billed annually $264/yr noted), `knobEnv {}`
- `tiingo` "Power" — **considering**, $30/mo (annual $300/yr, 2 months free, owner-verified
  2026-07-10 — the marketing comparison matrix hides this), `knobEnv`
  `{"PROVIDER_QUOTA_TIINGO_PER_HOUR":"10000","PROVIDER_QUOTA_TIINGO_PER_DAY":"100000","TIINGO_DROP_NEWS":"false"}`
- `fmp` "Premium" — **considering**, $59/mo (billed annually $708/yr; quarterly fundamentals + 750
  calls/min), `knobEnv {}`
- `ProviderPlan.knobEnv` free-tier baselines (only-if-unset): `tiingo`
  `{"PROVIDER_QUOTA_TIINGO_PER_HOUR":"50","PROVIDER_QUOTA_TIINGO_PER_DAY":"1000","TIINGO_DROP_NEWS":"true"}`;
  `twelvedata` `{"PROVIDER_QUOTA_TWELVEDATA_PER_MIN":"8","PROVIDER_QUOTA_TWELVEDATA_PER_DAY":"800"}`;
  `alphavantage`
  `{"PROVIDER_RATE_LIMIT_ALPHA_VANTAGE_MIN_INTERVAL_MS":"1100","PROVIDER_RATE_LIMIT_ALPHA_VANTAGE_CONCURRENCY":"1"}`;
  `finnhub` `{"PROVIDER_RATE_LIMIT_FINNHUB_PER_MIN":"50"}`

**Alpha Vantage naming, flagged prominently per the plan**: the provider is seeded/matched as
`alphavantage` (no hyphen) — this MUST match exactly, because `src/lib/adapters/index.ts`'s adapter
registry dispatches on `provider.name.toLowerCase()` and only registers the key `"alphavantage"`. A
Provider row named e.g. `"alpha-vantage"` would silently fall through to the generic `"custom"`
adapter (no real usage polling), not a crash — so a naming mismatch is not merely cosmetic, it
silently disables usage tracking for that provider. The seed script warns (does not auto-fix) if it
finds a hyphen/underscore near-miss variant already in the database.

## Accepted phase-1 gap
Providers with no `Subscription` row (i.e. every provider besides the four seeded above) never
appear in `GET /api/subscriptions` — their free-tier `knobEnv` values are already the Infisical
baseline configured directly in Socratic.Trade, so this doesn't regress anything; it's simply not
yet surfaced through this endpoint. A future phase could add a `GET /api/providers`-adjacent view
that lists every provider's effective knobEnv regardless of whether a Subscription row exists.

## Follow-ups
- **Urgent, separate**: fix `scripts/migrate-safe.mjs`'s broken `--dry-run` flag (see above) —
  blocks the next schema-touching (or, per the unconditional-crash finding, possibly ANY) Render
  autodeploy of this app. Flagged as a spawned background task.
- Phase 2 (unclaimed, per the live effort board): UI usage-vs-plan-limit comparison ("would the
  considered plan clear your 429s").
- Follow-up (separate row, Socratic.Trade side, unclaimed): Mac launchd sync script that reads this
  endpoint and writes the effective `knobEnv` into Infisical.
- Run `scripts/seed-provider-subscriptions.mjs` against prod once this PR is merged and deployed
  (blocked on the migrate-safe.mjs fix above).

## 2026-07-10 update — two P2 code-review findings addressed (PR #83)

Two P2 findings from the PR's review bots, both fixed in-branch (not merged/deployed yet — PR
still open).

### Finding 1 — reset candidate billing cycle on activation (comment 3562134614)
`PUT /api/subscriptions/:id` (`src/app/api/subscriptions/[id]/route.ts`) previously only
recomputed the billing cycle when the schedule fields (interval/intervalCount/anchorDay/startDate)
actually changed by value. A pure status flip — `considering` (or `paused`/`canceled`) -> `active`
— left `currentPeriodStart` untouched. Since `materializeDueSubscriptions`
(`src/lib/subscription-materializer.ts`) walks forward from `currentPeriodStart`, charging every
elapsed period up to `now`, activating a `considering` row created months earlier would backfill a
charge for every period since the row was **created** — including time before the plan was
actually purchased.

Fix: added an `isActivating` branch (`update.status === "active" && existing.status !== "active"`)
that runs *before* the existing schedule-changed branch. It re-anchors the cycle via
`initialCycle({ startDate: activationStartDate, interval, intervalCount, anchorDay })` — the same
pure period-math helper `POST /api/subscriptions` already uses for brand-new subscriptions — where
`activationStartDate` is `update.startDate` if the caller supplied one (an explicit purchase date),
else `new Date()` (the activation moment). Sets `currentPeriodStart`/`nextRenewalAt` from that
cycle and clears `lastChargedPeriodStart` to `null`, so the next materializer run charges only the
current (post-activation) period. Deliberately discards any prior `lastChargedPeriodStart`
watermark — activation is a fresh cycle, not a continuation of already-billed or never-billed
history. A row already `active` is untouched (`isActivating` is `false`), matching "do not change
behavior for a row that was already active."

Regression tests added to `src/lib/__tests__/subscription-materializer.test.ts`:
- a `considering` row created in January, activated in July via an explicit `startDate` in the PUT
  body, materializes exactly ONE charge (the current period) — not the six that elapsed since
  January.
- same re-anchor behavior for a `paused` row (not just `considering`).
- an already-`active` row that receives a PUT re-affirming `status: "active"` keeps its existing
  `currentPeriodStart`/`lastChargedPeriodStart` unchanged (no regression for the already-active
  case).

### Finding 2 — fall back to free-tier knobs for inactive rows (comment 3562134616)
`GET /api/subscriptions` (`src/app/api/subscriptions/route.ts`) computed the effective `knobEnv` as
`sub.knobEnv ?? freeTierKnobEnv` unconditionally — so a `paused`/`canceled` row's stale paid
override was still reported as the effective value, even though the contract (see `AGENTS.md`
"Subscriptions") is that a subscription's `knobEnv` overrides the provider baseline only while
`active`/`considering`.

Fix: gated the override on status — `knobOverrideApplies = sub.status === "active" || sub.status
=== "considering"`; when false, `knobEnv` falls back to `freeTierKnobEnv` unconditionally.
`freeTierKnobEnv` itself is untouched (always the provider baseline, regardless of status).

Regression tests added to `src/app/api/subscriptions/__tests__/route.test.ts`:
- a `canceled` subscription with its own paid `knobEnv` returns the provider's free-tier map as the
  effective `knobEnv`, not the stale paid override (`freeTierKnobEnv` unaffected).
- `active` and `considering` rows still apply their own `knobEnv` override (unaffected by the fix).

### Files (this update)
- `src/app/api/subscriptions/[id]/route.ts`
- `src/app/api/subscriptions/route.ts`
- `src/lib/__tests__/subscription-materializer.test.ts`
- `src/app/api/subscriptions/__tests__/route.test.ts`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-07-10-subscription-knob-linkage.md` (this file)

### Verification
```
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"   # node26 default ABI-breaks better-sqlite3
npx prisma generate
npm run lint       # eslint . — clean
npx tsc --noEmit   # clean
npm test           # 20 files / 146 tests passed (141 -> 146, +5 new regression tests)
npm run build      # next build — clean
```

Not addressed here (unchanged, still open): the `scripts/migrate-safe.mjs` `--dry-run` bug flagged
above — explicitly out of scope for this review-comment pass too, per the task instructions.
