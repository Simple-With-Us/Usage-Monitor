# 2026-08-31 — /api/health r2Weekly + replica-status probe cost trim

## Context & Objective

Two independent asks landed together: (1) `/api/health` exposed no backup status at
all, unlike Socratic.Trade and Congress.Trade's `checks.storage.r2Weekly`, so no
external monitor or peer-fleet parser could read Usage Monitor's weekly R2 archive
freshness off its public health path; (2) the host systemd timer
`usage-monitor-replica-status` (every 10 min) was driving ~720 Backblaze Class C
LIST calls/day for a probe that spent most of that budget on redundant work — an
in-container heartbeat attempt that always fails on this infra, and an unconditional
5 LTX-level listing per tick when far fewer usually suffice.

## Changes Made

### 1. `checks.storage.r2Weekly` on `/api/health`

- Added `getPublicR2WeeklyHealth()` (`src/lib/runtime-health.ts`), a thin public-safe
  wrapper around the existing `getR2WeeklyArchiveStatus()` (already used by the
  session-gated operations card).  Shape: `{ok, key, ageSeconds, staleness, reason}`.
  `ok` requires the weekly archive job's own `ok:true` **and** `completedAt` inside
  the existing 8-day freshness window -- both already enforced inside
  `getR2WeeklyArchiveStatus`, so this wrapper adds no new freshness logic, only a
  public-safe reshaping.  A missing or unreadable receipt collapses to a single
  `reason: "no_receipt"` (the internal `archive_status_unreadable` / never-run
  distinction is operator detail, not something an unauthenticated endpoint needs).
- Wired it into `GET /api/health` (`src/app/api/health/route.ts`) under
  `checks.storage.r2Weekly`.
- Tests: `src/lib/__tests__/runtime-health.test.ts` (no_receipt / unreadable / fresh /
  stale-by-age / stale-by-job-failure cases) and a new
  `src/app/api/health/__tests__/route.test.ts` exercising the route end-to-end.

This work was already complete and committed-in-progress on this branch from a
prior session before this one picked it up; it was reviewed here and found correct
as-is (see Decisions & Trade-offs).

### 2. `replica-status-probe.sh` cost trim (host systemd timer)

- `deploy/coolify/replica-status-probe.sh`: removed the in-container
  `docker exec ... replica-status-heartbeat.sh --once` attempt entirely.  On Coolify
  a bare `docker exec` never carries the Infisical-injected `LITESTREAM_S3_*` env
  (the script's own header already documented this), so that attempt failed with
  `replica_credentials_missing` on every single tick and the host script always fell
  through to the env-file fallback anyway -- it was pure overhead (one wasted
  `docker exec` + bash spawn per tick), never a real fallback candidate.  The probe
  now goes straight to the host env-file LTX fallback.
- Same file: trimmed the fallback's `litestream ltx -level N` calls from an
  unconditional `(0, 1, 2, 3, 9)` scan every tick to an **adaptive escalation**: try
  level 0 alone first (the common case -- replication actively writing -- resolves in
  a single call), and only escalate to levels 1-3, then 9 as a last resort, when
  level 0 comes back empty/erroring/timed-out.  This is the change that actually
  moves the Backblaze Class C bill: 5 LIST calls/tick -> 1 call/tick in the steady
  state, up to 5 only during the rare escalation.
- `deploy/coolify/usage-monitor-replica-status.timer`: cadence widened
  `OnUnitInactiveSec=10min` -> `OnUnitActiveSec=30min` (per explicit request), still
  comfortably inside the 3-hour `LITESTREAM_REPLICA_MAX_AGE_SECONDS` staleness
  budget.  Combined with the level-escalation trim, the daily call volume for this
  probe drops from ~720/day (5 calls x 144 ticks/day) to roughly 48-96/day (1-2 calls
  x 48 ticks/day, depending how often escalation triggers) -- at least a ~7.5x cut,
  more in the steady state.
- `deploy/coolify/usage-monitor-replica-status.service`: updated the stale "five
  70-second listings" comment to match the new adaptive call count;
  `TimeoutStartSec=480` is untouched (already generous headroom).
- `scripts/test-replica-status-probe.sh`: replaced the assertions that pinned the old
  two-path fallback design (heartbeat exit-code gate, mtime-refresh preference, "must
  still reach --env-file fallback" wording) with assertions for the new single-path
  design -- no `run_in_container_heartbeat` reference, no live `docker exec ...
  replica-status-heartbeat.sh` invocation, a `probe_level` escalation helper exists,
  level 0 is tried first, levels 1-3 are the escalation path (explicitly asserted
  against reverting to a bare `{0,9}` tuple), level 9 is last-resort only, and the
  timer carries `OnUnitActiveSec=30min` (not the old `OnUnitInactiveSec=10min`).
  Also added a **functional self-test**: it `exec`s the actual escalation source
  pulled live out of `deploy/coolify/replica-status-probe.sh` (not a hand-copied
  reimplementation) against a mocked `subprocess.run`, asserting the exact call
  sequence and resulting timestamp for three scenarios (L0 has data / L0 empty
  escalates to L1 / full escalation falls back to the L9 snapshot).  This is what
  actually caught the `nonlocal`-with-no-enclosing-function mistake described below
  -- `bash -n` and every textual grep were blind to it.  All existing secret-safety
  assertions (`--env-file`, no `-e KEY=VALUE` on `docker exec` argv, no plaintext
  `LITESTREAM_S3_*` in argv) are unchanged.
- `docs/runbooks/replica-status-probe.md`: updated the architecture table, "Host
  oneshot order" section, "What it lists" table, and the pitfalls list to describe
  the new single-path, adaptive-escalation design instead of the retired two-path
  one, and added a pitfall specifically warning against re-dropping levels 1-3.
  `deploy/oracle/**` (legacy, not live production per its own README) was left
  untouched -- out of scope.

Files touched:
- `src/lib/runtime-health.ts`
- `src/app/api/health/route.ts`
- `src/lib/__tests__/runtime-health.test.ts`
- `src/app/api/health/__tests__/route.test.ts` (new)
- `deploy/coolify/replica-status-probe.sh`
- `deploy/coolify/usage-monitor-replica-status.timer`
- `deploy/coolify/usage-monitor-replica-status.service`
- `scripts/test-replica-status-probe.sh`
- `docs/runbooks/replica-status-probe.md`

## Decisions & Trade-offs

- **The first pushed version of the level trim was wrong, and a code-review bot
  caught it before merge.**  PR #1378 initially queried only levels {0, 9}
  unconditionally, on the (incorrect) reasoning that levels 1-3 were "coarser
  compactions of the same stream" that could never add a freshness signal level 0
  didn't already have.  `chatgpt-codex-connector`'s automated review flagged that
  litestream's L0 retention is brief, so a compaction can legitimately leave L0
  empty for a beat with no new writes since, while the real continuous tip already
  sits at L1-L3 -- and pointed at this exact codebase's own
  `deploy/oracle/deploy-production.sh` `verify_backup_path` /
  `list_garage_ltx_level`, whose comments say exactly that ("Fall back L1..L5 when
  L0 is pruned during quiet periods") and which the in-container heartbeat's
  `CONTINUOUS_LEVELS=(0 1 2 3)` also already guards against.  An unconditional
  `{0,9}`-only scan would have reintroduced a previously-fixed false-staleness bug
  class into the host probe.  Verified the claim against that legacy script's
  comments before accepting it, then replaced the fixed-tuple scan with the
  adaptive `probe_level` escalation described above and added the functional
  self-test to keep the regression from coming back silently.  Left the
  auto-merge-armed PR blocked (this repo requires review-conversation resolution
  before merge, which caught this automatically) while the fix landed as a second
  commit on the same branch/PR rather than a follow-up.
- **Did not touch the in-container looping heartbeat's own level set**
  (`scripts/replica-status-heartbeat.sh`, `CONTINUOUS_LEVELS=(0 1 2 3)` +
  `SNAPSHOT_LEVEL=9`).  That loop runs continuously inside the app container
  (started by `start-with-litestream.sh`, which *does* inherit the
  Infisical-injected env) and is a separate cost surface from the host timer this
  task scoped in on.  The task's own math (~720 calls/day = 5 calls x 144
  ticks/day) accounts for the host timer's fallback alone, so widening scope to
  the in-container loop was not part of the ask.
- **Removed the in-container heartbeat attempt outright rather than adding a
  skip-flag.**  Coolify's env-injection-into-process-tree-only architecture is
  structural, not a transient condition, so there is no scenario on this infra
  where a bare `docker exec` would succeed.  A flag to re-enable it would be dead
  configuration surface for a path that can never work here; if the infra ever
  changes, this is a one-line revert away in git history.
- **Left `deploy/oracle/**` untouched.**  Its own README already states "LEGACY --
  not live production"; changing it would be scope creep on dead infrastructure --
  though its `verify_backup_path` comments were exactly what caught the level-set
  mistake above, which is a good argument for not deleting it either.
- **Left `TimeoutStartSec=480` in the `.service` file unchanged.**  Even the
  worst-case 5-call escalation (5 x 70s timeout + `docker top`/PID-environ
  overhead) comfortably clears well under 480s; tightening it has no cost benefit
  (it only bounds worst-case duration, not call count) and reduces the safety
  margin for no reason.
- **Item 1 (r2Weekly health block) was found already complete on this branch** from
  a killed prior session's uncommitted work.  It was reviewed line-by-line against
  `getR2WeeklyArchiveStatus`'s actual freshness/reason semantics and against how
  Socratic.Trade and Congress.Trade shape their own `checks.storage.r2Weekly`
  (`{ok, ageSeconds, key, reason}` -- no `staleness` field in either).  The extra
  `staleness` field here is additive, not a shape mismatch: this repo's own
  `fleet-backup-status.ts` peer parser (which reads *other* apps' `r2Weekly`) only
  ever consumes `ok` / `ageSeconds` / `reason`, so nothing downstream depends on the
  field sets matching exactly.  No code changes were needed for item 1 beyond
  verification.

## Verification State

Ran from `/Users/jay/apps/usage-claude-backup-probe` on Node 24.20.0
(`/opt/homebrew/opt/node@24/bin` -- the repo pins `"node": ">=24.14.0 <25"` in
`package.json`, and the Mac's default `node` is v26, which risks native-module ABI
mismatches):

```bash
npm ci
npm run lint            # 0 errors, 12 pre-existing warnings (unrelated files)
npm run typecheck       # clean
npm test                # 2338 passed | 1 skipped (200 files)
npm run test:receipt-inbox-worker   # 8 passed
npm run test:migrate-safe           # all 5 scenarios PASSED
npm run test:sqlite-backup          # passed
npm run test:r2-archive             # 18 passed, 0 failed
npm run test:startup-config         # passed
npm run test:oracle-deploy          # passed
npm run test:apple-projects         # native iOS/Safari builds all succeeded (see note)
npm run test:antigravity-collector  # passed
npm run test:session-token-collectors  # passed
npm run test:cf-token-map           # passed
npm run test:replica-status-probe   # passed (updated + new functional self-test)
npm run build                       # next build succeeded (Turbopack tracing
                                     # warnings are pre-existing, unrelated files)
```

Note on `test:apple-projects`: this step runs real `xcodebuild` locally when
`xcodebuild` is present (this repo's `AGENTS.md` "iOS agent build loop" explicitly
pre-approves that, unlike some sibling apps).  The first local attempt showed
`BUILD FAILED` with a build-database disk I/O error -- traced to two concurrent
`bash scripts/verify-apple-projects.sh` invocations racing on the same shared
`$RUNNER_TEMP/usage-monitor-apple-derived` directory (self-inflicted by running it
twice in parallel while investigating a timeout, not a real defect).  A single
clean re-run passed end-to-end (app debug + release, `UsageMonitorKit` package,
both Safari extension targets).  No iOS/Swift files were touched by this change;
CI's own `verify` job runs this step on `ubuntu-latest` where `xcodebuild` is
absent, so it just verifies file structure there.

Additionally verified the escalation logic itself in isolation before and after
the review-bot fix: a standalone Python harness (same technique now embedded
permanently in `scripts/test-replica-status-probe.sh`) confirmed (a) the
originally-pushed `{0,9}`-only design really would silently misreport a healthy
replica as stale whenever L0 is empty, (b) the corrected adaptive design resolves
in exactly 1 call when L0 has data, correctly escalates through 1-3 and finds the
real tip when L0 is empty, and correctly falls back to the L9 snapshot only when
no continuous level has data, and (c) the new self-test genuinely fails (a Python
`SyntaxError`, not a silent pass) when the `nonlocal`-without-enclosing-function
mistake is reintroduced -- confirmed by deliberately reintroducing it, watching
the test fail with the exact error, then restoring the fix.

`npm run verify`'s full chain was exercised piecewise above rather than as one
invocation (its final composed command is exactly the same steps in the same
order).

## Next Steps & Blockers

- After merge, per fleet rules: SSH to `root@100.69.77.26`, back up then sync
  `/usr/local/sbin/usage-monitor-replica-status` from the merged `main`, `bash -n`
  it, sync the `.timer`/`.service` units, `systemctl daemon-reload` (unit files
  changed), run the probe once manually to prove a clean tick, and confirm the
  journal verdict line.  See the receipts in the closing chat message for the
  actual host commands run and their output.
- No further code changes anticipated for this lane.  The in-container heartbeat's
  own cost profile (continuous, 5 levels every tick, real credentials) was
  explicitly left alone -- flag if the owner wants that trimmed too in a follow-up
  (same adaptive-escalation pattern would apply there too, if wanted).
