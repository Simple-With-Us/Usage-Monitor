# 2026-09-18 - effort-issues-sync-monitor-margin

## Context & Objective

Sentry issue **FLEET-INFRA-CF** (`https://jays-services.sentry.io/issues/7708975318/`)
regressed again at 2026-09-18T06:27Z as `Cron failure: ci-usage-monitor-effort-issues-sync` /
`A missed check-in was detected`.  The daily effort-board mirror is healthy.
GitHub's `schedule` trigger for `.github/workflows/effort-issues-sync.yml` is
delivered hours late, so the 15-minute Crons margin is structurally guaranteed
to page every day.  Goal: stop that false page without changing the sync
cron, the sync script, TestFlight, or Coolify.

## Changes Made

Widened the Sentry Crons `checkin_margin` for workflow `Effort Issues Sync`
from 15 minutes to 600 minutes (10h) in `CHECKIN_MARGIN_OVERRIDES` inside
`scripts/sentry-ci-report.py`.  Existing overrides stay (`CI` 480,
`iOS TestFlight ship (Mac runner)` 480).  The workflow crontab (`12 6 * * *`)
and `scripts/sync-effort-issues.py` are unchanged.

Evidence:

- Monitor `ci-usage-monitor-effort-issues-sync` (`fc1753b5-97d0-4f96-882c-925b88786d9b`):
  crontab `12 6 * * *`, `checkin_margin` 15, `max_runtime` 60.  16 missed
  events since 2026-09-03, one per day at 06:27Z.  0 users.  Seer
  actionability super_low.  Every day misses at 06:27Z and auto-resolves
  when the late OK lands (~10:29-12:36Z).
- Scheduled Actions runs (`gh run list --workflow effort-issues-sync.yml`)
  all start late, then finish in ~15-19s on `ubuntu-latest`.  September
  starts: 09-17 11:34, 09-16 11:24, 09-15 11:37, 09-14 12:36, 09-13 11:43
  (typical delay 4.3-6.4h).  Worst retained September: 2026-09-14 12:36Z
  (~6h 25m after the 06:12Z slot).  All retained scheduled runs are
  `success`.
- Reporter already sends `in_progress` on `workflow_run` `requested` (#1460).
  That cannot cover this: GitHub has not created the run yet at 06:27Z.
  Do not add a second in_progress path from this issue.
- Last OK 2026-09-17T11:34:16Z matches reporter `35216394926` after
  scheduled sync `35216364589` (15s success).  Requested-phase reporter
  `35216367092` opened in_progress at 11:34:06Z.  No 2026-09-18 schedule
  run existed at the 06:27Z miss.

Files touched:

- `scripts/sentry-ci-report.py` — `CHECKIN_MARGIN_OVERRIDES["Effort Issues Sync"] = 600`
- `scripts/test-sentry-ci-report.py` — AST parse of the override + cron
- `STATUS.md` / `docs/EFFORT-LOG.md` — handoff rows
- `docs/rollouts/2026-09-18-effort-issues-sync-monitor-margin.md` — this note

## Decisions & Trade-offs

600 minutes matches Socratic.Trade #3194 / #3387 / #3389 and Autorotate
#219, and sits above the measured September 6h 25m worst delay while still
paging ~16:12Z if the daily sync never starts.  Effort-board mirroring is
not RTH-critical; a 4-6h GitHub delay still lands the same day.

Two late-August outliers (08-27 17:35Z ~11.4h, 08-28 18:36Z ~12.4h) exceed
600.  They predate the current September 4.3-6.4h band.  Keep 600 to match
the daily-cron fleet standard rather than hide a 12h GitHub stall.

Do not copy this onto 30-min macos iOS-ship crons (FLEET-INFRA-CC / DA / CX).
UM's own iOS-ship override stays 480.

Deliberately NOT `"Fixes FLEET-INFRA-CF"`: the 600-minute config only
upserts on the next scheduled check-in.  Resolve CF after that monitor
lands `ok` under the new margin.  Tomorrow 06:27Z will still miss if this
merges today, until ~10:29-12:36Z upserts the new margin.

Out of scope: changing `effort-issues-sync.yml`, the sync script, adding
another `in_progress` path, and dispatching this workflow.

## Verification State

```
python3 -m py_compile scripts/sentry-ci-report.py   # clean
python3 scripts/test-sentry-ci-report.py
# MARGIN_PARSE_OK {'CI': 480, 'iOS TestFlight ship (Mac runner)': 480, 'Effort Issues Sync': 600}
# EFFORT_SYNC_CRON_OK 12 6 * * *
# test-sentry-ci-report.py: PASSED
```

Did not run the full `npm run verify` chain.  `test:sentry-ci-report` is
already the first verify / CI step and is unchanged in wiring.  Did not
`workflow_dispatch` `effort-issues-sync.yml`.  Did not PUT the Sentry
monitor by hand; the next scheduled check-in upserts the new margin.

## Next Steps & Blockers

After merge, wait for the next scheduled tick to upsert
`ci-usage-monitor-effort-issues-sync` at 600, then ignore/resolve CF.
Do not rematch with a second margin PR.
