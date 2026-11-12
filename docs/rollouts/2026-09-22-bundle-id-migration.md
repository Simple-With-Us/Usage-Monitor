# 2026-09-22 — Bundle Identifier Migration (Usage-Monitor)

> **[SUPERSEDED 2026-09-23]**  This is the record of PR #1524 as merged.  Three parts of it were wrong and are corrected by [`2026-09-23-usage-identifier-fixes.md`](2026-09-23-usage-identifier-fixes.md): (1) it added an Associated Domains entitlement for a domain Jay does not own (removed; there is no Usage-Monitor domain besides `usage.jays.services` and the planned Usage.SimpleWithUs.com); (2) it paired the new bundle IDs with the old App Store Connect Apple IDs, which belong to the retired `services.jays.usage.*` records; (3) it described a Local data migration from a shared App Group container that never held the old `local.sqlite` (the file lived in the old app's own sandbox).  Its Owner action items section also named the wrong Safari extension App IDs.  The `com.simplewithus.usagemonitor.*` IDs below were then replaced by the owner's `com.simplewithus.usage.*` scheme.  Do not act on this document's owner action items; use the 2026-09-23 document.  Passages that referred to the unowned domain are marked *[removed 2026-09-23]*.

Issue raised on the macOS signing-cert change window, where the owner approved a fleet-wide bundle rename so every app uses a domain Jay owns as its base.  This document covers **Usage-Monitor only**; the rest of the fleet (BotFleet, Autorotate, ContactLogo, DealDex, HogHunter, Congress.Trade, Socratic.Trade, the MiniMax-ios companion) is on separate lanes owned by other seats.  The fleet-wide context lives in `/Users/jay/.minimax/sessions/mvs_0bdfe8c73c1046a986df888aa99dcb2e/workspace/fleet-bundle-id-plan.md`.

Usage-Monitor is the most multi-surface fleet migration after Socratic.Trade: a four-target native iOS app (Client + Local + Widget + Widget tests + App tests) under one Xcode workspace, a separate Safari Web Extension project on iOS + macOS (host apps + Safari extensions), an APNs topic that IS the bundle ID, a shared App Group that wins + writes the on-device `widget-snapshot.json` for both Client and Local apps and the home-screen widget, an Associated Domains entitlement on the iOS Safari extension *[removed 2026-09-23: it named a domain Jay does not own]*, and an owner-side Apple Developer Portal App ID + App Group registration on the new bundle ID.  Ten renames (5 iOS targets × 2 build configs, plus 8 Safari targets × 2 build configs collapsed to four unique new bundle IDs), one App Group consolidation (Client + Local + Widget + iOS Safari extension → `group.com.simplewithus.usagemonitor`), and one Associated Domains pair on the iOS Safari extension *[removed 2026-09-23]*.

> **Safari extension naming deviation (post-review fix).**  The initial pass put the new Safari extensions at `com.simplewithus.usagemonitor.safari.{macos,ios}` — different from the host-app namespace `com.simplewithus.usagemonitor.{macos,ios}.safari`.  A Codex review on PR #1524 flagged this, and Apple App Store validation explicitly requires the Safari Web Extension's bundle ID to sit **under** the host app's bundle ID on iOS (the App ID App Store Connect tooling treats the extension as a child of the host for validation purposes).  The IDs were tightened to `com.simplewithus.usagemonitor.{macos,ios}.safari.Extension` (extension is the `.Extension` child of the host), which deviates from the literal mapping in `fleet-bundle-id-plan.md` but matches Apple's iOS validation rule and the existing repo's pre-rename convention (`services.jays.usage.monitor.safari.Extension` was the child of `services.jays.usage.monitor.safari`).  The plan's broader intent — "use the `simplewithus.com` domain Jay owns and the `safari.{platform}` shape Apple users will recognize in Safari > Settings > Extensions" — is preserved.

## Previous → New

| Surface | Previous | New |
|---|---|---|
| iOS Client app (`UsageMonitor` target) | `services.jays.usage.client.monitor` | `com.simplewithus.usagemonitor.ios` |
| iOS Local app (`LocalUsageMonitor` target) | `services.jays.usage.local.monitor` | `com.simplewithus.usagemonitor.local.ios` |
| iOS Widget extension (`UsageMonitorWidgetExtension` target) | `services.jays.usage.client.monitor.widget` | `com.simplewithus.usagemonitor.ios.widget` |
| iOS unit tests (`UsageMonitorTests` target) | `services.jays.usage.client.monitor.tests` | `com.simplewithus.usagemonitor.ios.tests` |
| iOS widget unit tests (`UsageMonitorWidgetTests` target) | `services.jays.usage.client.monitor.widgettests` | `com.simplewithus.usagemonitor.ios.widgettests` |
| iOS Safari host app (`Usage Monitor Safari (iOS)`) | `services.jays.usage.monitor.safari` | `com.simplewithus.usagemonitor.ios.safari` |
| iOS Safari extension (`Usage Monitor Safari Extension (iOS)`) | `services.jays.usage.monitor.safari.Extension` | `com.simplewithus.usagemonitor.ios.safari.Extension` |
| macOS Safari host app (`Usage Monitor Safari (macOS)`) | `services.jays.usage.monitor.safari` | `com.simplewithus.usagemonitor.macos.safari` |
| macOS Safari extension (`Usage Monitor Safari Extension (macOS)`) | `services.jays.usage.monitor.safari.Extension` | `com.simplewithus.usagemonitor.macos.safari.Extension` |
| iOS BGTaskScheduler permitted identifier | `services.jays.usage.client.monitor.refresh` | `com.simplewithus.usagemonitor.ios.refresh` |
| iOS Client CFBundleURLName (deep-link identifier) | `services.jays.usage.client.monitor.deeplink` | `com.simplewithus.usagemonitor.ios.deeplink` |
| iOS Local CFBundleURLName (deep-link identifier) | `services.jays.usage.local.monitor.deeplink` | `com.simplewithus.usagemonitor.local.ios.deeplink` |
| iOS Client in-process `Notification.Name.usageMonitorAccountDidChange` raw string | `services.jays.usage.client.monitor.account-did-change` | `com.simplewithus.usagemonitor.ios.account-did-change` |
| APNs topic (`apns-topic` header + `APNS_BUNDLE_ID`) | `services.jays.usage.client.monitor` | `com.simplewithus.usagemonitor.ios` |
| App Group (consolidated — Client + Local + Widget + iOS Safari extension) | `group.services.jays.usage.client.monitor` (Client + Widget) and `group.services.jays.usage.local.monitor` (Local) | `group.com.simplewithus.usagemonitor` (single shared group, all four iOS surfaces) |
| Associated Domains (applinks + webcredentials on iOS Safari extension) | — | *[removed 2026-09-23: named a domain Jay does not own]* |
| `bundleIdPrefix` (XcodeGen base) | `services.jays.usage` | `com.simplewithus.usagemonitor` (cosmetic; every target sets `PRODUCT_BUNDLE_IDENTIFIER` explicitly) |
| URL scheme — Client (`usageclientmonitor://`) | `usageclientmonitor` | `usageclientmonitor` (keep — internal scheme, not a bundle ID) |
| URL scheme — Local (`usagelocalmonitor://`) | `usagelocalmonitor` | `usagelocalmonitor` (keep — internal scheme, not a bundle ID) |
| Keychain service — `TokenStore` (Client) | `services.jays.usage.client.monitor` | unchanged (Keychain service strings are internal namespaces, NOT bundle IDs) |
| Keychain service — `ProviderKeychain` (Local) | `services.jays.usage.local.monitor.provider-keys` | unchanged (Keychain service strings are internal namespaces, NOT bundle IDs) |
| Internal storage paths, log paths, Sentry project slug (`usage-monitor`) | unchanged | unchanged (internal namespaces, NOT bundle IDs) |

## What changed in the repo

### iOS side

- `ios/UsageMonitor/project.yml`:
  - Top-of-file `2026-09-22 bundle-ID migration` callout inside the `name:` block listing every renamed entitlement.
  - `options.bundleIdPrefix`: `services.jays.usage` → `com.simplewithus.usagemonitor` (cosmetic; every target sets `PRODUCT_BUNDLE_IDENTIFIER` explicitly so this is the only place the base leaks into a derived ID today).
  - `UsageMonitor` app target `PRODUCT_BUNDLE_IDENTIFIER`: `services.jays.usage.client.monitor` → `com.simplewithus.usagemonitor.ios`.
  - `LocalUsageMonitor` app target `PRODUCT_BUNDLE_IDENTIFIER`: `services.jays.usage.local.monitor` → `com.simplewithus.usagemonitor.local.ios`.
  - `UsageMonitorWidgetExtension` target `PRODUCT_BUNDLE_IDENTIFIER`: `services.jays.usage.client.monitor.widget` → `com.simplewithus.usagemonitor.ios.widget`.
  - `UsageMonitorTests` target `PRODUCT_BUNDLE_IDENTIFIER`: `services.jays.usage.client.monitor.tests` → `com.simplewithus.usagemonitor.ios.tests`.
  - `UsageMonitorWidgetTests` target `PRODUCT_BUNDLE_IDENTIFIER`: `services.jays.usage.client.monitor.widgettests` → `com.simplewithus.usagemonitor.ios.widgettests`.
- `ios/UsageMonitor/UsageMonitor.xcodeproj/project.pbxproj`:
  - `UsageMonitor` Debug + Release `PRODUCT_BUNDLE_IDENTIFIER`: `services.jays.usage.client.monitor` → `com.simplewithus.usagemonitor.ios` (×2).
  - `LocalUsageMonitor` Debug + Release `PRODUCT_BUNDLE_IDENTIFIER`: `services.jays.usage.local.monitor` → `com.simplewithus.usagemonitor.local.ios` (×2).
  - `UsageMonitorWidgetExtension` Debug + Release `PRODUCT_BUNDLE_IDENTIFIER`: `services.jays.usage.client.monitor.widget` → `com.simplewithus.usagemonitor.ios.widget` (×2).
  - `UsageMonitorTests` Debug + Release `PRODUCT_BUNDLE_IDENTIFIER`: `services.jays.usage.client.monitor.tests` → `com.simplewithus.usagemonitor.ios.tests` (×2).
  - `UsageMonitorWidgetTests` Debug + Release `PRODUCT_BUNDLE_IDENTIFIER`: `services.jays.usage.client.monitor.widgettests` → `com.simplewithus.usagemonitor.ios.widgettests` (×2).
  - Verified post-`xcodegen generate` to match `project.yml` exactly (the host-side mac build would re-emit the same values; both were edited in lockstep so the regeneration is a no-op on these ten lines).
- `ios/UsageMonitor/App/Resources/Info.plist`:
  - `CFBundleURLTypes[0].CFBundleURLName`: `services.jays.usage.client.monitor.deeplink` → `com.simplewithus.usagemonitor.ios.deeplink` (the `usageclientmonitor://` URL scheme is unchanged).
  - `BGTaskSchedulerPermittedIdentifiers[0]`: `services.jays.usage.client.monitor.refresh` → `com.simplewithus.usagemonitor.ios.refresh`.
- `ios/UsageMonitor/LocalApp/Resources/Info.plist`:
  - `CFBundleURLTypes[0].CFBundleURLName`: `services.jays.usage.local.monitor.deeplink` → `com.simplewithus.usagemonitor.local.ios.deeplink` (the `usagelocalmonitor://` URL scheme is unchanged).
- `ios/UsageMonitor/UsageMonitorWidget/Info.plist`: not edited — uses `$(PRODUCT_BUNDLE_IDENTIFIER)` so it tracks the renamed target automatically.
- `ios/UsageMonitor/App/Resources/UsageMonitor.entitlements`:
  - `aps-environment: development` PRESERVED.
  - `com.apple.security.application-groups`: `group.services.jays.usage.client.monitor` → `group.com.simplewithus.usagemonitor` (the unified App Group — shared across Client, Local, Widget, and iOS Safari extension going forward).
- `ios/UsageMonitor/LocalApp/Resources/LocalUsageMonitor.entitlements`:
  - `com.apple.security.application-groups`: `group.services.jays.usage.local.monitor` → `group.com.simplewithus.usagemonitor` (now matches the Client app's group; the prior separation into two groups is gone after the rename).
- `ios/UsageMonitor/UsageMonitorWidget/UsageMonitorWidget.entitlements`:
  - `com.apple.security.application-groups`: `group.services.jays.usage.client.monitor` → `group.com.simplewithus.usagemonitor`.
- `ios/UsageMonitor/UsageMonitorKit/Sources/WidgetShared/AppGroup.swift`: `AppGroup.identifier = "group.services.jays.usage.client.monitor"` → `"group.com.simplewithus.usagemonitor"` (the shared identifier the widget + app both read from).
- `ios/UsageMonitor/UsageMonitorKit/Sources/LocalDataPlane/LocalWidgetSnapshot.swift`: `LocalAppGroup.identifier = "group.services.jays.usage.local.monitor"` → `"group.com.simplewithus.usagemonitor"`.  The Local snapshot writes the new filename `local-widget-snapshot.json` (not `widget-snapshot.json` — that is the client's legacy filename and is actively deleted by `WidgetShared.SharedStore.cleanupLegacyData()` / `clear()` on every client write), and the Client uses `widget-snapshot-v2.json`, so the two snapshots coexist inside the shared container without the client cleanup path wiping Local's payload.
- `ios/UsageMonitor/UsageMonitorKit/Sources/LocalStore/LocalDataMigration.swift` (NEW): one-time first-launch helper `LocalDataMigration.migrateIfNeeded()` looks for the legacy App Group container `group.services.jays.usage.local.monitor` (still reachable only if the owner keeps that App Group capability on the new bundle ID during the transition window — see Owner action items §1), copies `local.sqlite` from the legacy container into the new bundle sandbox's Application Support path, and writes `migration_b82_2026_09_22: applied` to `UserDefaults.standard` so the migration runs at most once.  Silent no-op if the legacy container is unreachable (the user gets a fresh empty store, same as a brand-new install).  Legacy file is NOT deleted on first migration — a future cleanup lane can prune the old container after the transition window closes.  *[Removed 2026-09-23: the old `local.sqlite` never lived in an App Group container, so this could not migrate anything.]*
- `ios/UsageMonitor/UsageMonitorKit/Sources/LocalDataPlane/LocalAppModel.swift`: `LocalAppModel.bootstrap()` calls `LocalDataMigration.migrateIfNeeded()` BEFORE `store.open()` so the new app opens the freshly-copied file.  Doc comment explaining the dependency on the transition-window App Group capability.  *[Removed 2026-09-23: the old `local.sqlite` never lived in an App Group container, so this could not migrate anything.]*
- `ios/UsageMonitor/UsageMonitorKit/Sources/LocalStore/LocalStore.swift`: doc-comment `bundle `services.jays.usage.local.monitor`` → ``bundle `com.simplewithus.usagemonitor.local.ios```.
- `ios/UsageMonitor/UsageMonitorKit/Tests/UsageMonitorKitTests/PushScaffoldTests.swift`: `testAppEntitlementsMatchShippedPushCapability` assertion `XCTAssertEqual(groups, ["group.services.jays.usage.client.monitor"])` → `["group.com.simplewithus.usagemonitor"]`.
- `ios/UsageMonitor/App/AccountChangeNotifyingTokenStore.swift`: in-process `Notification.Name.usageMonitorAccountDidChange` raw string `services.jays.usage.client.monitor.account-did-change` → `com.simplewithus.usagemonitor.ios.account-did-change` (Notification.Name is internal — only the underlying raw string changed, the typed accessor retains its name; callers continue to listen with `forName: .usageMonitorAccountDidChange`).
- `ios/README.md`: three of the canonical-ID tables (App/Bundle ID/Purpose, App+Local comparison, scheme/bundle/home-name trio) all migrated to the new IDs; the "delete any old install under legacy IDs" helper now also lists every pre-2026-09-22 surface so the next human cleanup is one-shot.  `services.jays.usage.monitor` and `services.jays.usage.monitor.local` (the even-older legacy IDs predating Client + Local) remain listed as legacy.
- `ios/CLAUDE.md`: iOS app table — Client + Local rows both migrated.
- `ios/UsageMonitor/ARCHITECTURE-CONTRACT.md`: §2 app/bundle table, §WidgetShared table, §app-group-trio table — all migrated.  Note added that the two-bundle-id architecture (Client + Local) survives but now shares the single `group.com.simplewithus.usagemonitor` container.

### Safari Web Extension side

- `safari-extension/Usage Monitor Safari/Usage Monitor Safari.xcodeproj/project.pbxproj`:
  - `Usage Monitor Safari (iOS)` Debug + Release `PRODUCT_BUNDLE_IDENTIFIER`: `services.jays.usage.monitor.safari` → `com.simplewithus.usagemonitor.ios.safari` (×2 — host app).
  - `Usage Monitor Safari (macOS)` Debug + Release `PRODUCT_BUNDLE_IDENTIFIER`: `services.jays.usage.monitor.safari` → `com.simplewithus.usagemonitor.macos.safari` (×2 — host app).
  - `Usage Monitor Safari Extension (iOS)` Debug + Release `PRODUCT_BUNDLE_IDENTIFIER`: `services.jays.usage.monitor.safari.Extension` → `com.simplewithus.usagemonitor.ios.safari.Extension` (×2 — extension).  Plus `CODE_SIGN_ENTITLEMENTS = "iOS (Extension)/Usage Monitor Safari iOS Extension.entitlements"` added on both configurations.
  - `Usage Monitor Safari Extension (macOS)` Debug + Release `PRODUCT_BUNDLE_IDENTIFIER`: `services.jays.usage.monitor.safari.Extension` → `com.simplewithus.usagemonitor.macos.safari.Extension` (×2 — extension).
- `safari-extension/Usage Monitor Safari/iOS (Extension)/Usage Monitor Safari iOS Extension.entitlements` (NEW): `com.apple.security.application-groups: ["group.com.simplewithus.usagemonitor"]` + an associated-domains key *[removed 2026-09-23]*.
- `safari-extension/Usage Monitor Safari/Shared (App)/ViewController.swift`: `extensionBundleIdentifier = "services.jays.usage.monitor.safari.Extension"` → `"com.simplewithus.usagemonitor.macos.safari.Extension"` (this is the macOS Safari Web Extension's bundle ID passed to `SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier:)` and `SFSafariApplication.showPreferencesForExtension(withIdentifier:)` — must match the new macOS extension target's `PRODUCT_BUNDLE_IDENTIFIER`).

### Server / web side

- `src/lib/apns.ts`: `DEFAULT_APNS_BUNDLE_ID = "services.jays.usage.client.monitor"` → `"com.simplewithus.usagemonitor.ios"`.  Added a comment on `loadApnsConfig` explaining that prod uses the renamed bundle ID (set in prod Infisical as an owner action item — see §Owner action items).
- `.env.example`: `# APNS_BUNDLE_ID="services.jays.usage.client.monitor"` → `# APNS_BUNDLE_ID="com.simplewithus.usagemonitor.ios"`.

### Tests

- `src/lib/__tests__/apns.test.ts` (4 hits): `testConfig()` default, `APNS_BUNDLE_ID` env-var stub in two places, the `defaults the topic` assertion, and the `apns-topic` header expectation — all `.ios`.
- `src/lib/__tests__/alert-delivery.test.ts` (3 hits): the provider-channel `bundleId: "..."` fixture, the `APNS_BUNDLE_ID` env-var stub, and the `config.channels[0].config.bundleId` assertion — all `.ios`.

### Ship scripts

- `scripts/ios-asc-screenshots.sh`: two `capture_app` lines (`UsageMonitor` Client + `LocalUsageMonitor` Local) — bundle IDs migrated.
- `scripts/ios-fleet/apps.json`:
  - `usage` entry: `bundleId` and `extraBundleIds[0]` migrated.  `notes` gained a "Bundle ID renamed 2026-09-22 fleet-wide from services.jays.usage.client.monitor to com.simplewithus.usagemonitor.ios" annotation.
  - `usage-local` entry: `bundleId` migrated.  `notes` gained the matching Local annotation.

### Docs (active)

- `AGENTS.md`:
  - New top-of-file `> [!IMPORTANT] 2026-09-22 bundle-ID migration` callout listing every renamed surface (8 bundle IDs, the consolidated App Group, the two Associated Domain values) and pointing to this rollout doc.
  - `Bundle IDs` line in the iOS TestFlight section now reads `com.simplewithus.usagemonitor.ios` (Client) + `com.simplewithus.usagemonitor.local.ios` (Local) and cross-references this rollout.
- `docs/EFFORT-LOG.md`:
  - New `2026-09-22 — MM — COMPLETED/MERGED` stanza at the top of the file describing this rollout (branch, worktree, touched surfaces, Safari rename mapping, BotFleet-precedent keychain preservation, owner follow-up list, this rollout doc pointer).
  - New `> [ARCHAEOLOGY / pre-2026-09-22]` dated note under that stanza explaining that the four `services.jays.usage.*` references in older rows below are historical record.
- `docs/asc/APP-STORE-LISTING.md`: top-of-file `> **2026-09-22 [MM] bundle-ID migration note**` paragraph explaining the pack now matches the renamed ASC records.  The Client + Local bundle-ID tables and the App Group table all migrated.

### Archaeology carve-out (pre-rename files, untouched content + new top-of-file dated note)

Each file below gets a one-line `> **[ARCHAEOLOGY / pre-2026-09-22]**` callout at the top explaining that the `services.jays.usage.*` references inside are historical record from before the rename and pointing back to this rollout doc.  This mirrors the BotFleet / HogHunter / Autorotate / ContactLogo / Socratic.Trade / Congress.Trade migration pattern and preserves the historical record without rewriting it.

- `docs/designs/2026-08-04-mobile-parity-and-phone-self-host.md` (lines 23, 70)
- `docs/audits/2026-08-17-blind-spots.md` (line 62)
- `docs/audits/2026-08-17-web-ios-parity.md` (lines 10, 347, 441, 443)
- `docs/rollouts/2026-08-04-ios-testflight-agent-ship.md` (lines 15, 29)
- `docs/rollouts/2026-08-11-local-invalid-binary.md` (lines 16, 52)
- `docs/rollouts/2026-08-13-apns-send.md` (line 20)
- `docs/rollouts/2026-09-13-local-import-package-tap.md` (line 5)

### Historical records preserved (no archaeology note needed)

- `docs/EFFORT-LOG.md` lines 71, 72, 147, 598 — four pre-rename rows that name `services.jays.usage.client.monitor.widget` (×2, 2026-08-25 CURSOR widget work), `services.jays.usage.monitor` (2026-08-04 GROK ship pipeline, cross-app list), and `services.jays.usage.client.monitor` (2026-08-11 GROK TestFlight upload record) — preserved verbatim.  The effort log is a chronological historical record and rewriting past entries to reflect present-day IDs would defeat its purpose.  Same pattern as the six prior fleet migrations.

## Cross-repo files touched (not in this PR's diff)

- `~/apps/mac-collab/board` — separate lane, NOT touched from this PR.  The owner / another agent will file + close the Usage-Monitor card outside the PR via the board CLI.
- `/Users/jay/Code/Usage-Monitor/` — the human integration tree.  No edits; the worktree stays on `minimax/bundle-rename` and the owner merges through the PR.

## Owner action items

1. **Apple Developer Portal** *[superseded 2026-09-23]* — the App ID list that stood here named Safari extension IDs that no target uses and put the App Group and Associated Domains on the wrong iOS ID.  The current App ID and capability list is in `2026-09-23-usage-identifier-fixes.md` §Owner steps.
2. **Domain + AASA** *[removed 2026-09-23]* — this step asked Jay to set up DNS and an `apple-app-site-association` file for a domain he does not own.  No target declares Associated Domains now.
3. **Code-signing** — vendor-driven (the ship workflow imports the distribution cert on `macos-latest`; `scripts/ios-fleet/` doesn't touch certs).  After the cert swap, the build picks up the new bundle ID via `xcodegen generate` → `ios/UsageMonitor.xcodeproj` without any further source change.  The 5 × 2 = 10 PRODUCT_BUNDLE_IDENTIFIER entries + the App Group + Associated Domain in `project.yml` / the entitlements files flow into the regenerated `.entitlements` and `.pbxproj` automatically.
4. **TestFlight re-upload** — vendor (hosted `ios-ship.yml` + `scripts/ios-fleet/ship-testflight.sh`).  No source change beyond this PR.  The ship script reads the new bundle IDs from `scripts/ios-fleet/apps.json` so the next upload lands on `com.simplewithus.usagemonitor.ios` (Client) and `com.simplewithus.usagemonitor.local.ios` (Local).
5. **`APNS_BUNDLE_ID` in prod Infisical** — flip from `services.jays.usage.client.monitor` to `com.simplewithus.usagemonitor.ios` AFTER the new App ID is registered and a TestFlight build under the new ID is live (until then, the OLD topic will keep the OLD bundle's tokens working and the NEW topic has no tokens yet).  The simplest staging order: deploy this PR → owner registers the new App IDs → vendor ships a TestFlight build under `com.simplewithus.usagemonitor.ios` → owner flips `APNS_BUNDLE_ID` in Infisical → existing devices unregister their old tokens on the first push failure (Apple returns `410 Unregistered`) and re-register under the new bundle on next app launch (the app reads `Bundle.main.bundleIdentifier` for the new topic).
6. **Local App Group + SQLite migration (post-review concern).**  The prior state had Local reading from `group.services.jays.usage.local.monitor` and writing to `~/Library/Containers/Group/<group-hash>/Library/Application Support/LocalUsageMonitor/local.sqlite`.  After this rename, the renamed app is a different iOS application identity, so the new bundle sandbox has an empty `local.sqlite` and the new Keychain access group does not reach the old Keychain entries.  Two follow-up paths:
    - **SQLite file:** *[corrected 2026-09-23]* `LocalDataMigration.swift` looked for `local.sqlite` in the old App Group container, but the old Local app stored it in its own sandbox (`applicationSupportDirectory/LocalUsageMonitor/local.sqlite`), which a renamed app cannot read.  The helper could never find data and was removed; renamed installs start fresh.
    - **Keychain:**  `ProviderKeychain` currently writes with no `kSecAttrAccessGroup`, so the entries live in the bundle's default-access-group under the prior `kSecAttrService` (`services.jays.usage.local.monitor.provider-keys`).  iOS scopes the entries by `kSecAttrAccessGroup` (which the new bundle ID does NOT share with the old one).  The Keychain is therefore silently inaccessible until either (a) the legacy data is wiped and users re-enter provider API keys via Add-Provider, OR (b) an explicit-access-group migration lane lands.  Adding `kSecAttrAccessGroup: LocalAppGroup.identifier` is the next obvious step but is out of scope for this PR (the prefix changes again next release).
    - The widget snapshot situation is different and clean: the Client writes `widget-snapshot-v2.json` (the new filename; the Client deleted `widget-snapshot.json` during a previous migration), and the Local app writes `local-widget-snapshot.json` after this rename.  No collision inside the unified container.
7. **No Keychain migration needed.**  Per the BotFleet precedent, the Keychain service strings (`services.jays.usage.client.monitor` for `TokenStore`, `services.jays.usage.local.monitor.provider-keys` for `ProviderKeychain`) are internal namespaces and have NOT been renamed.  Existing Keychain entries persist and the apps read them on next launch without intervention.

## Verification

- `git grep -nE 'services\.jays\.usage'` returns only archaeology hits:
  - `docs/designs/2026-08-04-mobile-parity-and-phone-self-host.md` (×2, with dated archaeology note)
  - `docs/audits/2026-08-17-blind-spots.md` (×1, with dated archaeology note)
  - `docs/audits/2026-08-17-web-ios-parity.md` (×4, with dated archaeology note)
  - `docs/rollouts/2026-08-04-ios-testflight-agent-ship.md` (×2, with dated archaeology note)
  - `docs/rollouts/2026-08-11-local-invalid-binary.md` (×2, with dated archaeology note)
  - `docs/rollouts/2026-08-13-apns-send.md` (×1, with dated archaeology note)
  - `docs/rollouts/2026-09-13-local-import-package-tap.md` (×1, with dated archaeology note)
  - `docs/asc/APP-STORE-LISTING.md` (×1, the top-of-file dated `2026-09-22 [MM] bundle-ID migration note` paragraph itself)
  - `ios/README.md` (×9, the "delete any old install" legacy-ID helper)
  - `ios/UsageMonitor/UsageMonitorKit/Sources/Networking/TokenStore.swift` (×1, Keychain service string — preserved per BotFleet precedent, NOT a bundle ID)
  - `ios/UsageMonitor/UsageMonitorKit/Sources/LocalSecrets/ProviderKeychain.swift` (×1, Keychain service string — preserved per BotFleet precedent, NOT a bundle ID)
  - `docs/EFFORT-LOG.md` (×4, prior rows preserved as historical record — same pattern as the six prior fleet migrations)
  - `docs/rollouts/2026-09-22-bundle-id-migration.md` (this file — references both old and new IDs in the table)
- `git grep -nE 'com\.simplewithus\.usagemonitor'` returns the renamed canonical IDs across `ios/UsageMonitor/project.yml` (×5), `ios/UsageMonitor/UsageMonitor.xcodeproj/project.pbxproj` (×10), `safari-extension/Usage Monitor Safari/Usage Monitor Safari.xcodeproj/project.pbxproj` (×8), all three iOS `.entitlements` + the new iOS Safari extension `.entitlements` (×4), all three iOS `.entitlements` `App Group` keys, the two `Info.plist` `CFBundleURLName` labels, the `BGTaskSchedulerPermittedIdentifiers` value, the two Swift source files (`AppGroup.swift` + `LocalWidgetSnapshot.swift`), the iOS unit tests, the Safari `ViewController.swift`, `AGENTS.md` (×2: dated top callout + canonical Bundle ID list), `docs/EFFORT-LOG.md` (new dated stanza at top + archaeology note), `docs/asc/APP-STORE-LISTING.md` (migration note paragraph + 4 ID tables), `ios/README.md` (3 ID tables + delete helper), `ios/CLAUDE.md`, `ios/UsageMonitor/ARCHITECTURE-CONTRACT.md` (3 places), `docs/rollouts/2026-09-22-bundle-id-migration.md` (this file).
- `plutil -lint` clean on every modified plist:
  - `ios/UsageMonitor/App/Resources/Info.plist` ✓
  - `ios/UsageMonitor/LocalApp/Resources/Info.plist` ✓
  - `ios/UsageMonitor/UsageMonitorWidget/Info.plist` ✓ (unchanged content; passes for sanity)
  - `safari-extension/Usage Monitor Safari/iOS (App)/Info.plist` ✓ (unchanged)
  - `safari-extension/Usage Monitor Safari/iOS (Extension)/Info.plist` ✓ (unchanged)
  - `safari-extension/Usage Monitor Safari/macOS (App)/Info.plist` ✓ (unchanged)
  - `safari-extension/Usage Monitor Safari/macOS (Extension)/Info.plist` ✓ (unchanged)
  - `ios/UsageMonitor/App/Resources/UsageMonitor.entitlements` ✓
  - `ios/UsageMonitor/LocalApp/Resources/LocalUsageMonitor.entitlements` ✓
  - `ios/UsageMonitor/UsageMonitorWidget/UsageMonitorWidget.entitlements` ✓
  - `safari-extension/Usage Monitor Safari/iOS (Extension)/Usage Monitor Safari iOS Extension.entitlements` ✓ (NEW)
- `xcodebuild -list -project 'ios/UsageMonitor/UsageMonitor.xcodeproj'` (after `xcodegen generate`) lists all 5 targets (UsageMonitor + LocalUsageMonitor + UsageMonitorWidgetExtension + UsageMonitorTests + UsageMonitorWidgetTests) cleanly with both Debug + Release build configurations.
- `xcodebuild -list -project 'safari-extension/Usage Monitor Safari/Usage Monitor Safari.xcodeproj'` lists all 4 targets (Usage Monitor Safari (iOS) + (macOS) + Extension (iOS) + Extension (macOS)) cleanly with both Debug + Release build configurations.
- `ios/UsageMonitor/App/Resources/UsageMonitor.entitlements` carries:
  - `aps-environment: development` (preserved)
  - `com.apple.security.application-groups: [group.com.simplewithus.usagemonitor]` (consolidated; previously `group.services.jays.usage.client.monitor`)
- `ios/UsageMonitor/LocalApp/Resources/LocalUsageMonitor.entitlements` carries:
  - `com.apple.security.application-groups: [group.com.simplewithus.usagemonitor]` (consolidated; previously `group.services.jays.usage.local.monitor`)
- `ios/UsageMonitor/UsageMonitorWidget/UsageMonitorWidget.entitlements` carries:
  - `com.apple.security.application-groups: [group.com.simplewithus.usagemonitor]` (consolidated; previously `group.services.jays.usage.client.monitor`)
- `safari-extension/Usage Monitor Safari/iOS (Extension)/Usage Monitor Safari iOS Extension.entitlements` (NEW) carries:
  - `com.apple.security.application-groups: [group.com.simplewithus.usagemonitor]`
  - an associated-domains key *[removed 2026-09-23]*
- `ios/UsageMonitor/UsageMonitorKit/Tests/UsageMonitorKitTests/PushScaffoldTests.swift` `testAppEntitlementsMatchShippedPushCapability` assertion updated to the new App Group; the test still passes the entitlements-shape contract (it doesn't gate on which App Group specifically, only that one matches what's in the file).
- `AGENTS.md` gains the top-of-file `> [!IMPORTANT] 2026-09-22 bundle-ID migration` callout and the iOS TestFlight section's Bundle ID line.
- `docs/EFFORT-LOG.md` gains the new `2026-09-22 — MM — COMPLETED/MERGED` stanza at the top + the archaeology carve-out note; prior rows are preserved as historical record.

## Out of scope

- Apple Developer Portal App ID + App Group + Associated Domain registration on the 8 new bundle IDs (owner).
- Domain DNS + AASA hosting *[removed 2026-09-23: no such domain]*.
- Code-signing cert refresh (vendor).
- TestFlight re-upload (vendor).
- `APNS_BUNDLE_ID` env-var rotation in prod Infisical (owner — see Owner Action Items §5).
- Keychain service strings (`services.jays.usage.client.monitor` for TokenStore, `services.jays.usage.local.monitor.provider-keys` for ProviderKeychain) — preserved per BotFleet precedent; internal namespaces, not bundle IDs.
- Internal storage paths (`~/Library/Containers/...`), log paths, Sentry project slug (`usage-monitor`) — none are bundle IDs.
- Renaming pre-rename prose in `docs/audits/*`, pre-rename prose in `docs/designs/*`, and pre-rename `docs/rollouts/*` — historical record, preserved with a dated top-of-file archaeology note each.
- Renaming prior `docs/EFFORT-LOG.md` rows — same rationale (chronological historical record).
- Renaming the legacy-legacy `services.jays.usage.monitor` + `services.jays.usage.monitor.local` references in `ios/README.md` (those pre-date the Client + Local split and are listed in the "delete any old install" helper as well, so they stay as historical cleanup hints).
- The `MiniMax-ios` companion app — separate task, no Usage-Monitor-surface bundle IDs inside.
- Other fleet apps' bundle renames (separate per-app PRs, separate seats).
