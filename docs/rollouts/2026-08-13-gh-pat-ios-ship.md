# GH_PAT + iOS ship path wiring (2026-08-13)

## Why

A `github-actions[bot]` squash (auto-merge armed with `GITHUB_TOKEN`) lands on
`main` and GitHub's recursion guard dispatches **no** workflows.  Measured:
UM #1145 (bot, touches `ios/`) produced no `ios-ship` run; #1159 (human) was
the only ship this repo had.  iOS-touching commits were reaching `main` and
never reaching a phone.

## What shipped

- Repo secret `GH_PAT` is now set on Usage-Monitor, Socratic.Trade, and
  Congress.Trade (sourced from the operator handoff `GITHUB_ADMIN_PAT`;
  values never printed).  Auto-merge can arm under that identity so a bot
  squash still fires `ci.yml` / `ios-ship.yml`.
- UM `ios-ship.yml` `push.paths` now includes `ios/**`, the workflow itself,
  and `scripts/ios-*.sh`.  An iOS-touching land on `main` starts the Mac
  runner archive.  The twice-hourly cron remains a backstop.
- #953 Oracle deleted-inode row is HISTORICAL (first line preserved).
  Production is Hetzner NBG1; the 2026-08-01 recovery is done.

## TestFlight

No upload from this Mac.  `/Applications/Xcode.app` is 26.6, but the host is
macOS 27.0 beta (`BuildMachineOSBuild=26A5406e`).  Earlier App Store builds
from this host were Invalid Binary.  `ios-ship.yml` now skips upload when the
host build ends in a letter-after-digits (beta).  Do not resubmit until a
stable macOS (or Xcode Cloud) archive exists.

#1167 (server-driven backup-row copy) is the Client IPA that should ride the
next stable-host ship.

## Keepouts

Did not touch Monet ST #2687 (`monet/ship-pipeline-fix`) or CT #1845/#1846.
