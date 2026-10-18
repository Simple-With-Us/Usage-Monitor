# 2026-10-17 - Usage Monitor iOS auto-ship (manual App Store signing)

Goal (owner, 2026-10-17): a merge to main that touches the iOS tree uploads a fresh TestFlight build with no human step, for both apps (Usage Monitor Client, Usage Monitor Local).

## What was actually wrong

`ios-ship.yml` already followed the fleet standard (push to main with a paths filter, `workflow_dispatch`, a gated cron backstop, `fetch-depth: 0`, the in-repo ship script, `ensure-tf-ready`, mandatory What to Test, Fleet-OPS `/asc` credentials).  The audit's headline was right and its cause was only the first of four:

1. **Workflow disabled.**  It sat `disabled_manually` after the 2026-09-27 failures ("no App Store Connect record yet").  #1652 fixed the cause (apps.json now points at the live `.ios` records, 6820881005 client and 6820885210 local) but nobody turned the workflow back on, so merges such as #1683 reached main and shipped nothing.
2. **Automatic signing cannot work on a hosted runner.**  Xcode 26 automatic signing talks to `developerservices2.apple.com`, where the fleet App Store Connect key gets HTTP 401 (Socratic Trade run notes, 2026-09-30).  Re-enabling alone would have failed at archive on every tick.
3. **No App Store profiles existed for the new App IDs.**  The App IDs `com.simplewithus.usage.client.ios`, `.client.ios.widget` and `.local.ios` were registered, with no profiles.
4. **The App Group is not assigned to the three App IDs (owner action, below).**  Profiles generated from them carry an empty `com.apple.security.application-groups` list, while the Client, Widget and Local entitlements all declare `group.com.simplewithus.usage`.  The App Store Connect API cannot assign an App Group.

The App Store Connect records exist (`asc-status-audit`: both new records are PREPARE_FOR_SUBMISSION), so no record had to be created and none was touched.

## What this change does

- `ios/UsageMonitor/appstore-profiles.json` maps the three bundle IDs to three App Store profiles, created over the App Store Connect API with the one active distribution certificate:

  | Bundle ID | Profile name | Profile id |
  |---|---|---|
  | `com.simplewithus.usage.client.ios` | Usage Monitor Client App Store (API) | 5T2YTQ3769 |
  | `com.simplewithus.usage.client.ios.widget` | Usage Monitor Client Widget App Store (API) | M26QR35ARR |
  | `com.simplewithus.usage.local.ios` | Usage Monitor Local App Store (API) | JJSF8BZQQG |

- `ios/UsageMonitor/project.yml` signs Release manually per target (Apple Distribution plus the profile name).  Debug stays Automatic.  `UsageMonitor.xcodeproj` was regenerated with xcodegen 2.46.0, never hand-edited.
- `scripts/ios-install-appstore-profiles.sh` downloads and installs the mapped profiles.  It fails closed on a wrong or inactive profile, a development profile, or a missing signing identity, and with `IOS_PROFILE_REQUIRE_APP_GROUPS` it fails with the exact portal step when a profile lacks the App Group.
- `scripts/ios-fleet/ship-testflight.sh` (vendored, pin refreshed) gains the manual-signing path Socratic Trade uses: install profiles, archive without `-allowProvisioningUpdates`, write a manual ExportOptions plist from the map, export the IPA, upload with `altool`.
- `ios-ship.yml` sets `IOS_MANUAL_SIGN=1` and the required App Group on both ships, adds an `export_only` dispatch input for signing checks, collects redacted ship logs on failure, and gates the Client and Local steps independently.
- `scripts/test-ios-manual-signing.sh` (run by CI) pins the map, `project.yml`, the pbxproj and the workflow together and drives the installer against stubs.

Unchanged on purpose: the rate gate (`DEFAULT_MIN_INTERVAL_SEC`) and the same-HEAD skip stay at their defaults, and no workflow sets `IOS_TF_MIN_INTERVAL_SEC`.

## Owner action (one time)

In the Apple Developer Portal, Identifiers: open each of `com.simplewithus.usage.client.ios`, `com.simplewithus.usage.client.ios.widget` and `com.simplewithus.usage.local.ios`, tick App Groups, Configure, and select `group.com.simplewithus.usage` (register it first if the group list does not show it).  Save.

Then the three "(API)" profiles above must be regenerated, because a profile is a snapshot taken before the group was assigned.  Delete the three profiles in the portal (or ask an agent to) and create them again with the same names over the API (`POST /v1/profiles`, type `IOS_APP_STORE`, the active DISTRIBUTION certificate).  The installer keeps the latest-expiring ACTIVE profile of a name, so removing the stale ones matters.

Until this is done, every ship run stops at "Install App Store profiles" with a message naming the missing group.  That is by design: the entitlement is not removed to get a green build, because the widget and the Local app read the shared container.

## Verification

- Offline: `bash scripts/test-ios-manual-signing.sh` (11 checks), `bash scripts/ios-fleet-pin.sh --check`, and the existing gate, key-staging and AppUpdatePrompt tests.
- Trigger proof: see the PR description for the dry reading of `on.push.paths` against the last iOS commit.
