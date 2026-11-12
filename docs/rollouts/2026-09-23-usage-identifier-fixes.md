# 2026-09-23 — Usage identifier fixes (corrects #1524)

PR #1524 (merged 2026-09-22 as `6fa88df`) renamed the Usage-Monitor bundle IDs to `com.simplewithus.usagemonitor.*`.  This change fixes four defects in it and moves every identifier to the scheme Jay set on 2026-09-23.  The 2026-09-22 record stays in [`2026-09-22-bundle-id-migration.md`](2026-09-22-bundle-id-migration.md) with a superseded banner.

## Identifier scheme (owner, 2026-09-23)

- Base: `com.simplewithus.usage.*`.  The word "Monitor" is in display names only, never in a bundle ID.
- Domains: `usage.jays.services` is Jay's hosted instance and stays the production server.  Usage.SimpleWithUs.com is the planned public website.  There is no other Usage-Monitor domain.

| Surface | Display name | 2026-09-22 (#1524) | Now |
|---|---|---|---|
| iOS Client (main app, `UsageMonitor` target) | Usage Monitor | `com.simplewithus.usagemonitor.ios` | `com.simplewithus.usage.client` |
| iOS Local app (`LocalUsageMonitor` target) | Local Monitor | `com.simplewithus.usagemonitor.local.ios` | `com.simplewithus.usage.local` |
| iOS Widget extension | — | `com.simplewithus.usagemonitor.ios.widget` | `com.simplewithus.usage.client.widget` |
| iOS unit tests | — | `com.simplewithus.usagemonitor.ios.tests` | `com.simplewithus.usage.client.tests` |
| iOS widget unit tests | — | `com.simplewithus.usagemonitor.ios.widgettests` | `com.simplewithus.usage.client.widgettests` |
| iOS Safari host app | (unchanged) | `com.simplewithus.usagemonitor.ios.safari` | `com.simplewithus.usage.safari.ios` |
| iOS Safari extension | (unchanged) | `com.simplewithus.usagemonitor.ios.safari.Extension` | `com.simplewithus.usage.safari.ios.Extension` |
| macOS Safari host app | (unchanged) | `com.simplewithus.usagemonitor.macos.safari` | `com.simplewithus.usage.safari.macos` |
| macOS Safari extension | (unchanged) | `com.simplewithus.usagemonitor.macos.safari.Extension` | `com.simplewithus.usage.safari.macos.Extension` |
| macOS app (`macos/`, `script/build_and_run.sh`) | Usage Monitor for Mac | `com.jays.usage-monitor.mac` | `com.simplewithus.usage.macos` |
| Hetzner server | Usage Server | — | `com.simplewithus.usage.server` (reserved; no bundle today) |
| Website, if it ever needs its own ID | — | — | `com.simplewithus.usage.web` (reserved) |
| App Group | — | `group.com.simplewithus.usagemonitor` | `group.com.simplewithus.usage` |
| APNs topic (`DEFAULT_APNS_BUNDLE_ID`, `APNS_BUNDLE_ID`) | — | `com.simplewithus.usagemonitor.ios` | `com.simplewithus.usage.client` |
| BGTask / deep-link / notification identifiers | — | `com.simplewithus.usagemonitor.ios.{refresh,deeplink,account-did-change}`, `…local.ios.deeplink` | `com.simplewithus.usage.client.{refresh,deeplink,account-did-change}`, `com.simplewithus.usage.local.deeplink` |

The Safari IDs are not named in the owner's message; they follow the same base with the extension nested under its host app, as Apple requires.  Unchanged on purpose: URL schemes (`usageclientmonitor://`, `usagelocalmonitor://`), Keychain service strings (`TokenStore`, `ProviderKeychain`, macOS `com.jays.usage-monitor.mac.read-token`) and storage paths.  They are internal namespaces, not bundle IDs.

## Defects fixed

1. **Associated Domains for a domain Jay does not own.**  #1524 declared `applinks` + `webcredentials` for an unowned domain on the iOS Safari extension and told the owner to set up its DNS and AASA.  The key is removed and every mention is gone.  No replacement domain is declared: nothing serves an `apple-app-site-association` file today, and those entitlements belong on the host app, not on an extension.  If universal links or shared web credentials are wanted later, add them to the host app against a domain that actually serves an AASA.
2. **Old App Store Connect Apple IDs paired with new bundle IDs.**  `scripts/ios-fleet/apps.json` gave the new bundles the Apple IDs `6799230435` / `6799230729`.  Those records belong to the retired `services.jays.usage.*` bundle IDs, and an ASC record's bundle ID cannot be changed.  Now: `appleId: null` + `ascRecordPending: true` for `usage` and `usage-local`; `ship-testflight.sh` refuses those keys; `scripts/asc-push-listing.rb` refuses both apps (all old record IDs set to `nil`); the Local app's Learn More tab no longer links to the old App Store page.  `scripts/test-ios-fleet-appupdate-pin.sh` checks all of this and the pin (`scripts/ios-fleet.sha256`) is refreshed.
3. **Local data migration that could not work.**  `LocalDataMigration.swift` looked for `local.sqlite` in an old App Group container.  The old Local app kept it in its own sandbox (`applicationSupportDirectory/LocalUsageMonitor/local.sqlite`), which a renamed app cannot read, and its Keychain provider keys do not carry over either.  Both apps are TestFlight-only, so the helper and its call in `LocalAppModel.bootstrap()` are removed.  A renamed install starts with an empty Local store; testers re-add providers.
4. **Wrong App IDs and capability mapping in the provisioning steps.**  #1524's owner steps listed Safari extension App IDs no target uses and put the App Group and Associated Domains on the wrong iOS ID.  The correct list is below.  The iOS Safari extension's App Group entitlement is also removed: no extension code reads the group, so it only added a portal capability for nothing.

## Follow-up: macOS settings migration (post-merge review of #1525)

The macOS bundle ID change also moves `UserDefaults.standard` to the new domain.  `TokenStore` keeps the legacy Keychain service, so the token survives, but `MonitorModel` reads `displayMode`, `quotaViewLayout`, `localEnabled`, `serverEnabled`, `endpoint` and `hasSavedToken` from the new, empty domain.  An in-place `build_and_run.sh --install` would lose the server connection and saved layout.

`LegacyDefaultsMigration` in `AppDelegate.swift` runs in `UsageMonitorMain.main()` before `MonitorModel` is created.  If `migratedFromLegacyBundleID` is not set, it copies those six keys from the `com.jays.usage-monitor.mac` domain for any key missing under the new ID, then sets the marker.  It never overwrites a value already in the new domain and leaves the legacy domain in place.  This relies on the macOS app not being sandboxed: it is ad-hoc signed by the script with no entitlements.  No test added: the `UsageMonitorMenu` executable target has no test target.

## Owner steps (not done by this PR)

1. **Apple Developer Portal — register explicit App IDs:**
   - `com.simplewithus.usage.client` — capabilities: App Groups (`group.com.simplewithus.usage`), Push Notifications
   - `com.simplewithus.usage.client.widget` — App Groups (`group.com.simplewithus.usage`)
   - `com.simplewithus.usage.local` — App Groups (`group.com.simplewithus.usage`)
   - `com.simplewithus.usage.safari.ios`, `com.simplewithus.usage.safari.ios.Extension` — no extra capabilities
   - `com.simplewithus.usage.safari.macos`, `com.simplewithus.usage.safari.macos.Extension` — no extra capabilities
   - Register the App Group `group.com.simplewithus.usage`.  No App ID needs Associated Domains.
2. **App Store Connect — create new app records** for `com.simplewithus.usage.client` (Usage Monitor) and `com.simplewithus.usage.local` (Local Monitor).  Then set each `appleId` in `scripts/ios-fleet/apps.json`, drop `ascRecordPending`, update the test expectations in `scripts/test-ios-fleet-appupdate-pin.sh`, run `bash scripts/ios-fleet-pin.sh --update`, fill the new IDs into `scripts/asc-push-listing.rb` and `docs/asc/APP-STORE-LISTING.md`, and restore the App Store link in `LocalLearnMoreTab.swift`.
3. **Prod Infisical** — set `APNS_BUNDLE_ID=com.simplewithus.usage.client` once a build under that ID is installed and registering device tokens.
4. **TestFlight** — the ship workflow refuses both apps until step 2 is done.

## Not in this PR

- Developer Portal, App Store Connect, DNS/AASA, signing and TestFlight actions (owner).
- ASC listing names ("Usage Client Monitor" / "Usage Local Monitor" in `docs/asc/APP-STORE-LISTING.md` and `scripts/asc-push-listing.rb`) and in-app prose that still says those names.  Home-screen names (`CFBundleDisplayName`) now read Usage Monitor / Local Monitor; `AppProductName` reads them at runtime.
- Pre-2026-09-22 docs and older effort-log rows keep their historical IDs.
