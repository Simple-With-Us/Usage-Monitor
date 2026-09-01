## Current (2026-09-01 CLAUDE — "never idle-watch a PR" landed + extended)

Owner ruling 2026-09-01: agents "should never just wait and watch for things to merge since
that wastes tokens/time and they inevitably almost invariably end up slowly wasting
money/quota while the PR sits there with conflicts or comments/issues unresolved."

The rule had already been written for this repo and never committed — a peer seat left
`## Never wait and watch for PRs to merge / Idle-polling forbidden` as an **uncommitted**
working-tree edit in the owner's integration tree (` M AGENTS.md`, 12 insertions vs
`origin/main`), so no other seat could read it.  The rule about not letting work sit was
itself sitting unlanded.  Their heading, framing, and binding rules 1-5 are adopted
**verbatim** (authorship preserved; their pending local diff is now a no-op subset of
`main`), extended with the parts the ruling requires and the text lacked: a
symptom -> diagnosis -> action table, arm auto-merge at PR-open, the bounded-wait carve-out
(one `gh pr checks <n> --watch` is legal, an open-ended `sleep` loop is not, and a bounded
wait that ends unmerged means diagnose rather than wait again), review-bot thread triage
discipline, background jobs -> end the turn instead of narrating "standing by", and a
cross-reference to the canonical `/Users/jay/apps/AGENT-SYNC.md` § Never idle-watch a PR.

Docs only.  Owner's integration tree untouched — it will still show ` M AGENTS.md` until
pulled.  Rollout: `docs/rollouts/2026-09-01-never-idle-watch-rule.md`.

## Prior (2026-08-31 AG — Sentry observability expansion)

Expands Sentry observability in Usage-Monitor utilizing the fleet's $5,000 credit sponsored tier: enabled masked Session Replay by default on web client (`replaysOnErrorSampleRate: 1.0`, `replaysSessionSampleRate: 0.1`) with complete text and media redaction, raised default trace sampling to 0.2 across server/edge/client, added `dealdex` to tracked fleet projects on the dashboard Sentry health card, and verified inert behavior when Sentry env vars are absent. Rollout: `docs/rollouts/2026-08-31-sentry-observability-expansion.md`.

## Prior (2026-08-31 CLAUDE — collector main-guard hardening)

#1383 fixed a bare-filename main guard in `scripts/ops/r2-weekly-archive.mjs` and
called it the only one in `scripts/`.  True as written, so rather than take it on
faith — my own offline reasoning in #1381 leaned on `fleet-usage-collector.mjs`'s
guard being sound — I audited every entrypoint guard in the repo.  Four idioms
are in use; seven scripts use the correct one and three did not.
`claude-usage-collector.mjs`, `fleet-usage-collector.mjs`, and
`antigravity-session-collector.mjs` used `import.meta.url.endsWith(process.argv[1])`.
`import.meta.url` percent-encodes the path and `process.argv[1]` does not, so on
any checkout whose path contains a space, `#`, `?` or `%` the guard evaluates
false — and this fleet has such paths (`~/Code/Agentic Trading`).  The failure is
silent: the CLI body is skipped, nothing is collected, and the process exits 0, so
a LaunchAgent reports success forever while telemetry quietly stops arriving, in
the app whose whole purpose is not missing usage telemetry.
`scripts/com.jays.fleet-usage-collector.plist.example` exists to schedule exactly
that script.  Proven end-to-end from a spaced-path copy: zero output and exit 0
before, collector runs after.  This is the opposite direction from #1383 (too
strict rather than too loose) with the same root cause — comparing path fragments
instead of resolved URLs.  All three now use the `pathToFileURL` equality idiom,
and a repo-wide guard audit was added to `test-session-token-collectors.mjs`,
already a CI gate since #1381 so it costs no new CI time; a negative test proves
the audit catches a reintroduction rather than merely passing.  Blast radius is
latent, not firing: the four launchd-registered collectors already used the
correct idiom.  Rollout:
`docs/rollouts/2026-08-31-collector-main-guard-hardening.md`.

## Previous (2026-08-31 CLAUDE — stale `UM_CI_RUNNER` comments in five workflows)

Found while wiring the CI verify-drift steps in #1381.  `ci.yml`'s `verify` job
carried a ten-line comment describing a self-hosted-runner offload gated on a
`UM_CI_RUNNER` repo variable, with a fallback runbook, directly above a `runs-on:`
line reading a literal `ubuntu-latest`.  The comment did not describe a stale
option — it described a control that does not exist.  `bbf540a0` (#834,
2026-07-29, owner-authored "ci: migrate to hosted ubuntu-latest runners") replaced
the `${{ (github.actor != 'dependabot[bot]' && vars.UM_CI_RUNNER) || 'ubuntu-latest' }}`
expression with a literal in all five workflows and changed no comments, so
`ci.yml`, `security.yml`, `codeql.yml`, `uptime-monitor.yml`, and
`effort-issues-sync.yml` all went on documenting a deleted feature.
`vars.UM_CI_RUNNER` is read nowhere in the repo: setting it does nothing, and the
documented emergency fallback (`gh variable set UM_CI_RUNNER --body ""`) would
silently fail to fail over.  Worse, the comments invite reintroducing the retired
self-hosted runners — `codeql.yml` instructs the reader to "revert this line" for
a line that no longer exists, and `uptime-monitor.yml` frames moving its 5-minute
cron off hosted as "the main saving."  Fixed as comments and docs only: **no
`runs-on:` value was touched**, so CI routing is byte-identical to `main`.  The
durable half is in `AGENTS.md` — every `verify` gate needs a matching `ci.yml`
step in the same PR (with an audit one-liner), fleet CI is GitHub-hosted only, and
trust the `runs-on:` value over any comment describing runner routing.  The
effort-log row asserting "UM_CI_RUNNER gating on main" was corrected in place per
protocol rather than rewritten.  Rollout:
`docs/rollouts/2026-08-31-stale-um-ci-runner-comments.md`.

## Previous (2026-08-31 CLAUDE — CI verify drift #4: `test:r2-archive` + the main-guard bug that hid it)

`test:r2-archive` was the fifteenth and last `npm run verify` gate with no step in
`.github/workflows/ci.yml` — the fourth instance of the drift class #1381 fixed,
and the one flagged there as out of scope.  It left the weekly R2
disaster-recovery archive (SigV4 signer, prune allowlist, verify-before-delete
ordering contract, failure classifier) with no CI coverage at all.

It could not simply be wired.  On clean `origin/main` the script printed
`18 passed, 0 failed` and still exited 1.  `scripts/ops/r2-weekly-archive.mjs`
detected its CLI entrypoint with
`process.argv[1].endsWith("r2-weekly-archive.mjs")`, and
`"test-r2-weekly-archive.mjs"` satisfies that suffix — so importing the module
from the test made it believe it was the CLI, run a real `runArchive()` against
the ambient environment, and set `process.exitCode = 1`.  It was the only
bare-filename main guard in `scripts/`; it now compares `import.meta.url` via
`pathToFileURL`, the idiom the other five collector scripts already use.

That also corrects the record.
`docs/rollouts/2026-08-12-pagerduty-alert-correctness.md:158` read the exit 1 as
the test needing live `R2_ARCHIVE_*` credentials and writing to `/data/`, which is
why it sat outside CI for three weeks.  The test needs neither — the
accidentally-triggered archive run was the only thing that did.  And on any host
where those variables ARE present (the production container, or an operator shell
with the Infisical environment loaded), running the test would have snapshotted
the real database, PUT to the live `usage-monitor-prod-v3` bucket, and DELETEd
superseded generations.  That hazard is closed.

Proven rather than asserted: under `env -i` with a throwaway `HOME`, exit 1
before and exit 0 after, with no archive run; the CLI entrypoint re-verified via
both the relative path Coolify's scheduled task uses and an absolute path.  The
drift audit now reports `15 gates in verify; missing from CI: none`, so the class
is closed.  `test:apple-projects` fails on this Mac only (`iOS 26.5 is not
installed`) and runs on hosted `macos-latest`; every other gate is green.
Rollout: `docs/rollouts/2026-08-31-ci-verify-drift-r2-archive.md`.

## Previous (2026-08-31 CLAUDE — CI verify-job drift: three offline `test:*` scripts)

`package.json`'s `verify` script runs fourteen gates; the `verify` job in
`.github/workflows/ci.yml` ran eleven.  `test:session-token-collectors`,
`test:cf-token-map`, and `test:replica-status-probe` were in `npm run verify`
with no CI step at all, so a regression in `scripts/replica-status-heartbeat.sh`,
`deploy/coolify/replica-status-probe.sh`, `scripts/cf-token-map.sh`, or the
session-token-collector parsers passed CI green while a local `npm run verify`
would have caught it — the same drift class this workflow's own
`test:receipt-inbox-worker` comment describes fixing once already.  All three
scripts were read end-to-end and confirmed network- and secret-free before
wiring: the collector test is inline JSONL fixtures whose one import keeps its
network POST behind a main guard, the cf-token-map test only `bash -n`s and greps
`cf-token-map.sh` (it never invokes it, so no Infisical or Cloudflare call and no
CI-secret gating), and the replica-probe test mocks `subprocess.run` and points
`LITESTREAM_BIN` at a throwaway script.  Demonstrated, not just asserted, by
re-running all three under `env -i` with a throwaway `HOME` — all exit 0.
Additive workflow-only change; no runtime, deploy, or product impact.  Flagged
but deliberately not fixed here: `test:r2-archive` is a fourth instance of the
same drift and needs a follow-up.  Rollout:
`docs/rollouts/2026-08-31-ci-verify-drift-three-offline-tests.md`.

## Previous (2026-08-31 CLAUDE — /api/health r2Weekly + replica-status probe cost trim)

`/api/health` now exposes `checks.storage.r2Weekly` (`{ok, key, ageSeconds,
staleness, reason}`, backed by the existing `getR2WeeklyArchiveStatus`), matching
the shape Socratic.Trade and Congress.Trade already publish so peer-fleet parsers
and external monitors can read this app's weekly archive freshness off its public
health path.  Separately, the host systemd timer `usage-monitor-replica-status`
(driving ~720 Backblaze Class C LIST calls/day) was trimmed: dropped the
in-container `docker exec --once` heartbeat attempt (always failed on Coolify --
`docker exec` never carries the Infisical-injected env, so it was pure overhead),
replaced the unconditional `{0,1,2,3,9}` LTX-level scan with an adaptive
level-0-first escalation (1 call/tick steady state, up to 5 only when level 0 is
briefly empty -- a fixed `{0,9}`-only design was drafted first and caught as wrong
by code review before merge, since litestream's brief L0 retention can leave a
real tip sitting at L1-L3), and widened the timer cadence 10min -> 30min --
combined, ~720/day -> roughly 48-96/day.  Full verify gate green (lint/tsc/2338
tests/build + all `test:*` scripts, including a clean `test:apple-projects` native
iOS/Safari build and a new functional self-test for the escalation logic).
Rollout:
`docs/rollouts/2026-08-31-health-r2weekly-probe-efficiency.md`.

## Previous (2026-08-27 CLAUDE — Litestream B2 multipart fix)

L1 compaction against Backblaze B2 was wedged in a retry storm — 119 "compaction
failed" errors in ~2h (checksum mismatch ~part 14, whole multipart restarted every
~61s) — which is what burned through the shared Backblaze daily transaction caps on
2026-08-26/27.  `litestream.yml` now mirrors Socratic.Trade's proven fix for the
identical failure class: `part-size: 10MB` + `concurrency: 2`.  Post-deploy proof:
container logs show a clean `compaction complete level=1` with no new checksum
mismatches.  Rollout: `docs/rollouts/2026-08-27-litestream-b2-part-size.md`.

## Previous (2026-08-25 GROK — hosted ios-ship ASC import)

GitHub-hosted `macos-latest` `ios-ship` run 32795404598 failed because
`~/.secrets/appstore-connect.env` does not exist on a hosted runner (same
class as Socratic.Trade before #3089).  The workflow now imports the existing
team ASC/P12 GitHub secrets and writes that env via
`scripts/ios-appstore-gm-prepare.sh`.  LocalUsageMonitor stays skipped.  No
new key.  No `--force-ship`.  Receipt:
`docs/rollouts/2026-08-25-ios-hosted-asc-import.md`.

## Prior (2026-08-22 GROK — Copilot CLI API-equivalent + Infisical bake)

#1316 is merged but Coolify rolled it back: #1315 removed the UM Infisical
project UUID fallback and Infisical 404'd `projectId=undefined`.  This lane
bakes the project address again (not a secret) and adds Copilot CLI
`session.shutdown` modelMetrics as estimated API-equivalent.  Cursor and
Gemini CLI still have no local token ledger.  Receipt:
`docs/rollouts/2026-08-22-api-equivalent-copilot-infisical.md`.

## Prior (2026-08-22 GROK — API-equivalent cost for Codex + Grok Build)

Dashboard **API-Equivalent Cost** card covers every subscription seat with
model + token telemetry, not Claude-only.  Codex JSONL and Grok Build
`turn_completed` logs ingest as estimated (never cash).  Claude Code OTLP
unchanged.  Cursor has no local token ledger.  Receipt:
`docs/rollouts/2026-08-22-api-equivalent-cost.md`.  Not live until the
Infisical bake in this lane deploys.

## Current (2026-08-22 GROK — fleet projects, Manually only, workspace copy)

Visiting Projects seeds ST/CT/UM/DealDex/Personal-Site/Autorotate/ContactLogo/Fleet
(alias-safe with SocraticTrade.com).  Non-poll connectors are labeled
**Manually only** and never "need setup."  Old pollable snapshots refetch
instead of a stale alert.  Settings → Copy Workspace For Local Testing
exports secret-free JSON (Local iOS Import compatible).  Research:
`docs/research/2026-08-22-agent-subscription-telemetry.md`.  Receipt:
`docs/rollouts/2026-08-22-fleet-projects-manual-copy.md`.

## Current (2026-08-22 GROK — receipt inbox usable + Bills calendar)

Forwarded receipts now show a bounded subject/amount on Operations.  April 2026+
mail is classified onto the owner-expense ledger (due date unless cancelled;
usage on date received; domain renewals are dev expense; FMP/Massive have no
next due).  Apple Calendar subscribe URL is `GET /api/bills.ics?token=`.
Worker can call Grok then DeepSeek and POST `/api/owner-expenses`.  Receipt:
`docs/rollouts/2026-08-22-receipt-bills-calendar.md`.

## Current (2026-08-20 CURSOR — GitHub About + production docs)

Docs/metadata only.  Public GitHub About homepage was empty and the description
said "30+ API providers".  Align README, AGENTS, package metadata, and current
runbooks with live production at `usage.jays.services` on Hetzner NBG1 / Coolify.  
Cloudflare is the TLS proxy, not the host.  No invented provider counts.

## Prior (2026-08-20 CURSOR — cross-app coordination follow-ups)

Branch `cursor/cross-app-coordination-followups`.  Usage-Monitor slice of
Socratic.Trade audit #2802 §7: vendor-era shared-package pin check (UM local,
ST public npm pin, CT vendor provenance; fail if ST or CT is unreadable or
if CT reintroduces an npm dep) and a bounded `congress.trade/api/health`
liveness probe next to ST.  Last-resort / retired CT lanes do not paint
degraded.  Pin-check is intentionally not a required merge check.  Pointer
and receipt: `docs/EFFORT-LOG.md`,
`docs/rollouts/2026-08-20-cross-app-coordination-followups.md`.

## Prior (2026-08-16 GROK — ASC EULA + beta review)
# Current Handoff

## 2026-08-17 GROK — UM Client+Local 1.0.1 TestFlight via Xcode.app
Client and Local uploads succeeded (ContentDelivery UPLOAD SUCCEEDED). Marketing 1.0.1. See docs/rollouts/2026-08-17-um-xcode-testflight-101.md.
## 2026-08-17 GROK — Effort-board hygiene
In Progress rebuilt to leftover real work. Verified-merged rows moved to Completed. Landing this mirror so GitHub effort issues close.
## Current (2026-08-16 GROK — ASC EULA + beta review)

Owner-authorized ASC writes.  Usage Client and Usage Local now have custom
EULAs and filled beta App Review contacts (Jay Wedgeworth, no demo
account).  Store versions were already `1.0.0`.  What's New is blocked on
these first / REJECTED versions.  Receipt:
`docs/rollouts/2026-08-16-asc-eula.md`.

## Current (2026-08-14 GROK — four Cloudflare provider rows)

Live Provider table had **zero** cloudflare rows.  Boot now seeds four builtin
accounts: Usage.Jays.Services, Socratic.Trade, Congress.Trade, Jay Old.
Usage.Jays.Services uses `CLOUDFLARE_JAY_*` first (not ST/CT/Old).  Fleet token
is the fallback.  Adapter routes `cloudflare-*`.  mustKeepFunded stays owner-owned.

## Prior (2026-08-13 GROK — hide LLM stay-funded + fourth CF account)

Branch `grok/pickup-um-cf-accounts`, worktree `~/apps/usage-grok-pickup`.  Pickup after Monet/Claude quota cap.

- LLM/AI providers no longer show "Must stay funded".  API still accepts a later re-enable.
- Fourth Cloudflare fleet slot **Jay (Old)** (`CLOUDFLARE_OLD_ACCOUNT_ID`, fleet token).  Usage.Jays.Services / ST / CT were already wired.
- Infisical UM prod now has `CLOUDFLARE_OLD_ACCOUNT_ID` (len 32).  No token minted.

Rollout: `docs/rollouts/2026-08-13-pickup-stay-funded-and-cf-accounts.md`.

## Prior (2026-08-13 MONET — CI and iOS ship never ran on bot-merged PRs)

Branch `monet/ci-ship-trigger-bot-merge`.  A PR merged by `github-actions[bot]`
lands on `main` and dispatches **zero** workflow runs — GitHub raises no workflow
events for actions taken with `GITHUB_TOKEN`, and `auto-merge-prs.yml` arms
auto-merge with exactly that token.  PR #1145 (bot-merged, touching `ios/`)
produced no `ios-ship` run; #1159 (human merge) produced the only one this repo
has ever had.

**Review round 2 (blocker fixed before landing).**  The required `verify` job
used `needs: [schedule-gate]` with `if: should_run == '1'`.  The decide step
always exits 0, but the JOB can fail, time out, or be cancelled — and a failed
`needs:` dependency marks dependents **skipped**, which GitHub reports as a
**satisfied** required check, so a gate outage could have let a PR merge with the
whole verify suite never run.  It now uses
`!cancelled() && (event != 'schedule' || should_run != '0')`, the pattern
Socratic.Trade adopted in its PR #370.  This repo's ship wrappers exec the
**runtime** `/Users/jay/apps/ios-fleet/ship-testflight.sh`, which already carries
the fixed `ensure-tf-ready`, so no in-repo port was needed here — only
Congress.Trade keeps its own fleet copy.

Fix in three layers: both auto-merge workflows now refuse to arm without an
elevated identity (`GH_PAT` / `SHEPHERD_TOKEN` — neither exists in any fleet
repo) and print the `gh pr merge <n> --squash --auto` command instead; `ci.yml`
gains an hourly `schedule:` backstop behind a fail-closed gate job that skips
when `main`'s HEAD already has a run; `ios-ship.yml` gains
`cron: '13,43 * * * *'` plus `scripts/ios-scheduled-ship-gate.sh`, which ships
on a scheduled tick only when `ios/` actually changed since that app's last
successful ship, per app.  Without that gate a cron would ship a TestFlight
build for every backend commit — the owner does not want TestFlight spammed.

**Owner action:** add a `GH_PAT` secret to re-activate auto-merge.  Rollout:
`docs/rollouts/2026-08-13-ci-ship-trigger-bot-merge.md`.

## Prior

## Current (2026-08-12 CLAUDE — PagerDuty alert correctness)

Branch `claude/pd-alert-correctness`: zero pushed telemetry now records `unverifiable` instead of manufacturing a 100%-of-bill discrepancy (PD #64/#70 Twilio); `stale_snapshot` CLEAR stamps the same watermark as ACTIVE so resolves stop deadlocking; provider deletion resolves outstanding PagerDuty incidents first (409 + `?force=true` override). Rollout: `docs/rollouts/2026-08-12-pagerduty-alert-correctness.md`.

## Prior

## Current (2026-08-10 GROK — default light theme)

Light is product default (web ThemeProvider + iOS AppSettings). Rollout: `docs/rollouts/2026-08-10-default-light-theme.md`.

## Prior

## Current (2026-08-10 GROK — ST OOM + fleet ops visibility)

Branch `grok/st-ops-fleet-visibility`: Operations full ST health + Coolify fleet; host ST 6g + backup keep-3. Rollout: `docs/rollouts/2026-08-10-st-oom-and-fleet-ops-visibility.md`.

## Prior

## Current (2026-08-04 GROK)

- iOS TestFlight agent ship: `bash scripts/ios-ship-testflight.sh` (fleet `/Users/jay/apps/ios-fleet/README.md`).

# Status

> **Historical snapshot — 2026-07-21.** This file describes the unmerged side
> branch `codex/mobile-first-ios-parity-20260721` (native iOS parity worktree),
> not the current state of `main`. It is retained as a dated record only. For
> current production state see `main` (deployed revision: `/api/health` on
> https://usage.jays.services) and `docs/EFFORT-LOG.md`.

Updated: 2026-07-21

## Current state

- Native mobile-first work is isolated on `codex/mobile-first-ios-parity-20260721` in
  `/Users/jay/apps/usage-monitor-mobile-first`.
- The app now targets iOS 26 and retains automatic Release signing for team `CC8UTF7ATG`.
- Existing Overview, Providers, Alerts, Projects, Settings, Widget, App Lock, offline cache, and
  background-refresh surfaces are preserved. Settings now adds session-backed native provider and
  subscription management without storing the dashboard password.
- `GET /api/budget-status` accepts either the dedicated read bearer or a verified dashboard session;
  mutations remain session-only.
- No Oracle, DNS, writer, scheduler, production data, provider, or secret mutation occurred.

## Native hardening and management

- Candidate read tokens are verified in a cookie-free disposable session, so an existing dashboard
  cookie cannot mask a bad replacement token.
- Dashboard logout deletes the local cookie even if the server is offline. Host switches clear the
  prior host's local session and token/host changes invalidate in-memory, disk, and widget money state.
- Offline budget files are versioned, identity-scoped, atomic, backup-excluded, first-unlock protected,
  size bounded, symlink rejecting, and stored with restrictive permissions.
- Native full access lists providers and tracked subscriptions, safely toggles eligible providers,
  edits or explicitly clears monthly budgets while preserving the rest of the plan, and pauses active
  subscriptions after confirmation. Successful mutations refresh the shared budget/widget state.
- Notification permission is requested only after explicit Settings opt-in. Alerts still schedule as
  **local** notifications from background refresh. Remote APNs is now a real sender: devices register
  at `POST /api/apns/device-tokens`, and budget/alert pages fan out over HTTP/2 when `APNS_*` is set.
  The checked-in entitlement stays `aps-environment=development` (App Store rewrites distribution).
  Silent `remote-notification` background mode is still omitted — these are visible alerts.

## Verification

- XcodeGen generation: passed.
- Generic iOS Simulator app/test-target `build-for-testing`: passed after the final security fixes.
- Release simulator compile: passed after fixing preview-only code that leaked into Release.
- Focused budget-route Vitest: 4/4 passed; scoped ESLint and TypeScript passed after the upstream rebase.
- `git diff --check`: passed.
- XCTest execution is blocked because this machine has no installed iOS Simulator runtime; test-target
  compilation is green.

## Remaining release stages

Open a PR, resolve hosted review/checks, merge, and verify the deployed server SHA separately.
The native binary still needs a real-device/App Store archive and TestFlight receipt before it is shipped.

## Current (2026-08-07 GROK)

- Backblaze B2 builtin provider (web + iOS Local storage inventory / catalog MTD estimate) on branch `grok/backblaze-usage-monitor`.
