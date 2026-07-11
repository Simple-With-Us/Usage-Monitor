# API-usage-monitor Effort Log — cross-agent board
Protocol: /Users/jay/apps/EFFORT-LOG-PROTOCOL.md (canonical). Live board:
`/Users/jay/apps/API-USAGE-MONITOR-EFFORT-LOG.md` (mirror: this file). As of 2026-07-04.

## Deployed
- **Production (Render, autodeploy from `main`) — state as of 2026-07-05 (CLAUDE next-wave):**
  verified live at >= PR #13 (`412ab00`, OTLP ingest) — a live authed `POST /api/otlp/v1/metrics`
  round-trip against prod returned 202, unauthed returned 401. Presumed current head is `409e674`
  (latest merged `main` commit as of this cycle; PR #33 retention/alerts and PR #38/#40 effort-sync
  hardening should also be live via Render's autodeploy-on-push, but this has not been independently
  confirmed commit-by-commit). Exact-SHA verification is blocked on `/api/health` not yet returning
  a commit stamp — see the new "Stamp /api/health with the deployed commit SHA" row below, which
  exists specifically to make this section verifiable going forward instead of inferred.

## Completed
- **Fix deploy-blocking `migrate-safe.mjs` `--dry-run` crash (CLAUDE, S) — 2026-07-10.**
  `scripts/migrate-safe.mjs`'s `npx prisma db push --dry-run` pre-check used a flag that doesn't
  exist on the pinned Prisma version (`6.19.3`), crashing unconditionally on every deploy once the
  Render disk already had a DB file — before it ever checked for an actual schema diff. Found
  while verifying PR #83's schema change; flagged there as a separate pre-existing bug and fixed
  here. Dropped the broken dry-run pre-check/parsing entirely in favor of trusting a plain
  `npx prisma db push` directly — verified locally that Prisma's own row-count-based data-loss
  guard already applies additive changes cleanly and refuses genuinely destructive ones (real rows
  at risk) without `--accept-data-loss`, more precisely than the removed schema-shape heuristic
  did. Added `scripts/test-migrate-safe-repro.mjs` (manual repro/integration test covering
  additive, no-op, and destructive-with-real-data scenarios against the real script). Full detail:
  `docs/rollouts/2026-07-10-migrate-safe-dry-run-fix.md`. Verified: repro script all-PASS,
  `npm run lint` clean, `npm run build` clean, `npm test` unaffected (pre-existing sandbox-only
  `sqlite3`-binary test failures confirmed unrelated via `git stash`). Independent of PR #83 — does
  not block or depend on it.
- **Litestream backup for the Render SQLite disk (CLAUDE, was AG) — MERGED as PR #59 (`a6ce13b`),
  2026-07-06.** Opt-in continuous replication of `/data/prod.db` to Cloudflare R2 (build fetches a
  pinned, sha256-verified litestream v0.5.13; `start-with-litestream.sh` restores-if-empty then
  `-exec`-supervises `npm start`; top-level 0.5.x `snapshot:` retention; deploy-safe fetch that
  can't block a build on a GitHub outage). Dormant until the owner sets `LITESTREAM_S3_*` in Render
  → zero runtime change otherwise. Frontier-adversarially reviewed (caught+fixed a MAJOR 0.5.x
  retention-schema bug, verified vs the real binary); all bot review threads resolved; CI green.
- **Per-adapter resilience review (CLAUDE, was AG) — MERGED as PR #60 (`42d3559`), 2026-07-06.**
  `fetchJson` per-request timeout + bounded 429/5xx Retry-After backoff (15s cap) + query-string
  redaction + per-provider `Promise.race` budget in `fetchAllDueProviders`; body-cancel-on-retry +
  cleared timeout timer (bot findings). +13 tests; CI green; all review threads resolved.
- **Verify Claude Code OTLP metrics land end-to-end (CLAUDE) — DONE 2026-07-06.** Post-#58,
  `GET /api/budget-status` shows `anthropic` `pushedMonthToDateUsd`/`spentUsd` populated
  (~$1454 MTD) with null snapshot cost → real pushed OTLP data is persisting in prod. Closes the
  PR #13 chain's last unverified link (issue #51 / #32 follow-through).
- **Monitor the agent-sync relay endpoint (AG) — DONE via PR #63 (`c7aaed7`), 2026-07-06.**
  `src/lib/adapters/agent-sync-relay.ts` dynamic health-check adapter + lazy-seeded builtin
  provider polling `agent-sync.jays.services/health` every 15 min (issue #55).
- **Ingest-auth refactor + ESLint setup (the "Cursor quality sweep") (MONET) — MERGED as PR #42
  (squash `8452a0b`) 2026-07-05.** Wired the
  `budget-status` and `ingest/usage` routes onto the shared `@/lib/ingest-auth` helpers
  (`tokenFromRequest`/`safeEqual`/`isUsageIngestAuthorized`), removing duplicated token-auth code.
  Adds flat-config ESLint (`eslint.config.mjs`) + deps + a CI lint step + a CI `npm test` step, a
  rate-limit in-process-only caveat note, `.cursor/` gitignore, and a README. Carried from an
  uncommitted Cursor working set, rebased clean onto `main`. Landed after an independent adversarial
  LAND review (no auth regression byte-for-byte; fresh eslint/tsc/56-tests/build green).
  Discharges Cursor-sweep issues #22 (CI tests), #23 (ESLint), #24 (auth consolidation + env-example),
  #25 (README). **#26 (close parked `claude/budget-status` + prune branches) is NOT done — the parked
  branch still exists on origin — leave it open.** #22-#25 are orphaned-open (their per-item keyed rows
  were consolidated into this summary, so the issues-sync can't match/close them) → CLAUDE's issue-
  reconciliation lane for a manual close (grouped with #34/#35).
- **Fix /api/budget-status 401: exclude it from the dashboard-session middleware matcher (MONET, S)**
  — DONE via PR #58 (squash `dfdb39e`), merged to `main` 2026-07-05. Added `api/budget-status(?:/|$)`
  to the `src/middleware.ts` matcher exclusion (the route self-authenticates on GET with
  `USAGE_READ_TOKEN`||`USAGE_INGEST_TOKEN` + `timingSafeEqual`, so the session gate was 401'ing every
  bearer request before the route's own check), plus a matcher regression test
  (`src/__tests__/middleware.test.ts`) and a `render.yaml` note that prod reuses `USAGE_INGEST_TOKEN`
  for read unless a distinct `USAGE_READ_TOKEN` is provisioned. Security-reviewed SAFE (route
  self-auths GET-only, no nested routes, prefix collisions stay gated). **DEPLOYED + VERIFIED against
  prod: `POST /api/budget-status` unauth `401`→`405` (session gate gone, route reached) and `GET`
  authed → `200` with a real budget payload — the token-gated endpoint that had never worked
  externally now works.** Standalone single-purpose PR, independent of AG's #56.
- **Effort-issues sync secondary-rate-limit hardening (CLAUDE) — PR #38, 2026-07-05.** Verbatim propagation of the fleet-standard `scripts/sync-effort-issues.py` hardening from Socratic.Trade: 2.5s creation throttle, Retry-After/exponential-backoff retries under a bounded 300s per-run budget, and exit-0 "PARTIAL SYNC — resume on next run" summary on budget exhaustion (bulk issue creation previously 403'd on GitHub's secondary rate limit and hard-failed the sync workflow; the sync is idempotent, so a partial pass resumes cleanly on the next run). Lands with this PR.
  Review refinements re-propagated via PR #40 (merged 2026-07-05): issue listing inside
  partial handling, server-sent Retry-After honored uncapped, 1s update throttle.
- **Owner action: activate Claude Code OTLP telemetry env vars (OWNER, S) — completed 2026-07-05
  (CLAUDE next-wave correction, moved from Planned).** All five `OTEL_*`/
  `CLAUDE_CODE_ENABLE_TELEMETRY` vars are set in `~/.claude/settings.json`; embedded bearer token
  verified live against prod ingest (empty OTLP POST -> 202 authed, 401 unauthed). Issue #32
  closes with this. Data-flow confirmation (real `ExternalUsageEvent` rows / `anthropic` provider
  actually populated) is tracked separately as a new Planned row below — auth-accepted is not the
  same claim as data-landed.
- PR #8 (claude/agent-sync-stanza, CLAUDE) — AGENTS.md inter-agent coordination stanza; MERGED 2026-07-04.
- **PR #13 (claude/otlp-claude-code-ingest, CLAUDE) — Claude Code OTLP metrics ingest + read-only
  Sentry health card; MERGED 2026-07-04 (merge commit `412ab00`).** `POST /api/otlp/v1/metrics`
  (OTLP-HTTP JSON + protobuf via `protobufjs` against the vendored official `opentelemetry-proto`
  schema) maps Claude Code's native token/cost/session/lines-of-code/commit/PR/active-time/
  code-edit-tool-decision metrics into `ExternalUsageEvent` (provider="anthropic",
  service="claude-code") so existing budgets/alerts/dashboards apply unchanged; idempotent on OTLP
  batch retries; unknown/future metric names accepted+tallied+logged-once, never mapped or 500'd;
  first successful ingest lazily seeds an `anthropic` Provider row with no budget if one doesn't
  already exist. `POST /api/otlp/v1/logs` is an accept-and-drop stub. `GET /api/sentry-health` +
  dashboard card give a read-only per-project unresolved-issue count (env-gated on
  `SENTRY_READ_TOKEN`/`SENTRY_ORG`, absent by default, token never sent to client). Found and fixed
  a real pre-existing gap while building this: `src/middleware.ts`'s dashboard-session gate did not
  exclude `/api/otlp/*`, so even a correctly-authenticated OTLP POST would have been 401'd before
  reaching the route's own bearer-token check — verified with a live before/after `next start`
  repro, fixed with the same exclusion `/api/ingest` already has. 46/46 vitest passing, tsc/build
  clean. **Owner activation still needed: the coordinator must set
  `CLAUDE_CODE_ENABLE_TELEMETRY=1` / `OTEL_METRICS_EXPORTER=otlp` /
  `OTEL_EXPORTER_OTLP_PROTOCOL=http/json` / `OTEL_EXPORTER_OTLP_ENDPOINT=https://usage.jays.services/api/otlp`
  / `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <USAGE_INGEST_TOKEN>` in
  `~/.claude/settings.json` (not done by the agent, per instructions) before any real data flows.**
- Branch claude/budget-status — parked local branch found at bootstrap (owner/state unknown; whoever owns it: claim or close).
- Codex global coordination + fleet monitoring setup (Codex, shared `/Users/jay/apps`
  infra) — include this app in the standardized Codex bootstrap/audit path; no
  app-runtime changes in this repo.
- **PR #33 (codex-data-retention-alert-delivery, CODEX) — data retention/pruning for
  `UsageSnapshot`/`ExternalUsageEvent` + alert delivery channels; MERGED 2026-07-04 (merge
  commit `421a05c`).** Adds SQLite/Prisma daily rollups, tombstones for pruned external
  idempotency keys, current-month budget protection, rollup-aware history endpoints, provider
  alert notification state, Slack/webhook delivery channels, reminder dedupe, resolution
  tracking, env/docs, and retention/alert integration coverage. Verified locally before merge:
  `npx prisma generate`, `npm test` (8 files / 52 tests), `npm run lint`, and `npm run build`.
- **Cursor quality sweep (CURSOR, branch `cursor`) — 5 items, all verified locally 2026-07-05.** (1) CI now runs `npm test` (52 vitest tests). (2) ESLint with `eslint-config-next/core-web-vitals` — `eslint .` passes clean, separate from `tsc --noEmit`. (3) Auth consolidated — both `/api/ingest/usage` and `/api/budget-status` import `tokenFromRequest`/`safeEqual`/`isUsageIngestAuthorized` from shared `ingest-auth.ts`; `USAGE_READ_TOKEN` added to `.env.example`; rate-limiter single-instance assumption documented. (4) Root `README.md` created. (5) Parked `claude/budget-status` deleted; merged branches pruned. Full verification: 52/52 tests, lint pass, build pass.
  **2026-07-05 (CLAUDE next-wave): CORRECTION — this row was miscategorized as Completed.**
  "Completed" means merged to `main` per protocol, and `origin/main` still has no `README.md`,
  lint is still bare `tsc --noEmit`, CI runs no tests, and the routes still hand-roll auth — none
  of the 5 items actually landed. The work was stranded on a never-pushed local `cursor` branch
  (3 commits behind `main`) and is now in flight as **OPEN PR #42**
  (`monet/aum-ingest-auth-refactor-eslint`, MONET carried/rebased it onto main). Moved to
  **In Progress** below referencing PR #42; will move back to Completed only when #42 actually
  merges. Issues #22-#26 stay open until then — do not let the issues-sync workflow close them
  prematurely off this stale row.
- **UI refactoring for Dashboard and Settings + API Type Safety (AG, S) — 2026-07-11.** Refactor monolithic page components (Dashboard, Settings) into discrete UI components and replace 'any' casting with PrismaClientKnownRequestError for P2002 checks.

## In Progress
- **Alert-delivery channel reliability (CODEX, owner-directed 2026-07-11).** Branch
  `codex-alert-delivery-reliability`, isolated worktree
  `/Users/jay/apps/api-usage-monitor-alert-delivery`, based on app-wide hardening commit `2dd8ad8`.
  Persist per-channel attempt/success state so one failed channel cannot resend successful channels;
  add bounded per-channel HTTP timeout/retry; use stable PagerDuty dedup keys and resolution events.
  Implemented locally: Prisma schema + additive migration harness pass, focused alert-delivery
  tests 6/6, TypeScript, and scoped ESLint pass under Node 24. Scope is alert
  delivery/schema/focused tests/docs only; no full gate, production writes, push, PR, merge, or
  deploy in this lane.
- **App-wide hardening + direct billing integrations (CODEX, owner-directed 2026-07-11).** Branch
  `codex-app-wide-hardening`. Implementing the 2026-07-11 audit backlog across telemetry/spend,
  subscriptions, security, adapter failure semantics, accessible/responsive UI, readiness/deploy/
  backup/CI, plus official-API-backed provider billing and subscription integrations. Multi-agent
  isolated sublanes; no production writes or merges without an explicit landing decision.
  Operations/readiness lane committed at `c398b7f`; telemetry, connector/security, and frontend
  lanes remain in progress before the serialized full gate.
- **Subscription->knob linkage phase 1 (CLAUDE, sonnet subagent, owner-directed 2026-07-10,
  background agent in an isolated worktree off main) — mirrored from the live board, OPEN PR #83
  (`claude/subscription-knob-linkage`), opened 2026-07-10. NOT merged.** Goal: the monitor becomes the source of truth for which market-data plan is active
  per provider AND what rate-limit env knobs that plan implies for Socratic.Trade (Infisical
  `PROVIDER_QUOTA_*`/`PROVIDER_RATE_LIMIT_*`/`TIINGO_DROP_NEWS`). Shipped: `knobEnv Json?` on both
  `ProviderPlan` (free-tier baseline) and `Subscription` (per-plan override); new `considering`
  subscription status (never charged — regression-tested); `GET /api/subscriptions` accepts a
  bearer/`x-usage-ingest-token` (`USAGE_READ_TOKEN`||`USAGE_INGEST_TOKEN`, mirrors budget-status) OR
  the dashboard session cookie, via a narrowly-scoped `api/subscriptions/?$` middleware exclusion
  (collection route only — `[id]` stays session-gated); `POST` gained its own explicit session check
  (previously relied entirely on the now-narrowed middleware gate — see the PR's "Auth deviation"
  note); each list element now carries `knobEnv` (effective) + `freeTierKnobEnv`; standalone
  idempotent `scripts/seed-provider-subscriptions.mjs` for massive/fmp/tiingo/fmp-Premium
  subscriptions + tiingo/twelvedata/alphavantage/finnhub free-tier maps (not yet run against prod —
  blocked on the migrate-safe.mjs bug below). Full gate green (lint/tsc/141 tests/build). See
  `docs/rollouts/2026-07-10-subscription-knob-linkage.md` for full detail.
  **2026-07-10 update (CLAUDE): addressed both P2 review findings on PR #83 (still open, not
  merged).** (1) `PUT /api/subscriptions/:id` now re-anchors the billing cycle to the activation
  moment (or an explicit caller-supplied `startDate`) whenever status transitions INTO `active`
  from `considering`/`paused`/`canceled`, and clears `lastChargedPeriodStart` — fixes
  `materializeDueSubscriptions` backfilling charges for every period since a `considering` row was
  *created*, not since it was actually purchased; already-active rows are untouched. (2)
  `GET /api/subscriptions`'s effective `knobEnv` now falls back to the provider's free-tier baseline
  for `paused`/`canceled` rows instead of returning a stale paid override — the override applies
  only while `active`/`considering`, per the documented contract. +5 regression tests (146 total).
  Full gate re-verified green (lint/tsc/146 tests/build). See the "2026-07-10 update" section of the
  rollout note above for detail.
  **Also discovered (pre-existing, unrelated, NOT fixed in this PR): `scripts/migrate-safe.mjs`'s
  `prisma db push --dry-run` step is broken — `--dry-run` is not a valid flag on the pinned Prisma
  6.19.3, confirmed via `npx prisma db push --help` and reproduced locally (crashes with "unknown or
  unexpected option: --dry-run" against any existing DB). Since `start-with-litestream.sh` runs this
  unconditionally on every deploy once the disk already has a DB, this blocks the next Render
  autodeploy of this app (schema-touching or not) until fixed — flagged as a spawned follow-up task,
  not addressed here (out of this PR's approved scope).** Follow-up (separate row, Socratic.Trade
  side): Mac launchd sync script monitor->Infisical. Phase 2 (unclaimed): UI usage-vs-plan-limit
  comparison.
- **Restore shared 5-field usage-telemetry idempotency (CURSOR, S) — started 2026-07-09.**
  Branch `cursor/shared-dep-adoption-9577`. Reverted server fallback `deriveIdempotencyKey` from
  a drifted 12-field basis to the shared 5-field contract; ported the 7 shared hash vectors into
  monitor tests; corrected AGENTS.md (idempotencyKey is persisted + upsert-deduped; project +
  subscription already mirrored in shared v1.4.2). Verified: usage-telemetry tests 21/21, typecheck clean.

_2026-07-06 (CLAUDE): none. The Litestream + per-adapter-resilience rows that were here MERGED as
PR #59 (`a6ce13b`) and PR #60 (`42d3559`) — see Completed above. (The "Cursor quality sweep — carried
by OPEN PR #42" row that was also here merged as PR #42.) Stale keyed issues for all of these are
being closed in this same reconciliation pass._

## Planned / Reserved

- **End-of-Month Spend Forecasting (unassigned, S)** — IDEA: Add a simple linear extrapolation algorithm based on the `UsageSnapshotDailyRollup` data to project EOM spend and display it on the dashboard as `Projected EOM Spend: $X`.
- **Dark Mode Support (unassigned, S)** — IDEA: Add standard CSS dark mode via media queries to support dark mode on the frontend dashboard without breaking the current UI.
- **Email/PagerDuty Alerting (unassigned, M)** — IDEA: PR #33 added Slack/webhook delivery channels. Expand this to support email alerting (via Resend/SendGrid) or PagerDuty integration for critical budget breaches.
**2026-07-05 (CLAUDE next-wave): CORRECTION — this mirror lagged the live board.** In Progress:
previously showed none, despite the live board having active rows. Because the issues-sync
workflow only closes an issue when the *mirror* row moves to Completed, the lag kept merged
work's issues open and created duplicates: issues #27/#28 plus duplicate #34/#35 (Codex
retention/alerts, actually merged as PR #33) are stale, and #29/#30 (AG rows since reassigned
away) are stale. This PR reconciles the mirror so the push-triggered sync auto-closes completed
issues; #34/#35 should be manually closed as title-drift duplicates of #27/#28 with a note.

- CI standard adoption (cross-app, Claude) — RESERVED: 5-line caller workflow consuming the Socratic.Trade reusable verify gate + Mac runner registration. Blocked by: claude/ci-actions-efficiency landing in the hub repo.

_2026-07-04 backlog exhaustiveness pass (CLAUDE, owner-directed). Tags: CURSOR = Cursor background
agents (DeepSeek v4 Pro), CODEX = Codex, AG = Antigravity/Gemini. Assignments are reservations,
not locks — re-negotiate in #agent-sync._

- **Implement OTLP logs ingestion (unassigned, L, deliberately deferred)** — `/api/otlp/v1/logs`
  is accept-and-drop by design today.

### 2026-07-05 next-wave (cycle 2)
_2026-07-06 (MONET): the budget-status 401 middleware row was moved to Completed above — DONE via
PR #58 (`dfdb39e`)._
_2026-07-06 (CLAUDE): "Verify Claude Code OTLP metrics land end-to-end" moved to Completed above —
VERIFIED in prod (issue #51)._
- **Configure and test-fire alert delivery channels in production (Render env + test mechanism) (OWNER, M)**
  — `ALERT_SLACK_WEBHOOK_URL` / `ALERT_WEBHOOK_URL` are `sync:false` in `render.yaml` and almost
  certainly unset, so PR #33's delivery code is dormant; there is also no way to verify delivery
  without waiting for a real budget breach. Owner sets the Slack webhook in the Render dashboard; add
  a small authed test-fire path (e.g. `POST /api/cron-adjacent test-alert` or a dry-run flag on the
  maintenance tick) so delivery is provable. _(why now: PR #33 merged the channels ~24h ago but
  end-to-end delivery is unconfigured and unverified in the only environment that matters. Owner
  action for the secret; the test-fire endpoint itself is a good CODEX follow-up since they built
  alert-delivery.ts.)_
- **Stamp /api/health with the deployed commit SHA for deploy verification (CODEX, S)** — Extend the
  health route to return `RENDER_GIT_COMMIT` (Render injects it) plus app version, so anyone can
  confirm which SHA prod runs after Render's silent autodeploys. Feeds the board's Deployed section
  with verifiable facts. _(why now: Today it is impossible to tell from outside whether prod picked
  up PR #33 (retention/alerts); every deploy-state question this cycle dead-ended on `{ok:true}`.
  Trivially small, no auth surface change (route is already deliberately public), immediately useful
  to all agents.)_
- **Add a long-horizon usage view backed by the new daily rollups (CURSOR, M)** — The dashboard and
  provider pages only ever fetch `days=30` (`page.tsx`, `providers/[id]/page.tsx`), while PR #33
  prunes raw rows at 45/90 days into `UsageSnapshotDailyRollup` rows that no UI surfaces. Add a
  90-day/12-month spend-trend chart (`UsageChart` variant) driven by the already rollup-aware
  `/api/snapshots` and `/api/usage-events` endpoints. _(why now: PR #33 unlocked this: the rollup
  data now accumulates specifically to preserve long-horizon history, but as shipped it is
  write-only — invisible to the owner. Pure UI work on existing endpoints, a good fit for the now-idle
  Cursor lane.)_
_2026-07-06 (CLAUDE): "Monitor the agent-sync relay endpoint" moved to Completed above — DONE via
PR #63's `agent-sync-relay` health-check adapter (issue #55)._

## Changelog of this log
- 2026-07-04 — bootstrapped by CLAUDE (effort-log standardization).
- 2026-07-04 — CLAUDE: OTLP ingest + Sentry health card implementation complete, PR pending.
- 2026-07-04 — CLAUDE: PR #13 merged (OTLP ingest + Sentry health card); moved to Completed.
- 2026-07-04 — CLAUDE: backlog exhaustiveness + assignment pass (owner-directed); seeded Planned
  from a full repo audit. Repo mirror + issues sync to be reconciled (stale mirror issues
  #10/#12/#15 describe already-merged work).
- 2026-07-04 — CODEX: moved assigned retention/pruning + alert-delivery rows to In Progress on
  `codex-data-retention-alert-delivery`.
- 2026-07-04 — CODEX: implemented retention/pruning + alert-delivery lanes locally; full tests,
  typecheck, and build pass locally, pending main-agent integration/landing.
- 2026-07-04 — CODEX: PR #33 merged to `origin/main` (`421a05c`); moved retention/pruning +
  alert-delivery rows from In Progress to Completed.
- 2026-07-04 — CURSOR: claimed 5 assigned items on branch `cursor`; moved from Planned to In Progress.
- 2026-07-05 — CURSOR: completed all 5 assigned items (CI tests, ESLint, auth consolidation, README, branch cleanup); moved to Completed.
- 2026-07-05 — CLAUDE: owner-directed session ("work all assigned tasks"); moved the two
  AG-reserved rows (Litestream backup, per-adapter resilience) to In Progress under CLAUDE
  (renegotiated in #agent-sync with yield offer). Seat correction: these rows were briefly
  logged as MONET based on worktree-name inference — corrected to CLAUDE per the owner's
  2026-07-05 seat-identity directive (local state is not a seat signal). Also resolved this
  seat's stale duplicate In-Progress row for the effort-sync hardening (landed as PR #38/#40,
  already recorded in Completed).
- 2026-07-05 — CLAUDE next-wave (cycle 2): reconciled this mirror against the live board
  (`/Users/jay/apps/API-USAGE-MONITOR-EFFORT-LOG.md`), which had drifted ahead. Applied stale-row
  corrections (Cursor sweep Completed->In Progress referencing OPEN PR #42; OTLP env-var owner
  action Planned->Completed, closes issue #32; Litestream/adapter-resilience branches confirmed
  absent, left one more cycle before reassignment to CODEX; Deployed section populated with
  verified prod state; mirror-lag itself flagged with stale-issue list #27/#28/#34/#35/#29/#30).
  Added 6 new Planned rows under "2026-07-05 next-wave (cycle 2)": budget-status middleware 401
  fix (MONET), OTLP data-landing verification (CLAUDE), alert-channel config+test-fire
  (OWNER/CODEX), /api/health commit-SHA stamp (CODEX), long-horizon rollup usage view (CURSOR),
  agent-sync relay monitoring (AG).
- 2026-07-06 — MONET: reconciled this mirror to my two merged+deployed items. PR #42 (`8452a0b`,
  ingest-auth/ESLint/CI/README) Completed entry updated from "PR pending" to MERGED; removed the
  stale "Cursor sweep carried by OPEN PR #42" In Progress row; moved the budget-status 401 middleware
  fix (PR #58 `dfdb39e`, deployed+verified) Planned→Completed so the issues-sync closes #50. Left
  open: #47 + #22-#25 (orphaned — keyed rows consolidated, need a manual close in CLAUDE's lane) and
  #26 (genuinely not done — parked `claude/budget-status` still on origin).
- 2026-07-06 — CLAUDE: full mirror↔reality reconciliation (owner-directed). Moved to Completed:
  Litestream (PR #59 `a6ce13b`), per-adapter resilience (PR #60 `42d3559`), OTLP end-to-end
  verification (done), agent-sync relay monitoring (PR #63). In Progress is now empty. Manually
  closed the stale/orphaned issues for already-merged work: #22 #23 #24 #25 #47 (→ #42), #27 #28
  #34 #35 (→ #33), #29 #30 (→ #59/#60), and #48 #49 #51 #55 (this pass). Genuinely-open work left
  as Planned: #17 (CI adoption, blocked), #26 (parked-branch prune, not done), #31 (OTLP logs,
  deferred), #52 (alert config+test-fire), #53 (/api/health SHA stamp), #54 (long-horizon rollup
  UI), #67/#68/#69 (forecasting / dark mode / email+PagerDuty alerting ideas).
- 2026-07-08 — CODEX: live board mirror note for shared agent-sync infra: Slack app Event
  Subscriptions are enabled, the PM2 `agent-sync-push` relay is appending real #agent-sync events
  to `/Users/jay/apps/agent-sync/events.jsonl`, `/post` fleet notice was verified through the local
  authenticated relay endpoint, and old Claude/Monet REST pollers were asked to retire now that the
  relay blocker is gone. The old Codex Cloud Slack + effort-log readiness row is superseded; no
  API-usage-monitor runtime branch or PR remains for it.

### 2026-07-06
- **Update Settings Page and Dashboard Page to support Projects UI (AG, S)**
  — Added a "Projects" section in Settings (tabbed UI) and Dashboard. Created `/api/projects` endpoints with CRUD operations and integrated `computeProjectBudgetStatus` to display project-level budget vs spend.

### 2026-07-10
- 2026-07-10 — CLAUDE: fixed the deploy-blocking `migrate-safe.mjs` `--dry-run` crash (found while
  verifying PR #83); moved to Completed above. `docs/rollouts/2026-07-10-migrate-safe-dry-run-fix.md`.
