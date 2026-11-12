# Branch disposition audit — 2026-07-15 (MONET eval-sweep)

All 105 branches not merged into `main` (`36e6ac6`) by ancestry, classified at CONTENT level
(squash-merge aware: `gh pr view` head-SHA matching + `git cherry` + `diff main...` + board cross-ref).
Produced by a 15-agent read-only audit fan-out, verified 0 UNKNOWN verdicts; full evidence per branch
retained in the session transcript. Verdict counts: 71 CONTENT_MERGED / 17 SUPERSEDED / 10 STALE_ABANDONED / 7 UNLANDED_VALUABLE.

Safe-to-prune guidance: CONTENT_MERGED + SUPERSEDED + STALE_ABANDONED branches (98) can be deleted
(archive-first per fleet convention). The 7 UNLANDED_VALUABLE are being re-landed as fresh monet/* lanes
or filed as Planned board rows — see the effort board (2026-07-15 MONET reconciliation).

| Branch | Seat | Verdict | Disposition note |
|---|---|---|---|
| `ag/add-mit-license` | AG | CONTENT_MERGED | DELETE_SAFE: Adds LICENSE (MIT) file plus minor package.json/tsconfig.json/next-env.d.ts touch-ups; the branch's docs/EFFORT-LOG.md diff is just merge-co |
| `ag/project-budget` | AG | CONTENT_MERGED | DELETE_SAFE: Adds generic external-service usage tracking and project-level budget computation (prisma schema fields, src/lib/budget-status.ts logic, src |
| `ag/sync-effort-log-deploy` | AG | CONTENT_MERGED | DELETE_SAFE: Single-line docs/EFFORT-LOG.md edit marking the 'Add MIT License' task as Deployed in the repo mirror. |
| `ag/ui-updates` | AG | CONTENT_MERGED | DELETE_SAFE: UI/UX finalization pass and ProviderTable sorting/date-formatting improvements. |
| `ag/ui-ux-refinements-clean` | AG | CONTENT_MERGED | DELETE_SAFE: UI/UX refinements for responsiveness/accessibility across login, dashboard, provider-detail, settings pages plus a ProviderCard duplicate-re |
| `agent/ag-alert-cleanup` | AG | CONTENT_MERGED | DELETE_SAFE: Branch name was reused for two different features over time: (1) originally 'disable noisy fleet relay / Anthropic must-keep-funded ale |
| `chore/remove-temp-migration-route` | OTHER | CONTENT_MERGED | DELETE_SAFE: Removes the temporary Postgres-to-SQLite migration route added early in the project's history; part of original repo bootstrap/consolidation |
| `claude/adapter-resilience` | CLAUDE | CONTENT_MERGED | DELETE_SAFE: Adds per-adapter HTTP timeouts, bounded 429/5xx retry with Retry-After handling and exponential backoff, per-provider request budget, and re |
| claude coordination-stanza branch (merged, retired) | CLAUDE | CONTENT_MERGED | DELETE_SAFE: Adds the AGENTS.md 'Inter-agent coordination' section (the fleet coordination channel + the fleet handbook protocol pointer) and the effort-log-protoc |
| `claude/board-backlog-pass` | CLAUDE | CONTENT_MERGED | DELETE_SAFE: Docs-only effort-board reconciliation: marks completed rows and seeds a 2026-07-04 backlog pass. |
| `claude/board-effort-sync-refinements` | CLAUDE | CONTENT_MERGED | DELETE_SAFE: Docs-only: records effort-sync review refinements from PR #40 on the effort board. |
| `claude/board-nextwave-c2` | CLAUDE | CONTENT_MERGED | DELETE_SAFE: Appends a 'next-wave cycle 2' planning section to docs/EFFORT-LOG.md (repo mirror of the effort board). |
| `claude/delegation-standard` | CLAUDE | CONTENT_MERGED | DELETE_SAFE: Adds the 'Delegation & model economics (fleet rule)' section to AGENTS.md. |
| `claude/effort-issues-mirror` | CLAUDE | CONTENT_MERGED | DELETE_SAFE for both local and origin refs: Adds the GitHub-Issues mirror of docs/EFFORT-LOG.md: scripts/sync-effort-issues.py plus .github/workflows/effort-issues-sync.yml. |
| `claude/effort-log-otlp-completed` | CLAUDE | CONTENT_MERGED | DELETE_SAFE for both refs: Bookkeeping-only: marks the OTLP-ingest / Sentry-health-card effort-log row as Completed in docs/EFFORT-LOG.md. |
| `claude/effort-mirror-reconcile` | CLAUDE | CONTENT_MERGED | DELETE_SAFE: Reconciles docs/EFFORT-LOG.md by moving already-merged efforts into the Completed section. |
| `claude/effort-sync-rate-limit-hardening` | CLAUDE | CONTENT_MERGED | DELETE_SAFE: Hardens scripts/sync-effort-issues.py against GitHub secondary rate limits: per-create throttle, retry with Retry-After honoring + exponenti |
| `claude/effort-sync-review-refinements` | CLAUDE | CONTENT_MERGED | DELETE_SAFE: Follow-up review refinements to the effort-sync script on top of #38: moves issue-listing inside partial-sync handling, uncaps Retry-After h |
| `claude/fix-prisma-migrate-safe-fz1340` | CLAUDE | CONTENT_MERGED | DELETE_SAFE: Removes a broken --dry-run pre-check in scripts/migrate-safe.mjs that was crashing every deploy, plus adds a repro test script. |
| `claude/litestream-render-backup` | CLAUDE | CONTENT_MERGED | DELETE_SAFE for both the branch and the locked worktree wf_a: Opt-in Litestream backup of the Render SQLite disk to R2 (fetch/restore/start scripts, render.yaml wiring). |
| `claude/otlp-claude-code-ingest` | CLAUDE | CONTENT_MERGED | DELETE_SAFE for both local and origin refs: Original Claude Code OTLP metrics/logs ingest endpoints + read-only Sentry health card. Since merged, main extended this substantially (boun |
| `claude/subscription-knob-linkage` | CLAUDE | CONTENT_MERGED | DELETE_SAFE for branch and worktree sub-knob-linkage: knobEnv linkage for subscriptions + 'considering' status + token-authed GET (phase 1) across src/lib/subscription-input.ts, subscriptions.ts |
| `claude/suspicious-wilson-d00cc1` | CLAUDE | CONTENT_MERGED | DELETE_SAFE: Not a distinct feature branch — its 8 commits (root 'Initial commit: API Usage Monitor' through 'Fix CI audit and use paid Render baseline') |
| `codex-alert-delivery-reliability` | CODEX | CONTENT_MERGED | DELETE_SAFE: Per-channel alert delivery state (persist trigger/success per notification channel so one failed channel doesn't replay successful channels) |
| `codex-alert-maintenance-isolation` | CODEX | CONTENT_MERGED | DELETE_SAFE: Isolate alert-notification failures during maintenance ticks so one channel's timeout/error doesn't abort the whole maintenance run. |
| `codex-anthropic-cash-spend-correction` | CODEX | CONTENT_MERGED | DELETE_SAFE: Correct Anthropic cash-spend accounting: exclude Claude Code's analytics-only API-equivalent estimate from actual cash-spend totals, reconci |
| `codex-anthropic-individual-account` | CODEX | CONTENT_MERGED | DELETE_SAFE: Fix Anthropic individual-account billing boundary: correct handling of individual (non-org) Anthropic credential/billing scope in the provid |
| `codex-cloudflare-gcp-billing` | CODEX | CONTENT_MERGED | DELETE_SAFE: Automate Cloudflare and Google Cloud/Gemini billing ingestion (new google-cloud-billing.ts adapter, hardened cloudflare.ts and google-ai.ts  |
| `codex-effort-log-live` | CODEX | CONTENT_MERGED | LAND_NOW is moot: Single doc commit recording the live provider-reconciliation rollout in docs/EFFORT-LOG.md. |
| `codex-gemini-cloud-keys` | CODEX | CONTENT_MERGED | LAND_NOW is moot: Gemini Cloud API key/billing status truth: quarantines Gemini cost after billing disconnect, exact-host URL assertions, gemini-key-status.ts |
| `codex-infisical-provider-sync-current-main` | CODEX | CONTENT_MERGED | LAND_NOW is moot: Adds scoped Infisical provider credential sync. |
| `codex-ingest-accepted-count` | CODEX | CONTENT_MERGED | LAND_NOW is moot: Fixes idempotent-replay ingest endpoint to report only newly-persisted row counts (docs updated too). |
| `codex-litestream-state-recovery` | CODEX | CONTENT_MERGED | DO_NOT_LAND -- already merged and live; nothing to land.: Declares `_litestream_seq`/`_litestream_lock` as Prisma external tables and removes the destructive `--accept-data-loss` fallback so Litestr |
| `codex-live-provider-reconciliation` | CODEX | CONTENT_MERGED | DO_NOT_LAND -- already merged and live; nothing to land.: Prunes obsolete Google Cloud Billing pending identities after a zero-row export query and classifies push/manual-poll providers as scheduler |
| `codex-otlp-ingest-admission` | CODEX | CONTENT_MERGED | DO_NOT_LAND -- code already merged and live; the one trailin: Adds a default-on OTLP_METRICS_INGEST_ENABLED emergency switch (503/429 with Retry-After before decode/DB access) plus a process-global one- |
| `codex-provider-enrichment-wave` | CODEX | CONTENT_MERGED | DO_NOT_LAND -- already merged and live; nothing to land.: Parallel adapter-enrichment wave (Twelve Data, FinTech Studios, Resend, LlamaIndex, Sentry, Langfuse, Render, Hetzner, Pinecone) adding auth |
| `codex-render-health-compat` | CODEX | CONTENT_MERGED | DO_NOT_LAND -- already merged; superseded in place by main's: Added a databaseHealthCheckCompatibilityActive flag (RENDER_READINESS_HTTP_COMPATIBILITY) that softened /api/ready's HTTP status to 200 duri |
| `codex-render-readiness-failsafe` | CODEX | CONTENT_MERGED | DELETE_SAFE: Made Render's /api/ready readiness check liveness-safe (restart-loop failsafe) so a slow/failed DB probe can't cause Render to kill and rest |
| `codex-render-ready-no-db-probe` | CODEX | CONTENT_MERGED | DELETE_SAFE: Skips the Render readiness DB probe under a compatibility flag so /api/ready doesn't hang when the DB probe path is degraded. |
| `codex-render-scheduler-emergency-gate` | CODEX | CONTENT_MERGED | DELETE_SAFE: Adds an emergency scheduler isolation gate in instrumentation.ts so the background scheduler can be held off during incident recovery withou |
| `codex-render-sqlite-readiness` | CODEX | CONTENT_MERGED | DELETE_SAFE: Fixed the Render SQLite restart-livelock root cause: made scheduled VACUUM opt-in, switched Render's health check to DB-independent /api/hea |
| `codex/alert-persistence-config-generation` | CODEX | CONTENT_MERGED | LAND_NOW: Fences alert persistence by config generation, serializes alert evidence transitions, preserves alert capability generations, isolates subsc |
| `codex/anthropic-receipt-cash-reconciliation` | CODEX | CONTENT_MERGED | LAND_NOW: Adds a provider-neutral, chmod-600, dry-run-first, HMAC-authenticated Anthropic receipt-cash reconciliation importer with dedicated BILLING_ |
| `codex/cloudflare-explicit-renewal-handoff` | CODEX | CONTENT_MERGED | DELETE_SAFE: Adds a Cloudflare-only guarded explicit-renewal-window candidate path (midnight-boundary calendar renewal detection) to external-billing-sub |
| `codex/cloudflare-handoff-readiness` | CODEX | CONTENT_MERGED | DELETE_SAFE: Exposes a bounded cloudflareLegacyHandoff enum plus maintenanceHealthy/aggregate-count fields into scheduler runtime state and /api/ready, w |
| `codex/cloudflare-legacy-handoff` | CODEX | CONTENT_MERGED | DELETE_SAFE: Adds the default-off guarded Cloudflare legacy Subscription UUID handoff (one-time canonical-record adoption inside the existing writer-lock |
| `codex/cloudflare-metadata-labels` | CODEX | CONTENT_MERGED | DELETE_SAFE: Groups D1/R2/KV/Queue resource-probe fields under one accessible optional disclosure in the Cloudflare setup/edit UI and clarifies in help t |
| `codex/external-billing-subscription-adoption` | CODEX | CONTENT_MERGED | DELETE_SAFE per git/GitHub evidence (fully merged and live i: Automatic authoritative paid-provider Subscription adoption (Cloudflare paid rows, Apify isPaying accounts) with per-record attestation gati |
| `codex/firecrawl-direct-billing` | CODEX | CONTENT_MERGED | DELETE_SAFE: Adds the official Firecrawl v2 team credit-usage adapter (provider-reported plan allowance/remaining credits only, no derived subtraction),  |
| `codex/gemini-cloud-monitoring` | CODEX | CONTENT_MERGED | DELETE_SAFE: Enriches Gemini/Google-AI usage with native Cloud Monitoring quota/usage gauges and request totals (bounded label parsing, scoped native quo |
| `codex/gemini-monitoring-labels` | CODEX | CONTENT_MERGED | DELETE_SAFE: Gemini Cloud Monitoring parser accepts bounded empty-string label dimensions while rejecting malformed labels; isolates unsafe GAUGE values  |
| `codex/pagerduty-snapshot-capability` | CODEX | CONTENT_MERGED | DELETE_SAFE: Shares snapshot-capability semantics between PagerDuty delivery and the /api/providers endpoints so blind/no-poll providers (voyage, fmp, fi |
| `codex/provider-family-collapse` | CODEX | CONTENT_MERGED | DELETE_SAFE: Provider-family workspace rows are collapsed by default (one summary row per family instead of an expanded card wall), with accessible aria- |
| `codex/provider-workspace-correctness` | CODEX | CONTENT_MERGED | DELETE_SAFE: Two sequential fixes landed from this branch: (1) provider-family billing summaries made exact (PR #266), (2) effective subscription status  |
| `codex/st-gemini-bootstrap` | CODEX | CONTENT_MERGED | DELETE_SAFE: Guarded, one-time-use ST (Socratic.Trade) Gemini Infisical bootstrap capability: default-off flag that, when enabled for a single maintenanc |
| `codex/st-gemini-unknown-spend` | CODEX | CONTENT_MERGED | DELETE_SAFE: Static ST (Socratic.Trade) google-ai/GEMINI_API_KEY Infisical mapping that preserves separate ST/CT project bindings; provider-family spend  |
| `codex/st-primary-bridge-reader` | CODEX | CONTENT_MERGED | DELETE_SAFE: Adds an independently default-off, read-only Infisical bridge source fixed to ST 'prod' /usage-monitor/st-primary/v1 with strict duplicate-m |
| `codex/st-primary-unexpanded-reader` | CODEX | CONTENT_MERGED | LAND_NOW is moot: Passes explicit expandSecretReferences:false through the ST primary bridge reader so literal (unexpanded) secret bytes survive Infisical rea |
| `codex/telemetry-alert-admission` | CODEX | CONTENT_MERGED | LAND_NOW is moot: Wraps alert-maintenance delivery writes in the internal-usage-write admission lane (guard alert maintenance writes) plus a regression test p |
| `codex/telemetry-closeout` | CODEX | CONTENT_MERGED | LAND_NOW is moot: Serializes internal usage writes and guards scheduler maintenance writes behind the internal-usage-write admission lane (the precursor work  |
| `dependabot/github_actions/actions/checkout-7.0.0` | DEPENDABOT | CONTENT_MERGED | LAND_NOW is moot: Bumps actions/checkout 4.3.1 → 7.0.0 across ci.yml, codeql.yml, effort-issues-sync.yml, security.yml. |
| `dependabot/github_actions/actions/setup-node-6.4.0` | DEPENDABOT | CONTENT_MERGED | LAND_NOW is moot: Bumps actions/setup-node 4.4.0 → 6.4.0 in ci.yml. |
| `dependabot/github_actions/github/codeql-action/analyze-99df26d4f13ea111d4ec1a7dddef6063f76b97e9` | DEPENDABOT | CONTENT_MERGED | DELETE_SAFE: Bumps the codeql-action/analyze pinned SHA in .github/workflows/codeql.yml (GitHub Actions security update). |
| `dependabot/npm_and_yarn/next-16.2.10` | DEPENDABOT | CONTENT_MERGED | DELETE_SAFE: Bumps next 15.x -> 16.2.10 in package.json/package-lock.json. |
| `dependabot/npm_and_yarn/npm-minor-and-patch-4dc1e4d759` | DEPENDABOT | CONTENT_MERGED | DELETE_SAFE: Grouped patch bumps: protobufjs 8.6.6->8.7.0, @eslint/eslintrc 3.3.5->3.3.6, vitest 4.1.9->4.1.10. |
| `feat/render-single-service-sqlite` | OTHER | CONTENT_MERGED | DELETE_SAFE: Consolidated the app to a single Render service using SQLite + in-process scheduler (removed separate worker/Postgres topology). |
| `fix/auth-gate-and-ingest-idempotency` | OTHER | CONTENT_MERGED | DELETE_SAFE: Added dashboard auth gate and idempotent usage-ingest handling. |
| `fix/finnhub-fmp-rate-limit-not-balance` | OTHER | CONTENT_MERGED | DELETE_SAFE: Stopped mislabeling Finnhub/FMP rate-limit-remaining as account balance/credits. |
| `fix/render-runtime-migration` | OTHER | CONTENT_MERGED | DELETE_SAFE: Fixed Render disk-at-runtime-only issue (schema push moved to startCommand) and added a temporary in-process migration route. |
| `fix/strict-typings` | OTHER | CONTENT_MERGED | DELETE_SAFE: Replaced remaining 'any' castings with Record<string, unknown> in provider-input and hetzner.test.ts for stricter typing. |
| `refactor/dashboard-settings-ui` | OTHER | CONTENT_MERGED | DELETE_SAFE: Splits monolithic Dashboard/Settings pages into ExternalTelemetryPanel, ProjectTable, ProjectsPanel, ProviderTable components and replaces ' |
| `ag/browser-sync-extension` | AG | STALE_ABANDONED | DO_NOT_LAND: Chrome-extension + Safari native-app wrapper that let a browser extension push API-key/session data into the ingest pipeline (chrome-extensi |
| `ag/safari-extension` | AG | STALE_ABANDONED | DO_NOT_LAND: Local-only branch (no origin ref) that is an earlier subset of the ag/browser-sync-extension lineage — same 11 commits (7113f91..4e4994e) bu |
| `claude/budget-status` | OTHER | STALE_ABANDONED | DELETE_SAFE: Origin-only branch (no local copy exists). Its core feature — token-gated GET /api/budget-status — already shipped via PR #6. One additional |
| `codex-legacy-pre-slash` | CODEX | STALE_ABANDONED | DELETE_SAFE -- orphaned pre-rewrite lineage with zero overla: Earliest 12-commit lineage of the app (Initial commit through 'Remove temporary Postgres-to-SQLite migration route (#5)') from before the re |
| `dependabot/npm_and_yarn/eslint-10.7.0` | DEPENDABOT | STALE_ABANDONED | DO_NOT_LAND: Bumps devDependency eslint 9.x -> 10.7.0 in package.json/package-lock.json only. |
| `dependabot/npm_and_yarn/prisma/client-7.8.0` | DEPENDABOT | STALE_ABANDONED | DO_NOT_LAND as-is: Bumps @prisma/client 6.19.3 -> 7.8.0 in package.json/package-lock.json only; never merged. |
| `dependabot/npm_and_yarn/tailwindcss-4.3.2` | DEPENDABOT | STALE_ABANDONED | DO_NOT_LAND as-is: Bumps devDependency tailwindcss 3.4.19 -> 4.3.2 in package.json/package-lock.json only (major version, breaking config format change). |
| `dependabot/npm_and_yarn/typescript-7.0.2` | DEPENDABOT | STALE_ABANDONED | DO_NOT_LAND: Bumps devDependency typescript 5.9.3 -> 7.0.2 in package.json/package-lock.json only. |
| `subagent-Congress-Trade-PR-Resolver-self-77449b88` | OTHER | STALE_ABANDONED | DELETE_SAFE: A merge commit ('Merge remote-tracking branch origin/main into ag/ui-updates') plus 'Resolve conflict in package.json', sitting on top of th |
| `subagent-Socratic-Trade-PR-Resolver-self-6caeb573` | OTHER | STALE_ABANDONED | DELETE_SAFE: Identical commit and tree to subagent-Congress-Trade-PR-Resolver-self-77449b88 (same SHA 739511c) — appears to be the same Antigravity subag |
| `ag/ui-ux-refinements` | AG | SUPERSEDED | DELETE_SAFE: Three commits: (1) a05d236 auth refactor onto shared @/lib/ingest-auth helpers + ESLint flat-config setup, (2) a61880c UI/UX responsiveness/ |
| `claude/cranky-haibt-88df77` | CLAUDE | SUPERSEDED | DELETE_SAFE: Local-only orphaned bootstrap lineage (12 commits covering the earliest provider-adapter, dashboard-auth, and Postgres-to-SQLite consolidati |
| `codex-anthropic-receipt-import` | CODEX | SUPERSEDED | DELETE_SAFE: Standalone scripts/reconcile-anthropic-receipts.mjs (362 lines) to reconcile primary mail@jays.services one-time Anthropic API credit purcha |
| `codex-frontend-subscriptions-a11y` | CODEX | SUPERSEDED | DELETE_SAFE: Single old commit (2026-07-11 02:49, ~1hr after PR #90 merged) hardening dashboard/subscription UX and a11y: ModalDialog component, subscrip |
| `codex-integration-review-fixes` | CODEX | SUPERSEDED | DELETE_SAFE as its own branch: 12-commit provider-transparency/session/accounting hardening series (residual-audit-hardening scope): manual-provider polling fix, provider  |
| `codex-provider-type-routing` | CODEX | SUPERSEDED | DO_NOT_LAND -- intent already satisfied and extended on main: P0 fix so custom providers whose name collides with a built-in slug (e.g. a custom provider literally named 'openai') always route to their  |
| `codex-render-ready-skip-probe` | CODEX | SUPERSEDED | DELETE_SAFE: A local-only follow-up meant to make Render's /api/ready avoid blocking DB probes in fallback mode — same problem space as codex-render-read |
| `codex-retention-summary-bounds` | CODEX | SUPERSEDED | DELETE_SAFE: Bounded retention/usage-summary memory: wrapped pruneExternalUsageEvents' select+group+delete in a single transaction to avoid a race with l |
| `codex-scheduler-admission-current-20260715` | CODEX | SUPERSEDED | DO_NOT_LAND: Attempts to serialize scheduled/internal SQLite writes against ingest admission by narrowing tryAcquireIngestAdmission() to ignore queued in |
| `codex-scheduler-ingest-serialization` | CODEX | SUPERSEDED | DO_NOT_LAND: Wraps alert-delivery.ts, data-retention.ts, ensure-ag***-s**c-provider.ts, usage-recorder.ts writes in a FIFO ingest-admission lease (13 fil |
| `codex-security-provider-billing` | CODEX | SUPERSEDED | DO_NOT_LAND: Adds provider-secret-config.ts, provider-external-billing.ts, migrate-provider-config-secrets.mjs, audit-provider-duplicates.mjs and per-ada |
| `codex-status-materialization-durability` | CODEX | SUPERSEDED | DO_NOT_LAND: 12-commit series: durable status snapshots, dashboard session rotation, provider integration UX/boundary explainer (ProviderIntegrationDrawe |
| `codex-telemetry-cost-correctness` | CODEX | SUPERSEDED | DO_NOT_LAND: Single commit fixing OTLP/telemetry cumulative-cost accounting and forecasts: adds otlp/cumulative-state.ts, otlp/mapping-utils.ts, otlp/val |
| `cursor/implement-provider-adapters-b7ec` | CURSOR | SUPERSEDED | DO_NOT_LAND: A very early (2026-06-29), now-primitive rewrite of provider-adapter usage/balance fetching (openai, mistral, twilio, stripe, sentry, tradie |
| `provider-integration-transparency` | CODEX | SUPERSEDED | DO_NOT_LAND as constituted: Branch's named intent — a typed provider-integration transparency drawer exposing accurate credential/config fields per provider — is alread |
| `release-plan-hardening` | CODEX | SUPERSEDED | DO_NOT_LAND: Adds a RELEASE_MAINTENANCE_PLAN_ID startup gate (scripts/provider-subscription-release-plan.mjs, run-release-maintenance.mjs) that would aut |
| `subagent-API-usage-monitor-PR-Resolver-self-5b1e8bd4` | OTHER | SUPERSEDED | DO_NOT_LAND: UI/theme pass (dark mode ThemeProvider, DashboardCharts, ProviderTable sorting, Nav updates) plus a browser-extension API-key ingest route ( |
| `codex-app-wide-hardening` | CODEX | UNLANDED_VALUABLE | LAND_AFTER_REVIEW: Mixed branch: commits through e736bf1 (21 of 24 branch-only commits) are the full 2026-07-11 audit-backlog hardening pass that landed via PR |
| `codex-integration-transparency-hardening` | CODEX | UNLANDED_VALUABLE | ASK_OWNER / LAND_AFTER_rebase-onto-current-main-and-Next16-r: Superset of codex-integration-review-fixes (see that entry) plus 5 more commits: request-body streaming size cap for /api/ingest/usage and O |
| `codex-request-window-correctness` | CODEX | UNLANDED_VALUABLE | ASK_OWNER: Adds request unit/window/start/end provenance through the adapter->snapshot->rollup->API pipeline and makes monthly-limit alerts fail closed |
| `codexfix-current-screenshot-image` | CODEX | UNLANDED_VALUABLE | ASK_OWNER: Bundles three unrelated things in one commit (31fe725, 'Refresh nav brand colors for favicon update', 2026-07-13, never had a PR opened): (1 |
| `maintenance-script-hardening` | CODEX | UNLANDED_VALUABLE | LAND_AFTER_CONFLICT_RECONCILIATION: Makes provider-secret migration transactional with encrypted-value precedence and classifier parity, and constrains the historical Claude cu |
| `residual-audit-hardening` | CODEX | UNLANDED_VALUABLE | LAND_AFTER_REBASE_AND_REVERIFY: Independent security/correctness audit (docs/audits/2026-07-11-residual-app-audit.md) with 9 concrete fixes: generic/manual provider polling |
| `residual-security-hardening` | CODEX | UNLANDED_VALUABLE | LAND_AFTER_REBASE_AND_REVERIFY: Adds a shared streaming bounded-request-body reader (4 MiB cap, 413 on oversize) for ingest routes, explicit primary/secondary provider-cred |
