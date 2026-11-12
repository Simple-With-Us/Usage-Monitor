# 2026-08-15 — App Store INVALID_BINARY: ship from Tahoe GM

## What happened

Usage Client Monitor and Usage Local Monitor version 1.0.0 are
`INVALID_BINARY` after the 2026-08-11 submit.  TestFlight builds stay
`VALID`.  Newer 17.0-min builds (`202608132133` / `202608132137`) exist
but were also cut on this Mac.

## Cause

The owned Mac is macOS 27.0 beta (`26A5406e`).  Apple stamps
`BuildMachineOSBuild` into the IPA.  TestFlight accepts it; App Store
review does not.  The regular `ios-ship.yml` already skips upload on a
beta host, so this runner cannot produce a store binary.

Min OS in source is already 17.0.  PrivacyInfo and App Groups were
fixed earlier.  Attaching the current VALID builds and resubmitting
would flip again.

## Fix

- Vendor `scripts/ios-fleet/` so a GitHub-hosted runner can ship
  without `/Users/jay/apps/ios-fleet`.
- Point the client/local wrappers at the in-repo script first.
- Manual workflow `.github/workflows/ios-appstore-gm.yml` on
  `macos-26` (Tahoe GM `25F84` + Xcode 26.6).

After the GM builds process as `VALID`, attach them to 1.0.0 and
submit a new review submission.  Do not resubmit a beta-host IPA.
