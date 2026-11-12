# 2026-08-17 — UM Client + Local TestFlight 1.0.1 via Xcode.app

## Context & Objective
Owner: agents can build with normal Xcode on this Mac. Invalid Binary was parked on “beta host.” Un-park and ship both Usage apps.

## Changes Made
- `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` (Xcode 26.6).
- Cleared a stale `archive.lockdir` from Aug 16 (no live `xcodebuild`).
- Client: `1.0.1 (202608172057)`. Archive succeeded. Upload succeeded 16:08 and again 18:56 (`UPLOAD SUCCEEDED`).
- Local: upload succeeded 19:01.
- ASC `GET /v1/apps` was HTTP 500 at ship start, so marketing was forced with `--version 1.0.1`.

## Decisions & Trade-offs
Did not wait for GitHub `macos-26` GM. Owner said use this Mac. Apple may still stamp `BuildMachineOSBuild` from macOS 27; watch processing on 1.0.1.

## Verification State
- ContentDelivery logs: `UPLOAD SUCCEEDED with no errors` for Client and Local.
- last-ship files written 18:58 (Client) and 19:02 (Local).

## Next Steps & Blockers
Attach VALID 1.0.1 builds to the App Store versions once ASC finishes processing. Hygiene mirror #1233 still needs a green verify (`npm audit` high on prisma/deepmerge-ts at first run).

## Zero-Code Findings
None beyond ASC list 500.
