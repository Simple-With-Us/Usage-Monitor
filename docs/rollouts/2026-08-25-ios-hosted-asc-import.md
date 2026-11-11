# 2026-08-25 -- hosted macos-latest ASC import for ios-ship

## Context & Objective

Scheduled / push `ios-ship` run
[32795404598](https://github.com/jaywedgeworth22/Usage-Monitor/actions/runs/32795404598)
failed on GitHub-hosted `macos-latest` because
`/Users/runner/.secrets/appstore-connect.env` does not exist.  The fleet
script then could not ask App Store Connect for the next build number and
exited fail-closed.  Same class as Socratic.Trade before #3089.

This repo already vendors `scripts/ios-fleet/` and has
`scripts/ios-appstore-gm-prepare.sh` (used by the manual GM workflow).
`ios-ship.yml` never called the importer.

## Changes Made

- `.github/workflows/ios-ship.yml` imports the existing team GitHub secrets
  (`ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8`, `IOS_DIST_P12_BASE64`,
  `IOS_DIST_P12_PASSWORD`) and writes `~/.secrets/appstore-connect.env` via
  `scripts/ios-appstore-gm-prepare.sh`.  Does not use `secrets.*` in `if:`
  (GitHub dispatch parser rejects that).
- Restore `~/.cache/ios-fleet` with `actions/cache` so hosted cron ticks
  keep last-ship state.
- Pin in-repo `scripts/ios-fleet` with `scripts/ios-fleet-pin.sh`.
- Gate and ship Usage Client Monitor only.  LocalUsageMonitor stays skipped.
- Wrappers prefer in-repo `scripts/ios-fleet/` and refuse the Mac host path
  when `GITHUB_ACTIONS` is set.

## Decisions & Trade-offs

- Followed Congress.Trade + Socratic.Trade #3089: in-repo fleet, existing
  team secret names, no new App Store Connect key, no `--force-ship`, keep
  `macos-latest`.  The five secrets were already on this repo (2026-08-15)
  for the GM ship workflow.
- Did not start a TestFlight upload for LocalUsageMonitor.

## Verification State

- `bash -n` on the ship wrappers, prepare script, pin script, and gate
- `bash scripts/ios-fleet-pin.sh --check`
- `bash scripts/test-ios-scheduled-ship-gate.sh`

## Next Steps & Blockers

After merge, the next `ios-ship` tick (push of this workflow or cron
`13,43 * * * *`) runs **Import signing + ASC key**, which writes
`~/.secrets/appstore-connect.env` from the five existing repo secrets, then
ships Usage Client Monitor with the in-repo fleet script.

## Apple Notes handoff (Mac-only publication)

Title: `[UM, Grok] hosted ios-ship ASC import`

Body:

```
Tue, Aug 25, 12:56am

Usage-Monitor ios-ship 32795404598 failed on hosted macos-latest:
missing ~/.secrets/appstore-connect.env (same class as ST before #3089).

Fix: import existing team ASC/P12 GitHub secrets via
scripts/ios-appstore-gm-prepare.sh.  In-repo scripts/ios-fleet.  Cache
~/.cache/ios-fleet.  LocalUsageMonitor stays skipped.  No new key.  No
--force-ship.  Keep macos-latest.

Next tick writes appstore-connect.env from ASC_KEY_ID / ASC_ISSUER_ID /
ASC_KEY_P8 / IOS_DIST_P12_BASE64 / IOS_DIST_P12_PASSWORD, then ships
Usage Client Monitor.
```
