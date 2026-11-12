# 2026-08-13 — CI and iOS ship never ran on bot-merged PRs

## 1. Context & Objective

A fleet audit on 2026-08-13 found that PRs merged by `github-actions[bot]` land
on `main` and dispatch **zero** workflow runs.  GitHub does not raise workflow
events for actions performed with `GITHUB_TOKEN` (its recursion guard), and this
repo's `auto-merge-prs.yml` arms auto-merge with exactly that token — so the bot
becomes the merging identity and the resulting push announces nothing.  PR #1145
(bot-merged, touching `ios/`) produced no `ios-ship` run at all; #1159 (human
merge) produced the only `ios-ship` run this repo has ever had.

Objective: give this repo triggers that survive a bot merge, and stop producing
bot merges in the first place — without letting the new scheduled path spam
TestFlight.

## 2. Changes Made

Three layers, root cause first.

**Layer 1 — stop being the bot.**  `auto-merge-prs.yml` and
`auto-merge-shared-dependency.yml` now check for an elevated merge identity
(`GH_PAT` or `SHEPHERD_TOKEN`) before arming.  Neither secret exists in this
repo today (verified by name only via `gh api repos/.../actions/secrets`), so
both workflows are now a deliberate, logged no-op: they annotate the run with
the exact `gh pr merge <n> --squash --auto` command instead.  Landing then
happens under the owner's own credentials, `merged_by` becomes
`jaywedgeworth22`, and every push workflow fires again.  Adding a `GH_PAT`
secret re-activates both workflows with no code change.

**Layer 2 — a CI backstop that a bot merge cannot suppress.**  `ci.yml` gains
`schedule: - cron: '41 * * * *'` plus a `schedule-gate` job.  For every
non-schedule event the gate votes "run" immediately and CI behaves exactly as
before.  For a scheduled tick it asks the Actions API whether this workflow
already has a run (successful, queued, or in progress) for `main`'s current HEAD
and skips when one exists, so the steady-state cost is one ~10-second hosted job
per hour.  The gate is fail-closed: any API error, empty response, or
unparseable result votes RUN.  `concurrency` is now keyed on the event as well
as the ref, so the scheduled backstop and a real push to `main` cannot cancel
each other.

**Layer 3 — an iOS ship trigger that survives a bot merge, guarded against
spam.**  `ios-ship.yml` gains `schedule: - cron: '13,43 * * * *'` (offset from
Socratic.Trade's `*/30` and Congress.Trade's `7,37` so the three fleet repos do
not start three ships on the single Mac runner in the same minute),
`fetch-depth: 0` on checkout, and a new gate step.  A cron carries no `paths:`
filter, and `ship-testflight.sh`'s own gate only tests "is HEAD the sha I last
shipped" plus a time interval — so without the new gate a backend-only commit
past the 2.5h window would ship a TestFlight build.
`scripts/ios-scheduled-ship-gate.sh` closes that: on a scheduled tick it ships
only when `ios/` actually changed between an app's last successful ship and
HEAD, **per app**, so a caught-up app is not re-shipped alongside a behind one.

The two ship steps now go through the in-repo wrappers
(`scripts/ios-ship-testflight.sh`, `scripts/ios-ship-testflight-local.sh`)
instead of calling `/Users/jay/apps/ios-fleet/ship-testflight.sh` directly, so
the workflow cannot drift from what a local operator runs and the wrappers'
stable-Xcode pin always applies.

### Review round 2 — the backstop could subtract verification

The first pass gave the required `verify` job `needs: [schedule-gate]` with
`if: needs.schedule-gate.outputs.should_run == '1'`.  The decide *step* always
exits 0, but the *job* can still fail, hit `timeout-minutes: 5`, or be cancelled
by runner/API trouble — and when a `needs:` dependency fails, every dependent job
resolves to **skipped**, which GitHub reports as a **satisfied** required check.
A gate outage would therefore have let a PR merge with the whole verify suite
never having run: the exact inverse of the backstop's purpose.  Failing closed
inside the step is not the same as failing closed at the job level.

`verify` now uses:

```yaml
if: >-
  !cancelled() &&
  (github.event_name != 'schedule' ||
  needs.schedule-gate.outputs.should_run != '0')
```

`!cancelled()` (not `always()`) so a superseded run still cancels cleanly, and
`!= '0'` so an absent or unparseable output still **runs** — only an explicit
"already verified" vote skips, and only on the scheduled path.  Congress.Trade
got the identical change; Socratic.Trade already used this pattern (its PR #370,
same reasoning).

Note this repo's ship path is unaffected by the parallel export-compliance
repair: `scripts/ios-ship-testflight.sh` and `-local.sh` exec the **runtime**
`/Users/jay/apps/ios-fleet/ship-testflight.sh`, which already carries the fixed
`ensure-tf-ready`.  Only Congress.Trade keeps an in-repo fleet copy, and that one
had to be ported explicitly.

Files touched:

- `.github/workflows/auto-merge-prs.yml`
- `.github/workflows/auto-merge-shared-dependency.yml`
- `.github/workflows/ci.yml`
- `.github/workflows/ios-ship.yml`
- `scripts/ios-scheduled-ship-gate.sh` (new)
- `scripts/test-ios-scheduled-ship-gate.sh` (new)
- `STATUS.md`, `docs/EFFORT-LOG.md`, this note

## 3. Decisions & Trade-offs

**The gate logic lives in a script, not inline YAML.**  It runs only on the one
Mac that can ship, so inline it would never be executed by CI and a defect would
surface as either TestFlight spam or a silently dead ship pipeline.  As a script
it is syntax-checked and unit-tested in `ci.yml`'s `verify` job on every PR.

**Unreachable last-ship sha falls back to the recorded timestamp.**  This repo
is the reason that branch exists.  `~/.cache/ios-fleet/last-ship-usage.txt` and
`last-ship-usage-local.txt` both record `27b89434`, the tip of the
`grok/ios-tf-runner-fix` ship worktree — not an ancestor of `main` at all, so a
sha-diff is uncomputable.  Skipping forever would be a backstop that never
backstops; shipping blind would be the spam the owner rejected.  The state file
also records a unix timestamp, so the gate asks "has any commit touching `ios/`
landed since the last successful ship" instead.  Verified read-only against the
real state files: both apps currently vote **skip**, which is correct — no iOS
commits have landed since that ship.  Once the first ship runs from the CI
workspace it records a `main`-based sha and the exact-diff path takes over.

**Layer 1 trades a silent failure for a loud one.**  With auto-merge unarmed, a
PR whose author forgets to arm it sits open.  That is visible on the PR list and
recovered with one command, which is strictly better than today's silent
unverified merge — and Layer 2 covers `main` in the meantime.

**Not done here, deliberately:** no credential was created.  The permanent fix
is an owner-supplied `GH_PAT`; the code already waits for it.

## 4. Verification State

No application code changed — the diff is CI YAML plus two new bash scripts, so
the TypeScript gates (`npm run typecheck` / `lint` / `test:coverage`) cover
nothing that moved.  What was run:

```
python3 -c "import yaml; ..."   # all four workflow files parse
bash -n scripts/ios-scheduled-ship-gate.sh
bash -n scripts/ios-ship-testflight.sh
bash -n scripts/ios-ship-testflight-local.sh
bash scripts/test-ios-scheduled-ship-gate.sh
    -> passed=13 failed=0
grep -nP '[^\x00-\x7F]' scripts/ios-scheduled-ship-gate.sh
    -> ASCII clean (Apple bash 3.2 safe)
```

The gate was also exercised read-only against the real repo and the real
`~/.cache/ios-fleet/` state (both apps -> skip, correctly), with no ship script
executed and no workflow dispatched.  CI's `verify` job now runs the same bash
tests on every PR.

## 5. Next Steps & Blockers

1. **Owner decision — add a `GH_PAT` secret** (fine-grained PAT or GitHub App
   installation token, `contents` + `pull_requests` write).  Both auto-merge
   workflows self-activate; no code change needed.  Until then, agents must land
   PRs themselves with `gh pr merge <n> --squash --auto`.
2. Watch the first scheduled `ios-ship` tick that actually ships.  It should
   record a `main`-based sha in `~/.cache/ios-fleet/last-ship-usage.txt`,
   retiring the timestamp fallback for this repo.
3. Unlike Congress.Trade, this repo keeps no in-repo copy of the fleet tooling
   and has no drift guard.  A checksum pin of the runtime
   `ship-testflight.sh` / `asc-api.mjs` / `apps.json` is the cheap version of
   that guarantee and is still unbuilt.

## 6. Zero-Code Findings

- `GH_PAT` and `SHEPHERD_TOKEN` exist in neither this repo nor Congress.Trade
  nor Socratic.Trade, so Socratic.Trade's `secrets.GH_PAT ||
  secrets.SHEPHERD_TOKEN || secrets.GITHUB_TOKEN` chain silently resolves to
  `GITHUB_TOKEN` and that repo has the identical defect.  Its `ios-ship.yml`
  cron is why it looks healthy.
- Confirmed on Congress.Trade as a control: merge sha `c38b6787`
  (`merged_by=github-actions[bot]`) produced `total_count: 0` runs, while
  `ceaca097` (`merged_by=jaywedgeworth22`) produced 10, five `event: push`.
