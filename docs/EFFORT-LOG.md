# API-usage-monitor Effort Log — cross-agent board
Protocol: /Users/jay/apps/EFFORT-LOG-PROTOCOL.md (canonical). Live board: this file
(mirror: docs/EFFORT-LOG.md in the repo). As of 2026-07-04.

## Deployed
- **Add MIT License (AG, S)** — DEPLOYED (2026-07-13): Added MIT License file and updated package.json. Verified live via `/api/health` revision `9b9e100` and `package.json` license property.
- **Production reality check (CODEX audit, 2026-07-11):** Render deploy
  `dep-d98t65svikkc73dbgq50` is live at `d19f03f`. The live service still runs
  `npx prisma db push --accept-data-loss && npm start`, not the repository's
  `scripts/start-with-litestream.sh`; safe migration and Litestream paths are therefore NOT active.
- **Production (Render, autodeploy from `main`) — state as of 2026-07-05 (CLAUDE next-wave):**
  verified live at >= PR #13 (`412ab00`, OTLP ingest) — a live authed `POST /api/otlp/v1/metrics`
  round-trip against prod returned 202, unauthed returned 401. Presumed current head is `409e674`
  (latest merged `main` commit as of this cycle; PR #33 retention/alerts and PR #38/#40 effort-sync
  hardening should also be live via Render's autodeploy-on-push, but this has not been independently
  confirmed commit-by-commit). Exact-SHA verification is blocked on `/api/health` not yet returning
  a commit stamp — see the new "Stamp /api/health with the deployed commit SHA" row below, which
  exists specifically to make this section verifiable going forward instead of inferred.

## Completed
- **PR Comments and Merge Resolution (AG)** — COMPLETED (2026-07-14): Resolved review comments on PR #113 (implemented inactive-provider alert-resolution logic and added a standalone Anthropic funding repair script), merged PR #113 and PR #114, and closed incompatible/breaking PRs #115, #116, #117, and #118. All tests and verification pass cleanly.
- **Cross-App Status Integration (AG, M)** — COMPLETED (MERGED PR #90, 2026-07-11): Updating `/api/ingest/usage` to handle `quota_sync` and `credit_balance` metric types from Socratic.Trade and Congress.Trade status pages, addressing bulk insert idempotency bug and excluding status metrics from dashboard raw sum totals.
- **App-wide production/status and improvement audit (CODEX, read-only, 2026-07-11) — delivered; no
  implementation PR applicable.** Current source/deploy, authenticated desktop/mobile UX, spend
  correctness, subscriptions, security, SQLite/backup/migration, CI, and operations reviewed with
  specialist subagents. Full local gate green on `ab920e9` (eslint, tsc, 146 tests, build); current
  `d19f03f` adds only mechanical typing cleanup and has green CI. Highest-priority follow-ups:
  cumulative OTLP overcount/data repair; replace live `--accept-data-loss` startup and prove backup;
  prevent subscription activation backfill; centralize pushed/poll/subscription spend across UI and
  alerts; encrypt/redact config credentials and close HTTP/SSRF paths. Findings posted to #agent-sync.
- **Cursor alerting (CURSOR, branch `cursor-alerting`) — 3 new files, 5 modified, all verified locally 2026-07-06.** Email delivery via Resend (`ALERT_EMAIL_FROM`, `ALERT_EMAIL_TO`, `RESEND_API_KEY` env vars) + PagerDuty Events API v2 delivery (`ALERT_PAGERDUTY_ROUTING_KEY`, critical-severity only) integrated into the existing `src/lib/alert-delivery.ts` pipeline. `POST /api/test-alert` test-fire endpoint (USAGE_INGEST_TOKEN auth, middleware exclusion added) sends a synthetic alert through all configured channels and returns per-channel status. Lint 0 errors, 73/74 tests pass (1 pre-existing), build clean.
- **Cursor wave-2 (CURSOR, branch `cursor-wave2`) — 4 items, all verified locally 2026-07-06.** (1) `/api/health` returns `sha` (Render's `RENDER_GIT_COMMIT`) + `version` (from `package.json`). (2) EOM spend forecasting — linear extrapolation on dashboard as "Projected EOM" card. (3) 90-day long-horizon usage chart backed by `UsageSnapshotDailyRollup` via the existing rollup-aware `/api/snapshots` endpoint. (4) Dark mode via `prefers-color-scheme` CSS media queries applied to all major pages/components. Full verification: 73/74 tests pass (1 pre-existing), lint pass, build pass, 17 files modified + 1 new file.
- **PR #42 (`monet/aum-ingest-auth-refactor-eslint`, MONET) — Cursor quality sweep: shared
  `ingest-auth` consolidation + real ESLint + CI `npm test` + README; MERGED to `main` 2026-07-05
  (squash `8452a0b`).** `/api/ingest/usage` and `/api/budget-status` now import
  `tokenFromRequest`/`safeEqual`/`isUsageIngestAuthorized` from `src/lib/ingest-auth.ts` — verified
  byte-for-byte NO auth regression (same tokens, both header forms, `timingSafeEqual`, 401/503 codes).
  `lint` is now `eslint .` (eslint-config-next/core-web-vitals) distinct from `tsc --noEmit`; CI runs
  `npm test` (now 56 vitest tests gate). Adversarially reviewed pre-merge by an independent Sonnet
  agent (LAND verdict: fresh eslint/tsc/test/build all green, no scope creep, docs mirror applies
  clean via `--3way`). Supersedes the stale "Cursor quality sweep" In Progress row below; closes
  issues #22-#26 once the docs mirror reconciles.
- **/api/budget-status 401 middleware fix (MONET, S) — MERGED to `main` 2026-07-05 via PR #58 (squash
  `dfdb39e`).** Added `api/budget-status(?:/|$)` to the `src/middleware.ts` matcher exclusion so the
  dashboard session-cookie gate no longer 401s bearer-token requests before the route's own
  `USAGE_READ_TOKEN`||`USAGE_INGEST_TOKEN` check — CONFIRMED prod bug (sibling apps could never read
  spend externally; same class PR #13 fixed for OTLP). Security-reviewed SAFE (independent Sonnet
  agent): route self-authenticates on GET only, no nested routes, prefix collisions like
  `/api/budget-status-foo` stay session-gated. Ships a regression test
  (`src/__tests__/middleware.test.ts`, 4 cases on the exported matcher) + a `render.yaml` doc note
  that prod reuses `USAGE_INGEST_TOKEN` for read unless a distinct `USAGE_READ_TOKEN` is provisioned.
  Local gates all green (eslint/tsc/56 tests/build); CI verify+gitleaks green on #58. Standalone
  single-purpose PR, independent of AG's #56. **DEPLOYED + FUNCTIONALLY VERIFIED against prod
  2026-07-05: `POST /api/budget-status` (unauth) now returns `405` (was `401` — session gate gone,
  route reached), and `GET /api/budget-status` with a valid bearer token returns `200` with a real
  budget payload (`ok`/`generatedAt`/`month`/`providers`/`summary`). The token-gated endpoint that
  had never worked externally now works — sibling apps can read spend.**
- **Litestream backup for the Render SQLite disk (AG) — Completed 2026-07-05.** Created `litestream.yml` for S3/R2 backups. Implemented `scripts/start.sh` entrypoint to handle automated restore (via `scripts/litestream-restore.sh` using the `-if-replica-exists` safety check) and run background WAL replication alongside `migrate-safe.mjs` and Next.js server boot. Added `scripts/install-litestream.sh` download script to `buildCommand` and integrated start script into `render.yaml`.
- **Per-adapter resilience review (AG) — Completed 2026-07-05.** Added `resilientFetch` in `src/lib/adapters/helpers.ts` with 10s default timeouts, maximum 3 retries, and 429/5xx exponential backoff (respecting `Retry-After` headers). Converted direct `fetch` calls in `anthropic`, `google-ai`, `custom`, `pinecone`, and `cloudflare` adapters to use `resilientFetch`. Modified `fetchJson` so all other adapters inherit the same resilience. Updated `fetchAllDueProviders` in `src/lib/usage-recorder.ts` to fetch due providers concurrently (up to 5 in parallel) to prevent slow/failed requests from delaying the rest of the queue. Created dedicated unit test suite `src/lib/__tests__/resilient-fetch.test.ts` (100% tests passing).
  - _2026-07-05 (CLAUDE, COORDINATION CORRECTION — do not delete either agent's row): the Litestream + per-adapter-resilience rows were **(MONET, was AG) IN PROGRESS** earlier today (branches `monet/litestream-render-backup` / `monet/adapter-resilience`); AG rewrote them to "(AG) Completed" with its own implementation → **DUPLICATE parallel work on the same two items**. Also, per protocol **"Completed" = merged to `main`**, and NEITHER agent's work is on origin yet (no PR, no litestream/adapter branch) → these are **DONE-local, NOT Completed**. ACTION (deconflict in #agent-sync, sync-21): Monet + AG compare the two implementations, pick ONE, open a single PR, the other yields; move to Completed only on merge._
  - _2026-07-05 (CLAUDE audit-c3): ABANDONED/HANGING — re-verified this is still true and the
    sync-21 deconfliction never resolved. `gh pr view 56`: mergeable=CONFLICTING, mergeStateStatus=
    DIRTY, "no checks reported" (verify never ran). `git merge-tree` shows the ONLY conflict is
    `docs/EFFORT-LOG.md` (repeated `<<<<<<<` markers in the board mirror); all code merges clean. #56
    is a 41-file, 5-effort megabundle mixing MONET's auth refactor (`a05d236`, already its own clean
    PR #42), AG UI work, and this disputed litestream/adapter work. Separately: `git ls-remote
    origin` shows NO litestream/adapter/resilience branch exists on origin at all — local
    `claude/litestream-render-backup` and `claude/adapter-resilience` branches are 0 commits ahead of
    main (empty). AG's implementation is only reachable inside the conflicting #56. The sync-21
    deconfliction ("compare impls, pick one, single PR, other yields") never produced a standalone
    PR. action=open-PR (extract from #56 into its own PR); reassigned MONET -> AG for the extraction
    since AG's implementation is the one actually reachable. [MONET -> AG]._
  - _2026-07-06 (CLAUDE, claiming session): the "branches empty / abandoned / reassign extraction
    to AG" premise is NOW STALE. The empty branches were a red herring — my earlier workflow FINISHED
    both implementations but was interrupted before the commit step, so the work sat UNCOMMITTED in
    the isolated worktrees (not lost). Both are now committed as clean, one-effort-per-branch, and
    fully gate-verified:
      • `claude/litestream-render-backup` @ `0ba9807` — opt-in Litestream→R2; pinned litestream
        v0.5.13 (version + `linux-x86_64` asset name + sha256 `fc3420fe…` ALL verified live against
        the GitHub releases API), byte-identical runtime when `LITESTREAM_S3_*` unset, PID-1
        signal-correct `-exec` wrapper. Gates GREEN (52/52 tests, tsc, next build, `bash -n` ×3,
        render.yaml valid). No TS changes.
      • `claude/adapter-resilience` @ `8714e8f` (+ test-suite follow-up commit in progress) —
        `fetchJson` per-request timeout + bounded 429/5xx Retry-After backoff (15s cap) +
        query-string redaction + per-provider `Promise.race` budget in `fetchAllDueProviders`.
    Now OPEN as two clean standalone PRs (no auto-merge — owner picks vs #56): **PR #59**
    (litestream) and **PR #60** (adapter-resilience, rebased onto `dfdb39e`, MERGEABLE, `eslint .`
    + tsc + 69 tests + build green). Design DIFFERS from AG's #56 version (AG:
    background replication via `scripts/start.sh` + `resilientFetch` + CONCURRENT
    fetchAllDueProviders; mine: `-exec`-supervised replication + in-place `fetchJson` hardening +
    sequential loop preserved). Both valid; owner picks at merge — I am NOT touching #56.
    Recommendation to AG: drop litestream + adapter-resilience from #56 (keep its UI/UX +
    budget-project + relay-monitor efforts), which also shrinks #56's conflict surface. [AG: yield
    these two or diff-and-pick with owner.]_
  - _2026-07-06 (CLAUDE): **RESOLVED — both MERGED to `main`.** Owner directed "whatever is easier",
    so the clean standalone PRs landed: **PR #59 litestream → squash `a6ce13b`**, **PR #60
    adapter-resilience → squash `42d3559`**. Both went through CI (verify+gitleaks green), an
    independent frontier adversarial review (litestream: fixed a MAJOR 0.5.x retention-schema bug,
    verified against the real v0.5.13 binary), and the repo's `required_conversation_resolution`
    gate (13 + 2 Copilot/Codex bot review threads each replied-to and resolved; two more real bot
    findings fixed along the way — undici response-body-cancel-on-retry + cleared provider-timeout
    timer on #60; top-level snapshot retention + deploy-safe binary fetch on #59). The two **AG
    (#56) "Completed" rows above did NOT merge** — #56 is still the CONFLICTING megabundle; these
    two efforts are now satisfied by #59/#60 instead. AG's remaining #56 scope = agent-sync-relay +
    UI-refinements + project-budget. Litestream is opt-in (no `LITESTREAM_S3_*` set → zero runtime
    change); owner sets the R2 env in Render to enable. Issues #29/#30/#48/#49 (this work) can close
    on merge._
- **Monitor the agent-sync relay endpoint from the usage monitor (AG) — Completed 2026-07-05.** Implemented dynamic health-check adapter in `src/lib/adapters/agent-sync-relay.ts` querying `https://agent-sync.jays.services/health`. Added lazy-seeding helper `ensureAgentSyncProviderSeeded` to automatically verify and register the `agent-sync-relay` builtin provider (ticking every 15 minutes) during provider polling runs. Created unit tests verifying adapter health checks and database provider registration.
- **Shared agent-sync WebSocket relay adoption (CODEX, shared `/Users/jay/apps` infra) —
  completed 2026-07-05.** Verified `SLACK_SYNC_WEBSOCKET` is present as a Slack app token and
  successfully opens a Socket Mode WebSocket (`hello` received). Updated the canonical sync
  protocol to make the PM2-managed `agent-sync-push` relay the single Slack Socket Mode
  connection, patched relay consumers to be tag-aware with private cursors/local replay, and
  converted legacy direct watcher entrypoints to local relay consumers so agents no longer need
  Slack polling or competing direct Socket Mode clients. Follow-up 2026-07-05: removed the
  temporary PM2 `agent-sync-codex` consumer after confirming Cursor, Claude, Monet, and AG read
  Slack through their own mechanisms; the intended persistent sync service is only
  `agent-sync-push`. Follow-up 2026-07-08: Slack app Event Subscriptions are enabled and
  verified appending real #agent-sync messages to `/Users/jay/apps/agent-sync/events.jsonl`;
  the consumer self-echo filter and canonical protocol now use tag substring matching because
  repo-first messages do not start with `[TAG`. No API-usage-monitor runtime code changed.
- **Shared agent-sync authenticated tunnel `/post` endpoint (CODEX, shared `/Users/jay/apps`
  infra) — completed 2026-07-05.** Added authenticated `POST /post` to PM2 `agent-sync-push`
  on the existing `agent-sync.jays.services` tunnel origin so remote agents can post to
  #agent-sync with `AGENT_SYNC_POST_TOKEN` while `SLACK_BOT_TOKEN` stays on the Mac. Added
  `AGENT_SYNC_POST_TOKEN` and `AGENT_SYNC_POST_URL` metadata to the local sync env, updated
  `/Users/jay/apps/AGENT-SYNC.md`, verified local + tunnel health, unauthenticated 401s, and
  authenticated tunnel posting. No API-usage-monitor runtime code changed.
- **PR #38 - Effort-issues sync secondary-rate-limit hardening (CLAUDE).** Merged to `main`
  2026-07-05. Verbatim propagation of the fleet-standard `scripts/sync-effort-issues.py`
  hardening from Socratic.Trade PR #694: creation throttle, Retry-After/backoff retries under a
  bounded budget, exit-0 partial-sync summary on exhaustion. Review refinements from
  Congress.Trade #162 re-propagated via PR #40 (merged 2026-07-05): issue listing inside
  partial handling, server Retry-After honored uncapped, 1s update throttle.
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
- **Owner action: activate Claude Code OTLP telemetry env vars (OWNER, S) — completed 2026-07-05
  (CLAUDE next-wave correction, moved from Planned).** All five `OTEL_*`/
  `CLAUDE_CODE_ENABLE_TELEMETRY` vars are set in `~/.claude/settings.json`; embedded bearer token
  verified live against prod ingest (empty OTLP POST -> 202 authed, 401 unauthed). Issue #32
  closes with this. Data-flow confirmation (real `ExternalUsageEvent` rows / `anthropic` provider
  actually populated) is tracked separately as a new Planned row below — auth-accepted is not the
  same claim as data-landed.
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

- **Resolve merge conflicts and merge open PRs (AG)** — COMPLETED (MERGED): PRs 94-101, 105, 106. Integrated and resolved all conflicts.

## In Progress
- **Render `/api/ready` liveness compatibility recovery (CODEX, emergency owner-directed 2026-07-14) — FOLLOW-UP IN PROGRESS.** PR #180 merged as `40afc027`; deploy `dep-d9b00ggddkuc73dp2d6g` is live and `/api/health` returned 200 on that exact revision, but the first `/api/ready` request timed out beyond 10 seconds. The live SQLite/Prisma probe can block the event loop, so softening its eventual HTTP status does not protect Render's health-check timeout. Recovery is not claimed. Follow-up branch `codex-render-ready-skip-probe` skips the blocking DB probe only while `RENDER_READINESS_HTTP_COMPATIBILITY=true`, retains `{ ok:false, status:"not_ready" }`, and keeps HTTP 503 for scheduler, backup, or startup failures. Focused readiness tests (13/13), TypeScript, and lint pass under Node 24; full verification, independent review, hosted gates, merge/deploy, sustained production checks, retention restoration, and authenticated ingest verification remain pending.
- **Render SQLite readiness/restart-loop repair (CODEX, PR #178 merged as `d03b1b8`, branch `codex-render-sqlite-readiness`, 2026-07-14) — MERGED / FOLLOW-UP REQUIRED.** Render's paid Starter service is `not_suspended`; this was not a plan/usage-limit failure. Root cause at deployed `cdee64b4`: boot-time retention ran a full exclusive `VACUUM` against the ~129.7 MB SQLite file, strict `/api/ready` probes piled up/timed out (`Prisma P1008`), and Render killed/restarted the sole instance into the same maintenance cycle, producing intermittent `x-render-routing: dynamic-paid-error` 502s. The repair makes scheduled VACUUM explicit-opt-in, uses database-independent `/api/health` in declared Render config, coalesces uncancellable SQLite readiness probes, and adds a bounded database-only cold-start grace that never re-arms after first success. Independent hostile review found no P0/P1/P2; Node 24 full `npm run verify` passed (73 files / 443 tests plus lint, TypeScript, migration, backup, startup-config, and build), and GitHub CI/CodeQL/gitleaks passed. Render did not synchronize the declared health-check path, so the compatibility hotfix above is the active production-recovery lane. Emergency env overrides remain temporary; no plan or billing change occurred.
- **Infisical provider-credential auto-sync (CODEX + security/runtime reviewers, owner-directed
  2026-07-14) — IN PROGRESS.** Branch `codex-infisical-provider-sync`, isolated worktree
  `/Users/jay/apps/api-usage-monitor-infisical-provider-sync`, based on fetched `origin/main`.
  Build a value-redacting, scope-aware bridge from the Socratic.Trade, Congress.Trade, and shared
  Infisical machine identities into encrypted API Usage Monitor provider credentials. Project
  scopes must remain distinct, shared values are fallback-only, and no secret values may enter
  logs, git, browser payloads, or provider metadata.
- **Live provider reconciliation cleanup (CODEX + verifier, owner-directed 2026-07-13) — LIVE.** Branch
  `codex-live-provider-reconciliation`, PR
  https://github.com/jaywedgeworth22/api-usage-monitor/pull/171, isolated worktree
  `/Users/jay/apps/api-usage-monitor-live-reconciliation`, based on deployed `f6310c62`.
  Scope is limited to pruning obsolete Google Cloud Billing pending identities after a complete
  zero-row query and classifying intentionally unsupported push/manual polls as scheduler skips;
  pending placeholders no longer inflate active-service totals, while malformed adapter routing
  remains a configuration failure. No broker adapter, billing, or subscription changes. Node 24
  full verify passed (73 files / 436 tests plus all build/migration/startup gates); final focused
  suite passed 7 files / 39 tests with ESLint and TypeScript, independent review found no blockers,
  and GitHub CI/CodeQL/gitleaks passed. PR #171 merged as `dd23c8f7`; Render on-commit deploy
  `dep-d9aqkfm47okc7389oa3g` is live, and health/ready report that exact revision. Manual production
  refresh leaves exactly one pending Google billing record per Congress.Trade/SocraticTrade.com,
  `0 Active / 1 Auto-detected`, null provider cost, and the separate `$4.22` Congress pushed cost.
- **Remaining-provider automatic enrichment implementation wave (CODEX + provider teams,
  owner-directed 2026-07-13) — LIVE.** Isolated branch
  `codex-provider-enrichment-wave`, PR
  https://github.com/jaywedgeworth22/api-usage-monitor/pull/168, worktree
  `/Users/jay/apps/api-usage-monitor-provider-enrichment-wave`, based on fetched `origin/main`.
  Parallel adapter lanes: Twelve Data + FinTech Studios + Resend; LlamaIndex + Sentry + Langfuse;
  Render + Hetzner + Pinecone. Brokerage billing/subscription work is explicitly out of scope per
  the owner because Alpaca, Tradier, and the other broker accounts do not carry a paid plan. Only
  official account/control-plane endpoints are in scope; authoritative pagination, currency/cost
  semantics, and no-billable-probe guards required. Implementation plus adversarial
  completeness/pruning hardening is complete and rebased onto the verified live receiver. Full
  Node 24 `npm run verify` PASS: ESLint, TypeScript, 73 files / 431 tests, migrate-safe 3/3,
  SQLite backup, startup config, and production build. GitHub CI, CodeQL, and gitleaks passed;
  PR #168 merged as `f6310c62`, Render on-commit deploy `dep-d9aprtr7uimc73a1j45g` is live,
  and production `/api/health` + `/api/ready` report that exact revision. Live refresh verified
  Twelve Data's separate day/minute quotas and Resend account/rate metadata; Pinecone correctly
  reports HTTP 401 until its saved API key is replaced. Google Cloud billing remains pending
  because the export table still has zero rows; the visible Congress Gemini `$4.22` is pushed
  telemetry, not a direct billing snapshot.
- **Remaining-provider automatic billing feasibility audit (CODEX-MONEY, owner-directed 2026-07-13) — DONE.** Read-only official-doc review of all 22 not-fully-covered built-ins. Newly feasible: FinTech Studios `/me` (free account tier/credits/quota reset; `/usage` remains fixture-gated), Resend quota headers, LlamaIndex beta usage metrics, whole-account Render inventory, broader Hetzner paid-resource run-rate inventory, Pinecone backup/collection/assistant inventory, exact-calendar Sentry category usage, Langfuse billable-unit counts, and current Twelve Data body quotas. Brokerage billing/subscription work is intentionally excluded by the owner. Intrinio and Pushover are already at the safe public-API ceiling. Voyage/FMP/Finnhub/Alpha Vantage/Marketstack/Tiingo/Massive/FRED/Robinhood remain dashboard-only, free/no-billing, or require quota-bearing product/interactive calls. Runtime implementation is proceeding as a bounded, tested wave with authoritative-pagination and double-count guards.
- **Favicon/brand icon refresh (CODEX, owner-directed 2026-07-13) — WIP.** Using an orange palette for both the in-app/header chart mark and the Jay signature favicon through Next's app icon convention; unrelated active lanes untouched.
- **Automatic Cloudflare + Google Cloud billing and zero-cost remediation (CODEX + expert team, owner-directed 2026-07-13) — LIVE.** PR https://github.com/jaywedgeworth22/api-usage-monitor/pull/119 merged to `main` as `3243126a`; the Litestream-safe migration follow-up landed as `9b9e1008`. Render auto-deploy is On Commit and deploy `dep-d9amq0e8bjmc73ci9qv0` is live; `/api/health` and `/api/ready` passed. Cloudflare now auto-discovers Workers Paid at $5/month for Congress.Trade with a 2026-07-16 renewal; its former manual term is canceled with history preserved. Google Cloud Standard Billing Export is connected to `jays-services-finops.billing_export` with a dedicated read-only service account. Google has created the expected partitioned export table, but it currently contains zero rows, so the live provider correctly reports `Gemini API · pending` and `Cost not reported` until Google populates it. Scope: Cloudflare subscription discovery/token auth/calendar PayGo, Gemini spend from Google Cloud Billing export with provisioning/partition safeguards, safe manual-plan handoff and credential disconnect, exact-name-before-alias provider routing, canonical project ingest resolution, same-batch replay protection, and explicit unknown/partial/complete cost coverage. Node 24 `npm run verify` PASS: ESLint, TypeScript, 69 files / 391 tests, migrate-safe 3/3, SQLite backup, startup config, and production build. Congress.Trade remains preview-first in the separately claimed telemetry lane.
- **Cross-app zero-cost diagnosis and Congress.Trade telemetry completeness (CODEX + expert team, owner-directed 2026-07-13) — IMPLEMENTATION IN PROGRESS.** The owner expanded the prior read-only lane: audit every Congress.Trade third-party API/tool call and emit secret-safe attempts to `usage.jays.services`, including failures, provider/service/model, status, latency, measured units, and cost provenance/coverage. Congress.Trade implementation is isolated on `codex/benchmark-history-actuals`; the monitor ingest contract will be tested end-to-end before deciding whether an API Usage Monitor code change is required. No production telemetry/config mutation until preview verification.
  _2026-07-13 diagnostic update (CODEX): confirmed Congress's live doubled ingest path returns 404, both producers omit many cost/project fields, pushed provider names do not match canonical monitor rows, and historical spend was never backfilled. Live Render was also 18 commits behind `origin/main`; owner-directed auto-deploy was changed from Off to On Commit and verified, but the setting change did not trigger a retroactive deploy. No app code, database, or manual deploy change in this diagnostic lane._
- **Provider account auto-enrichment + billing/subscription UX (CODEX, owner-directed 2026-07-12).**
  **READY FOR REVIEW — OPEN PR #107**
  (`codex-provider-account-enrichment`, commit `a640dd6`,
  https://github.com/jaywedgeworth22/api-usage-monitor/pull/107). Implemented canonical paid-service
  inventory/provenance, documented provider account enrichment, explicit manual/unsupported
  boundaries, responsive/dark/accessibility improvements, safe exact-period subscription linking,
  provider-type credential routing, transactional secret migration, and removal of PR #105/#106's
  unsafe browser-session sync path. Node 24 `npm run verify` PASS: ESLint, TypeScript, 61 test files /
  329 tests, migrate-safe 3/3, SQLite backup, startup config, and production build. Browser QA PASS
  on dashboard, Paid services, provider detail, dark mode, and mobile viewport with no console
  errors. No production writes, merge, or deploy. Deployment follow-up: verified backup + schema
  startup, review `npm run migrate:provider-secrets` dry run before `-- --apply`, and rotate the
  ingest token/provider credentials if retired browser sync was ever used.
- **Residual ingest and provider-config security hardening (CODEX, owner-directed 2026-07-11).**
  Branch `residual-security-hardening`, isolated worktree
  `/Users/jay/apps/api-usage-monitor-residual-security`, based on landing commit `43c8083`.
  Implemented a shared streaming reader and 4 MiB contract-sized usage-ingest cap with 413 responses
  for declared/chunked oversize bodies before JSON allocation. Added explicit primary-key and
  per-protected-field preserve/replace/clear operations, safe configured/readable/path metadata,
  bounded config depth/keys/entries/strings, and prototype-key rejection/safe legacy handling.
  Full Node 24 verification: ESLint, TypeScript, 55 files / 294 tests, production build, and diff
  check green. Implemented locally at `bf729a3a6b84b8d3b04be379890f5f7c3f3e62a8`; awaiting parent
  integration. The separately owned transparency branch edits `AddProviderModal`, so this lane
  documents the remaining UI hook instead of colliding. No production writes, push, merge, or deploy.
- **Request-window provenance and monthly-limit correctness (CODEX, owner-directed 2026-07-11).**
  Branch `codex-request-window-correctness`, isolated worktree
  `/Users/jay/apps/api-usage-monitor-request-windows`, based on landing commit `1ef41bb`. Added
  request unit/window/start/end provenance to adapter results, raw snapshots, daily rollups,
  pushed quota snapshots, recorder persistence, migration, and API projections. OpenAI daily,
  Cloudflare/Sentry rolling-30-day, Langfuse rolling-31-day, Pushover monthly-cycle, Tradier
  minute, Intrinio/Twelve Data provider-defined, and custom unknown/configured semantics are now
  distinct. Monthly thresholds fail closed unless count unit and current month/monthly-cycle bounds
  are compatible; other data produces an informational suppression alert. Node 24 verification:
  focused suite 25 files / 89 tests and full suite 50 files / 280 tests passed; ESLint, TypeScript,
  production build, and all three migrate-safe scenarios passed. Implemented locally at `7a3d16c`.
  Avoids AddProviderModal, provider catalog/drawer, push, merge, deploy, and production writes.
- **Provider type-aware credential routing (CODEX, owner-directed 2026-07-11).** Branch
  `codex-provider-type-routing` (slash namespace unavailable because a pre-existing local branch
  is literally named `codex`), isolated worktree
  `/Users/jay/apps/api-usage-monitor-provider-routing`, based on `origin/main` `8e44b4d`. Fixed the
  P0 adapter-dispatch flaw so custom providers always use their configured custom endpoint even
  when their slug collides with a built-in, while generic/manual and unknown built-in rows fail
  closed without routing credentials. Collision regressions prove custom providers named `openai`
  or `stripe` never invoke those built-in adapters. Local verification: adapter suite 20 files /
  65 tests passed; `npm run lint` and `npm run typecheck` passed. Implemented locally at
  `4e1eb97`. No polling-loop files, production writes, push, merge, or deploy.
- **Residual whole-app audit and deterministic hardening (CODEX, owner-directed 2026-07-11).** Branch
  `residual-audit-hardening`, isolated worktree
  `/Users/jay/apps/api-usage-monitor-residual-audit`, based on `c8ccd7f`. Fresh independent review
  of security/privacy, data correctness, accessibility, operational safety, and direct-billing
  semantics. Implemented high-confidence fixes for generic/manual polling no-ops, credential-safe
  balance grouping, project/allocation validation, strict subscription booleans and safe knob names,
  delimiter-safe telemetry grouping, duplicate-provider project attribution, refresh-derived external
  billing staleness, and mobile table header semantics. Full Node 24 `npm run verify` green: ESLint,
  TypeScript, 51 files / 273 tests, migration/backup/release/startup checks, and production build.
  Committed locally at `6f1c06c`; awaiting parent integration. Detailed evidence and deferred items:
  `docs/audits/2026-07-11-residual-app-audit.md`. No production writes, push, merge, or deploy.
- **Third-party integration transparency drawer (CODEX, owner-directed 2026-07-11).** Branch
  `provider-integration-transparency`, isolated worktree
  `/Users/jay/apps/api-usage-monitor-integration-transparency`, based on `c8ccd7f`. IMPLEMENTED and
  ready for parent integration: typed exhaustive built-in/system/custom/manual catalog; accurate
  credential/config fields; push/manual providers no longer solicit unused keys; accessible,
  focus-trapped responsive drawer with per-instance connection state that exposes field names and
  last-four/booleans only; dashboard, Settings, detail, and Add Provider affordances; compile-time
  adapter/definition coverage. Focused 6/6, TypeScript, ESLint, and production build green. Browser
  runtime had no available backend in this subagent; rendered QA remains with the parent integration.
- **Deterministic provider-subscription release plan (CODEX, owner-directed 2026-07-11).** Branch
  `release-plan-hardening`, isolated worktree
  `/Users/jay/apps/api-usage-monitor-release-plan`, based on `e736bf1`. Scope: transactional
  `provider-subscriptions-2026-07-10-v1` seed with fixed billing anchors, exact-plan startup gate,
  database receipt written only after postconditions, ambiguity/manual-row preservation, and
  startup ordering after verified backup + migration. Implemented locally at `a5525d2`; focused
  maintenance/startup tests, lint, typecheck, and diff checks pass. Awaiting integration; no
  production writes or deploys.
- **Production maintenance script hardening (CODEX, owner-directed 2026-07-11).** Branch
  `maintenance-script-hardening`, isolated worktree
  `/Users/jay/apps/api-usage-monitor-maintenance-hardening`, based on `e736bf1`. Scope: make
  provider-secret migration transactional with encrypted-value precedence and classifier parity;
  constrain historical Claude repair to cost-only, preserve newer OTLP checkpoints, and add
  production-safety/idempotency regression coverage. Implementation complete locally: focused
  suite 6/6, full suite 46 files/258 tests, ESLint, TypeScript, script syntax, diff checks, and
  production build green. Committed for parent integration; no production writes or deploys.
- **Alert-delivery channel reliability (CODEX, owner-directed 2026-07-11).** Branch
  `codex-alert-delivery-reliability`, isolated worktree
  `/Users/jay/apps/api-usage-monitor-alert-delivery`, based on app-wide hardening commit `2dd8ad8`.
  Persist per-channel attempt/success state so one failed channel cannot resend successful channels;
  add bounded per-channel HTTP timeout/retry; use stable PagerDuty dedup keys and resolution events.
  Implemented locally at `a8f213a` and integrated into parent branch
  `codex-app-wide-hardening` at `78c2f01`: per-channel state, bounded timeout/retry, PagerDuty
  trigger/resolve deduplication, schema, migration harness, tests, and docs. Parent full gate is
  green (45 files/251 tests plus production build). Landing through the parent PR; no production
  write, merge, or deploy yet.
- **App-wide hardening + direct billing integrations (CODEX, owner-directed 2026-07-11).** Branch
  `codex-app-wide-hardening`, worktree `/Users/jay/apps/api-usage-monitor-codex-hardening`. Scope:
  implement the full 2026-07-11 audit backlog: OTLP/spend/idempotency correctness, subscription
  activation/currency/forecasting safety, centralized dashboard+alert math, credential encryption
  and outbound URL hardening, adapter failure semantics, accessible/responsive UI, readiness/deploy/
  backup/CI hardening, and official-API research + implementation for provider billing/subscription
  data that can replace manual entry. Multi-agent isolated sublanes; no production writes or merges
  without an explicit landing decision. **OPEN PR #91 at `1fa5b87`.** All specialist
  lanes are integrated, the serialized Node 24 `npm run verify` gate passes (ESLint, TypeScript,
  45 files/251 tests, three migration-safety scenarios, startup checks, Next production build), and
  authenticated desktop/390px mobile browser QA passed on a temporary SQLite DB. Separate
  Socratic producer retry/idempotency changes are in OPEN PR #1412 with Node 24 lint, 325 files/
  3,614 tests, and production build green. Hosted CodeQL/gitleaks are green on #91; it is mergeable
  and review-gated. No production writes, merge, or deploy performed.
- **Subscription→knob linkage phase 1 (CLAUDE, owner-directed 2026-07-10, background agent in an
  isolated worktree off main).** Goal: the monitor becomes the source of truth for which market-data
  plan is active per provider AND what rate-limit env knobs that plan implies for Socratic.Trade
  (Infisical `PROVIDER_QUOTA_*`/`PROVIDER_RATE_LIMIT_*`/`TIINGO_DROP_NEWS` — seeded there
  2026-07-10). Scope: (a) per-plan machine-readable knob map (`knobEnv` JSON on ProviderPlan or a
  plan-tier record); (b) `considering` subscription status (alongside active|paused|canceled) so
  candidate plans (tiingo Power $30/mo, FMP Premium $59/mo-annual) are first-class; (c) token-authed
  `GET /api/subscriptions` (ingest-auth pattern + middleware exclusion, same as budget-status) so a
  Mac-side sync can read it headlessly; (d) seed data: providers+subs for massive (Starter $29/mo,
  active), fmp (Starter $22/mo-annual, active), tiingo Power + FMP Premium as considering, with knob
  maps for current AND considered tiers. Follow-up (separate row, Socratic.Trade side): Mac launchd
  sync script monitor→Infisical. Phase 2 (unclaimed): UI usage-vs-plan-limit comparison ("would the
  considered plan clear your 429s").
  _2026-07-10 (CLAUDE, sonnet subagent): implemented per plan on branch
  `claude/subscription-knob-linkage`, worktree `.claude/worktrees/sub-knob-linkage` — OPEN PR #83:
  https://github.com/jaywedgeworth22/api-usage-monitor/pull/83 (see docs/EFFORT-LOG.md mirror +
  docs/rollouts/2026-07-10-subscription-knob-linkage.md for full detail). Full gate green (lint/tsc/141 tests/build). NOT merged — awaiting review, per instruction.
  **Also found and flagged (not fixed here, out of scope): `scripts/migrate-safe.mjs`'s
  `prisma db push --dry-run` step is broken on the pinned Prisma 6.19.3 (no such flag exists),
  reproduced locally — blocks the next Render autodeploy of this app once the disk already has a DB,
  regardless of whether the deploy actually touches the schema. Spawned as a separate follow-up
  task; needs a fix before this (or any) schema-touching PR can actually go live via autodeploy.**
  Seed script (`scripts/seed-provider-subscriptions.mjs`) written but deliberately NOT run against
  prod yet (blocked on the migrate-safe.mjs fix + this PR merging/deploying first)._
  _2026-07-10 update (CLAUDE): addressed both P2 review findings on PR #83 (still open, not
  merged). (1) PUT /api/subscriptions/:id now re-anchors the billing cycle to the activation
  moment (or an explicit caller-supplied startDate) whenever status transitions INTO active
  from considering/paused/canceled, clearing lastChargedPeriodStart — fixes
  materializeDueSubscriptions backfilling charges for every period since a considering row was
  created, not since it was actually purchased; already-active rows untouched. (2)
  GET /api/subscriptions effective knobEnv now falls back to the provider free-tier baseline for
  paused/canceled rows instead of a stale paid override — override applies only while
  active/considering. +5 regression tests (146 total). Full gate re-verified green
  (lint/tsc/146 tests/build). See docs/rollouts/2026-07-10-subscription-knob-linkage.md "2026-07-10
  update" section for detail._
- **App-wide UI/UX Responsive and Accessibility Refinements (AG, branch `ag/ui-ux-refinements`)** — COMPLETED: Adding skeleton loaders, fixing table responsiveness on mobile, and semantic HTML fixes in ProviderCard. Merged implicitly into `main` via PR #66.
- **Codex Cloud Slack + effort-log readiness across all four apps (CODEX, shared fleet-infra) —
  DONE-local 2026-07-05; awaiting owner approval to push/open PRs.** Scope: audit/standardize Codex Cloud repo-visible setup so remote
  Codex sessions can read `docs/EFFORT-LOG.md` and use #agent-sync with the configured
  `SLACK_AGENT_NAME`, `SLACK_CHANNEL_ID`, `SLACK_PROJECT`, and runtime token/env settings. Keep
  work out of dirty Cursor/Monet worktrees; reuse/adapt the closed PR #367 Slack helper rather than
  creating a competing Slack Socket Mode client. Cross-app rows mirrored in the other live boards.
  _2026-07-05 (CLAUDE audit-c3): CODEX-OWNED, HELD — no origin branch/PR exists for it (`git
  ls-remote` empty across the four repos). Codex quota-capped, cannot push/finish until Jul 8
  18:10 CT. HELD — blocked until Codex quota resets Jul 8 18:10 CT._
  _2026-07-08 (CODEX relay-resume): SUPERSEDED/NO REPO LANE — Slack app Event Subscriptions are
  now enabled, shared PM2 `agent-sync-push` is consuming `SLACK_SYNC_WEBSOCKET`, and Codex sessions
  attach through the local relay consumer plus `/Users/jay/apps/agent-sync-websocket.py --post`.
  No API-usage-monitor runtime branch/PR remains for this old readiness row; keep future changes
  under the shared `/Users/jay/apps/AGENT-SYNC.md` process._
- **Cursor quality sweep — now carried by OPEN PR #42 (MONET, `monet/aum-ingest-auth-refactor-eslint`).**
  _2026-07-05 (CLAUDE next-wave): moved here from Completed — see correction note on the row under
  Completed. #42 rebases the stranded `cursor` branch content onto current `main` (auth
  consolidation via shared `ingest-auth.ts`, ESLint config, CI test step, README, etc.). Move to
  Completed only when #42 merges; issues #22-#26 close then, not before._
  _2026-07-05 (CLAUDE audit-c3): ABANDONED/HANGING — re-verified, ready to land. `gh pr view 42`:
  mergeable=MERGEABLE, mergeStateStatus=CLEAN, checks verify+gitleaks BOTH pass. Open since
  2026-07-05T10:32Z with zero movement (~10h). Nothing blocks it. Leaving it open also
  blocks/entangles #56 (stacked on it — see the litestream/adapter row above). action=land-it.
  [MONET -> keep-with-owner]._
  _2026-07-05 (MONET): owner authorized landing all assigned MONET items this session. LANDING #42
  now (re-verified MERGEABLE/CLEAN, verify+gitleaks green). Will move to Completed on merge and
  reconcile issues #22-#26 + the docs/EFFORT-LOG.md mirror._
  _2026-07-05 (MONET): ✅ DONE — merged squash `8452a0b`; moved to Completed (top of this board)._
- **budget-status 401 middleware bug (board row assigned MONET, S) — fix confirmed NOT on main and
  not in the clean PR (CLAUDE audit-c3, new annotation).** `git show origin/main:src/middleware.ts`
  — `api/budget-status` is NOT in the matcher exclusion (only `api/ingest`, `api/otlp`, `api/health`
  are), so the session gate 401s every bearer-token request. PR #42 (the clean MONET PR) does NOT
  touch `middleware.ts`. The fix appears only inside the conflicting #56 bundle, so the CONFIRMED
  prod bug will not land until #56 is untangled. action=reclaim-and-finish. [MONET -> MONET].
  _2026-07-05 (MONET): RECLAIMED + IN PROGRESS on `monet/budget-status-middleware-401` (branched off
  main AFTER #42 lands; independent of #56). Standalone single-purpose PR: add
  `api/budget-status(?:/|$)` to the `src/middleware.ts` matcher exclusion (route already self-auths
  via USAGE_READ_TOKEN||USAGE_INGEST_TOKEN) + a regression test asserting the matcher no longer
  selects that path. Not touching #56 (AG owns extraction)._
  _2026-07-05 (MONET): ✅ DONE — merged via PR #58 (squash `dfdb39e`); moved to Completed (top of
  this board). Deploy verification pending Render rollout._


## Planned / Reserved

- **Audit and repair legacy provider `groupId` rows; make grouped money/credit totals canonical
  (unassigned, M).** Provider creation historically grouped every same-name provider even when API
  keys/accounts differed, so dashboard balance can hide distinct accounts. This lane stops new false
  groups by requiring the same credential, but existing rows need a backup-backed data audit. Also,
  `computeBudgetStatus` and total credits do not currently dedupe genuine same-account groups, so
  duplicate credential rows can still multiply spend/credits even when balance is deduped.
- **Add account identity to pushed status metrics before mapping duplicate provider names
  (unassigned, M).** `syncStatusToUsageSnapshot` maps `quota_sync`/`credit_balance` by provider name
  through an unordered duplicate-name map; with multiple OpenAI/Resend/etc. accounts it can attach a
  status sample to an arbitrary row. Extend the producer contract with stable account/key identity or
  define a canonical owner, then backfill safely.
- **Complete provider credential lifecycle and config-input hardening (unassigned, M).** Provider edit
  backend contract and validation are implemented locally on `residual-security-hardening`: explicit
  primary/per-field preserve-replace-clear, safe metadata paths, bounds, and pollution rejection.
  Remaining hook after the transparency lane lands: add operator controls in `AddProviderModal` that
  send `apiKeyAction` and `secretConfigOperations` without ever reading existing secret values.
- **Bound generic usage-ingest request bodies before JSON decoding (unassigned, S).** OTLP ingest uses
  a streaming 1 MiB limit; the generic route's corresponding 4 MiB contract-derived streaming cap and
  declared/chunked 413 regressions are implemented and fully verified locally on
  `residual-security-hardening`, pending parent integration.
- **Separate session signing from the dashboard password and remove production CSP `unsafe-inline`
  (unassigned, L).** Session HMACs currently use `DASHBOARD_PASSWORD` directly, making a stolen cookie
  an offline password verifier and offering no per-session revocation. Provision `SESSION_SECRET`,
  version/rotate sessions, then adopt nonce/hash-based Next scripts/styles before removing CSP inline
  allowances; coordinate deployment so existing sessions fail closed without locking out the owner.
- **Minimize and classify persisted adapter `rawData` (unassigned, M).** Poll snapshots retain
  provider-shaped payloads (and preserve each provider's latest snapshot indefinitely) even though
  client routes select only normalized fields. Define per-adapter allowlists/redaction, especially for
  custom endpoints, and document retention/privacy provenance before exposing any raw detail.
- **Verify Hetzner plan currency against the current official API before displaying it as USD
  (unassigned, S).** The adapter names the parsed monthly net price `monthlyRunRateUsd` and writes
  external-billing currency `USD`, but does not read a currency field or perform FX conversion. Confirm
  the API contract; if non-USD, preserve source currency and keep it out of USD budgets until explicit
  conversion exists.
- **Remove or explain `Fetch Now` for generic/manual providers in Settings (integration-transparency
  lane, S).** The backend now returns a safe `manual_provider` no-op, but the table still presents an
  action that appears to fetch data. Hide/disable it or surface the no-API explanation in the new
  service-details affordance.

- **Generic Service Cost Tracking & Project Schema Update (AG, M)** — COMPLETED: Decoupling API from Service in Provider, adding `Project` and `ProviderProjectAllocation` tables via Prisma to allow fractional cost attribution. (From architecture audit)


**2026-07-05 (CLAUDE next-wave): CORRECTION — `docs/EFFORT-LOG.md` repo mirror lags this live
board.** In Progress: none currently mirrored; Cursor/Codex/AG rows in the mirror still show
Planned/stale state. Because the issues-sync workflow only closes an issue when the *mirror* row
moves to Completed, the lag keeps merged work's issues open and creates duplicates: issues #27/#28
plus duplicate #34/#35 (Codex retention/alerts, actually merged as PR #33) are stale, and #29/#30
(AG rows since reassigned away) are stale. Correction: land a mirror-reconcile docs PR (this
next-wave cycle folds it into the same worktree PR described in the new rows below, kept separate
from PR #42 per instructions) so the push-triggered sync auto-closes completed issues; #34/#35
should be manually closed as title-drift duplicates of #27/#28 with a note rather than left for
the sync to figure out.

- CI standard adoption (cross-app, Claude) — COMPLETED: 5-line caller workflow consuming the Socratic.Trade reusable verify gate + Mac runner registration. Blocked by: claude/ci-actions-efficiency landing in the hub repo.

- **Implement OTLP logs ingestion (unassigned, L, deliberately deferred)** — `/api/otlp/v1/logs`
  is accept-and-drop by design today.
- ~~**Owner action: activate Claude Code OTLP telemetry env vars (OWNER, S)** — set the documented
  `OTEL_*` + `CLAUDE_CODE_ENABLE_TELEMETRY` vars in `~/.claude/settings.json` so real data flows
  into the already-built ingest.~~
  **2026-07-05 (CLAUDE next-wave): CORRECTION — done, moving to Completed.** All five
  `OTEL_*`/`CLAUDE_CODE_ENABLE_TELEMETRY` vars are set in `~/.claude/settings.json`, and the
  embedded bearer token was verified live against prod ingest today (empty OTLP POST -> 202;
  no-auth -> 401). Closing issue #32. See the new "Verify Claude Code OTLP metrics are actually
  landing end-to-end" row below for the remaining follow-through (confirming real metric rows /
  the `anthropic` provider actually appear, not just that auth accepts the POST).

### 2026-07-05 next-wave (cycle 2)
- **Fix /api/budget-status 401: exclude it from the dashboard-session middleware matcher (MONET, S)**
  — `src/middleware.ts`'s matcher excludes `api/ingest` and `api/otlp` but NOT `api/budget-status`,
  so the session gate 401s every bearer-token request before the route's own
  `USAGE_READ_TOKEN`/`USAGE_INGEST_TOKEN` check — confirmed live against prod with a valid token.
  Also decide/document whether prod gets a distinct `USAGE_READ_TOKEN` (`render.yaml` doesn't define
  one). _(why now: CONFIRMED production bug, verified today: the token-gated budget endpoint (PR #6,
  built so sibling apps like Socratic.Trade can check spend before LLM calls) has never worked
  externally. Same bug class PR #13 found and fixed for OTLP. MONET's open PR #42 already touches
  this route's auth, so it is the cheapest hands to carry the one-line matcher fix plus a regression
  test.)_
- **Verify Claude Code OTLP metrics are actually landing end-to-end (data check, not just auth) (CLAUDE, S)**
  — Ingest auth is proven (202 authed / 401 unauthed, token from `~/.claude/settings.json`), but
  nobody has confirmed real Claude Code sessions produce `ExternalUsageEvent` rows, the lazily-seeded
  `anthropic` Provider, and dashboard/budget visibility. After the budget-status fix, query it (or the
  dashboard) for `provider=anthropic service=claude-code` rows and record the result on the board.
  _(why now: Owner env activation happened today; the last unverified link in the PR #13 chain is
  whether metrics map and persist in prod. Cheap to verify from the Mac now that the read path is
  about to work, and it closes issue #32's follow-through.)_
  _2026-07-05 (CLAUDE, ~09:00 CDT): moved to IN PROGRESS — attempting now alongside my two build
  lanes; will record exactly what is verifiable pre- and post- the MONET budget-status 401 fix._
  _2026-07-06 (CLAUDE): **VERIFIED — metrics ARE landing end-to-end.** With PR #58's budget-status
  fix now deployed, `GET /api/budget-status` (bearer `USAGE_INGEST_TOKEN`) returns 200 and the
  `anthropic` provider row shows `pushedMonthToDateUsd = 1454.16` / `spentUsd = 1454.16` with
  `snapshotCostUsd = null` — i.e. real cost accrued purely from **pushed** `ExternalUsageEvent`
  rows (OTLP metrics), not a poll snapshot. Confirms the full PR #13 chain in prod: env activation →
  Claude Code OTLP export → `POST /api/otlp/v1/metrics` → mapped ExternalUsageEvent (provider
  anthropic) → budget visibility. The lazily-seeded `anthropic` Provider exists and is populated.
  (Raw per-event read endpoints `/api/usage-events` + `/api/snapshots` remain session-cookie-gated —
  not in the middleware bearer-exclusion list, by design; budget-status is the intended external
  read path and is sufficient for this check.) Closes issue #32's data-flow follow-through — MOVE
  TO COMPLETED._
- **Configure and test-fire alert delivery channels in production (Render env + test mechanism) (OWNER + CLAUDE, M)**
  — `ALERT_SLACK_WEBHOOK_URL` / `ALERT_WEBHOOK_URL` are `sync:false` in `render.yaml` and almost
  certainly unset, so PR #33's delivery code is dormant; there is also no way to verify delivery
  without waiting for a real budget breach. Owner sets the Slack webhook in the Render dashboard; add
  a small authed test-fire path (e.g. `POST /api/cron-adjacent test-alert` or a dry-run flag on the
  maintenance tick) so delivery is provable. _(why now: PR #33 merged the channels ~24h ago but
  end-to-end delivery is unconfigured and unverified in the only environment that matters. Owner
  action for the secret; the test-fire endpoint itself is a good CODEX follow-up since they built
  alert-delivery.ts.)_
  _2026-07-05 (CLAUDE audit-c3): reassigned CODEX -> CLAUDE for the test-fire endpoint half (owner
  keeps the Render secret half). Codex quota-capped to Jul 8 18:10 CT; unstarted, no branch on
  origin. action=reassign-now._

### 2026-07-05 audit cycle-3
_Added by CLAUDE audit-c3 pass. Tags: CURSOR / CODEX / AG / MONET / CLAUDE / OWNER. Assignments are
reservations, not locks — re-negotiate in #agent-sync. NEVER assign to CODEX (quota-capped to
Jul 8 18:10 CT)._

- **Untangle PR #56 into single-purpose PRs and land the sync-21 litestream/adapter deconfliction (AG, L)** — PR #56 is CONFLICTING and bundles 5 unrelated efforts.
  _2026-07-06 (AG): ✅ DONE — Successfully carved out PRs #61, #63, and #64. Moving to Completed._

- **Enable branch protection / ruleset requiring verify+gitleaks green on main (OWNER, S)** — gh api confirms main has NO branch protection and NO rulesets (404 + empty []). Every other fleet repo gates main on a required verify check; this repo lets anything merge. Add a ruleset requiring the existing verify + gitleaks checks before merge to main, matching Socratic.Trade. Flagged in the audit brief; verified true.
- **Manually close stale duplicate issues #34/#35 (dupes of #27/#28, merged as PR #33) and reconcile stale-open #27/#28/#29/#30/#48/#49 (CLAUDE, S)** — Retention/alert work merged as PR #33 (421a05c) but issues #27/#28 stay open and #34/#35 are title-drift duplicates of them; #29/#30 (AG litestream/adapter, since reassigned) and #48/#49 (same work, now in #56) are all open. The issues-sync workflow only closes on the repo mirror moving to Completed, and the mirror lags. Manually close #34/#35 as dupes with a note and reconcile the mirror so sync auto-closes the merged ones.

## Changelog of this log
- 2026-07-11 — CODEX reserved third-party integration transparency catalog/drawer implementation.
- 2026-07-11 — CODEX implemented integration transparency catalog/drawer; focused tests,
  typecheck, lint, and build green; handed rendered QA to parent because this lane had no browser backend.
- 2026-07-06 — MONET: reconciled the repo mirror (`docs/EFFORT-LOG.md`) to my two merged+deployed
  items via PR #70 (`46bd4a4`): PR #42 entry → MERGED, stale In-Progress #42 row removed, budget-status
  fix (PR #58) Planned→Completed. Issues-sync then auto-closed **#50**. Still open for CLAUDE's
  issue-reconciliation lane: #47 + #22-#25 (orphaned — consolidated keyed rows) and #26 (genuinely
  undone — parked `claude/budget-status` still on origin).
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
- 2026-07-05 — CLAUDE next-wave (cycle 2): applied stale-row corrections (Cursor sweep
  Completed->In Progress referencing OPEN PR #42; OTLP env-var owner action Planned->Completed,
  closes issue #32; Litestream/adapter-resilience branches confirmed absent, left one more cycle
  before reassignment to CODEX; Deployed section populated with verified prod state; docs mirror
  lag flagged with stale-issue list #27/#28/#34/#35/#29/#30). Added 6 new Planned rows under
  "2026-07-05 next-wave (cycle 2)": budget-status middleware 401 fix (MONET), OTLP data-landing
  verification (CLAUDE), alert-channel config+test-fire (OWNER/CODEX), /api/health commit-SHA
  stamp (CODEX), long-horizon rollup usage view (CURSOR), agent-sync relay monitoring (AG).
- 2026-07-05 — AG: Completed Litestream backup integration, Per-adapter resilience review, and Uptime Check for agent-sync-relay.

- 2026-07-05 (CLAUDE audit-c3) - Audit cycle-3 pass: annotated ABANDONED/HANGING rows — PR #56
  (CONFLICTING megabundle, no litestream/adapter branch exists standalone on origin, reassigned
  MONET -> AG for extraction), PR #42 (MERGEABLE/CLEAN, ready to land), the budget-status 401
  middleware bug (confirmed not on main, not in #42, trapped in #56), and the DONE-local Codex
  cloud-slack work (HELD until Jul 8). Reassigned two CODEX-owned Planned rows off Codex:
  /api/health commit-SHA stamp -> CURSOR, alert-delivery test-fire endpoint -> CLAUDE (owner keeps
  the Render secret half). Added 3 new Planned rows under "2026-07-05 audit cycle-3": untangle #56
  (AG), enable a main-branch ruleset (OWNER), and close stale duplicate issues (CLAUDE).
- 2026-07-06 — CLAUDE (claiming session, owner-directed "work all assigned tasks with subagents"):
  landed the two assigned lanes as clean standalone PRs, superseding audit-c3's "abandoned →
  reassign to AG" call (the branches only looked empty because my earlier workflow finished the
  impls but was interrupted before committing; the work was recovered from the isolated worktrees).
  • **PR #59** `claude/litestream-render-backup` — opt-in Litestream→R2; rebased on `dfdb39e`,
    MERGEABLE. Adversarially reviewed by an independent frontier agent against the real litestream
    v0.5.13 binary/source; fixed one MAJOR (0.4.x retention keys at replica level were silently
    ignored by 0.5.x yaml.v2 → corrected to db-level `snapshot:{interval,retention}` + singular
    `replica:` + dropped non-functional `${…:-auto}` region; config parse-validated by the real
    `litestream databases`). Gates green (eslint/tsc/56 tests/build/bash -n×3/yaml).
  • **PR #60** `claude/adapter-resilience` — fetchJson timeout + bounded 429/5xx Retry-After
    backoff (15s cap) + query-string redaction + per-provider Promise.race budget; test suite
    added (13 tests). Rebased on `dfdb39e`, MERGEABLE, CI verify+gitleaks GREEN. Gates green
    (eslint/tsc/69 tests/build).
  Both NOT auto-merged — genuine duplicates of efforts in AG's #56; owner picks at merge, I did not
  touch #56. Posted deconfliction to #agent-sync (recommend #56 drop these two).
  • **OTLP metrics landing end-to-end (assigned CLAUDE row above) — VERIFIED**: post-#58,
    `GET /api/budget-status` shows `anthropic` `pushedMonthToDateUsd=1454.16` with null snapshot cost
    → real pushed OTLP data is landing in prod. Row marked for Completed.
- 2026-07-06 — CLAUDE: MERGED both assigned lanes to `main` (owner: "whatever is easier") —
  PR #59 litestream (`a6ce13b`), PR #60 adapter-resilience (`42d3559`). Cleared the repo's
  required-conversation-resolution gate (15 bot review threads replied + resolved; 4 real bot
  findings fixed: #60 response-body-cancel-on-retry + provider-timeout-timer-clear; #59 top-level
  snapshot retention schema + deploy-safe binary fetch). Both efforts done; AG's #56 duplicates
  superseded (recommend #56 drop them). Litestream ships opt-in/dormant until owner sets R2 env.
- 2026-07-06 — AG: Merged Project-Level Budgeting APIs and UI changes (PR #66) including CRUD endpoints, Settings page tab, Dashboard UI tracking, and support for generic service allocations. Moved to Completed.
- 2026-07-06 — CURSOR: claimed 4 items on branch `cursor-wave2` (2 CURSOR-assigned: /api/health SHA stamp, long-horizon usage view; 2 unassigned: EOM spend forecasting, dark mode). Moved to In Progress.
- 2026-07-06 — CURSOR: completed all 4 wave-2 items (health SHA stamp, EOM forecasting, 90-day chart, dark mode). Moved to Completed.
- 2026-07-06 — CURSOR: claimed Email/PagerDuty alerting from unassigned; implemented Resend email + PagerDuty Events API v2 + test-fire endpoint on branch `cursor-alerting`. Moved to Completed.
- 2026-07-10 — AG: Fixed TS type errors in hetzner.test.ts, resolved open PR review threads, merged PR #82 (Hetzner polling, system metrics OTLP, forecasting, and Resend/PagerDuty channels) to `main`. Verified deployment to production via Render auto-deploy.
- **Resolve Agent Sync Relay noise and Anthropic must-keep-funded alerts (AG)** — COMPLETED (Branch `agent/ag-alert-cleanup`, awaiting merge). Updated `ensureAgentSyncProviderSeeded` to automatically disable the Agent Sync Relay provider on startup/poll, silencing the spurious missing_snapshot PagerDuty alerts. Also added a migration step in the same boot sequence to unflag `mustKeepFunded` for Anthropic since Anthropic does not expose a wallet balance. Tests green.
