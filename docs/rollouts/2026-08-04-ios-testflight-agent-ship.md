# 2026-08-04 — iOS TestFlight agent ship (Usage Monitor)

> **[ARCHAEOLOGY / pre-2026-09-22]**  Bundle ID `services.jays.usage.monitor` referenced in this rollout is the pre-2026-09-22 fleet-wide bundle-ID state and has not been retconned.  Canonical IDs after the fleet-wide rename: `com.simplewithus.usagemonitor.ios` (Client), `com.simplewithus.usagemonitor.local.ios` (Local), widget `com.simplewithus.usagemonitor.ios.widget`.  See `docs/rollouts/2026-09-22-bundle-id-migration.md`.

## Context & Objective

Enable agents to push the Usage Monitor native iOS app (incl. widget extension)
to TestFlight without opening Xcode. Cross-app with Socratic.Trade and Congress.Trade.

## Changes Made

- Added `scripts/ios-ship-testflight.sh` wrapper (app key `usage`).
- Added `ios/UsageMonitor/ExportOptions-*.plist`.
- Added `ios/README.md` ship section.
- Fleet registry: `services.jays.usage.monitor` + widget extension.

## Decisions & Trade-offs

- Pure `xcodebuild` archive of scheme `UsageMonitor` (embeds widget).
- XcodeGen regenerates project unless `--skip-xcodegen`.

## Verification State

- Dry-run of fleet ship script.
- Full upload needs ASC app + API key / Xcode session.

## Next Steps & Blockers

- Owner: ASC app for `services.jays.usage.monitor` (+ widget App ID via automatic signing).
- Owner: secrets + TestFlight on phone.

## Verification receipts (2026-08-04)

- `bash scripts/ios-ship-testflight.sh --export-only` produced a signed IPA via
  `xcodebuild archive` + `exportArchive` with `-allowProvisioningUpdates`.
- Upload to TestFlight still requires App Store Connect app records + ASC API key
  at `~/.secrets/appstore-connect.env` (auth was `none` on this Mac at ship time).

### Release-build fixes included

- Wrap `ProjectBudgetEditView` previews in `#if DEBUG` (`.preview()` is DEBUG-only).
- `PushScaffold`: import `UIKit` + `Networking`; Package.swift dep on Networking.
- Indent fix for `APIClient.registerApnsDeviceToken` method.
