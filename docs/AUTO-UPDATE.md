# Auto-Update (Sparkle 2)

Owner ruling, Tue, Sep 29, 2026: every fleet Mac app updates itself seamlessly, through Sparkle 2, from signed releases that CI publishes on each merge to `main`.  CodeCaps piloted the pattern and HogHunter copied it; this document is how Usage Monitor implements it.

## What Happens

1. A PR merges to `main` and changes the Mac app (`macos/`, or the build scripts).
2. `.github/workflows/mac-release.yml` builds a universal Release binary with SwiftPM, stages `macos/dist/Usage Monitor.app` (Sparkle.framework embedded), signs it with the Developer ID Application certificate (hardened runtime, secure timestamp, nested code signed inside-out), notarizes and staples the app and the DMG, and writes an appcast whose one item is the new ZIP, signed with Usage Monitor's EdDSA key.
3. The workflow publishes a GitHub release tagged `v<VERSION>-build.<N>`, marked latest, carrying `UsageMonitor.zip`, `UsageMonitor.dmg`, their `.sha256` files, and `appcast.xml`, then confirms the live feed names build N.
4. Every installed copy checks `https://github.com/Simple-With-Us/Usage-Monitor/releases/latest/download/appcast.xml` once an hour, downloads the new ZIP in the background, verifies its EdDSA signature before unpacking it, and checks that it is signed by the same Developer ID team.
5. As soon as Usage Monitor is not the frontmost app (for a menu-bar app, nearly always), `AppUpdater` installs the update and relaunches.  If the owner is using Usage Monitor at that moment, the install waits until they switch away.

Settings shows "Automatic Updates: On/Off" and a **Check For Updates…** button.  The same command is in the app menu.

## The Pieces

| Piece | Role |
|---|---|
| `macos/Package.swift` | Sparkle 2 (`https://github.com/sparkle-project/Sparkle`, from 2.10.0) as a package dependency of the `UsageMonitorMenu` target only. |
| `macos/Sources/UsageMonitorMenu/AutoUpdate.swift` | `AutoUpdateAvailability` (should this build run Sparkle at all) and `AppUpdater` (owns `SPUStandardUpdaterController`, installs as soon as the app is idle). |
| `macos/Sources/UsageMonitorMenu/AppDelegate.swift` | Starts the updater first thing at launch, adds **Check For Updates…** to the app menu. |
| `macos/Sources/UsageMonitorMenu/QuotaViews.swift` | Settings shows the automatic-updates status and a check button. |
| `scripts/mac-release-build.sh` | SwiftPM universal Release build, embed and assert `Sparkle.framework`, write the Sparkle Info.plist keys, sign inside-out, run `codesign --verify --deep --strict`, notarize with an App Store Connect API key when `NOTARY_KEY_*` are set, and run `spctl --assess` on the stapled app and DMG. |
| `scripts/make_appcast.sh` | Runs Sparkle's `generate_appcast` over one archive and checks the result: one item, EdDSA-signed, pointing at the right URL. |
| `.github/workflows/mac-release.yml` | The release job.  Also builds and verifies (never publishes) on PRs that touch the bundle. |
| `.github/actions/infisical-secrets`, `scripts/infisical-fetch.mjs` | Reads secrets from the Usage-Monitor Infisical project (prod), with same-named repository secrets as the fallback. |

## Info.plist Keys

`scripts/mac-release-build.sh` writes these into every staged bundle (local `swift build` builds carry none of them, so a dev build never greets the owner with Sparkle's launch alert):

| Key | Value | Why |
|---|---|---|
| `SUFeedURL` | `https://github.com/Simple-With-Us/Usage-Monitor/releases/latest/download/appcast.xml` | Always the newest release's appcast. |
| `SUPublicEDKey` | `/pP+nmu7F38np96nhP8LEfRLiZNMok1A8ctUljU1DMI=` | Verifies each archive.  Public, committed in the build script. |
| `SUEnableAutomaticChecks` | true | No "check automatically?" prompt. |
| `SUAutomaticallyUpdate` | true | Download and install without asking. |
| `SUAllowsAutomaticUpdates` | true | Silent installs are permitted. |
| `SUScheduledCheckInterval` | 3600 | Hourly checks. |
| `SUVerifyUpdateBeforeExtraction` | true | EdDSA check before unpacking. |

## Secrets

Names only; no value is ever printed:

- `MAC_CERT_P12_BASE64`, `MAC_CERT_PASSWORD` — the Developer ID Application certificate for team `CC8UTF7ATG`.  Read at runtime from Fleet Secrets (Fleet-OPS Infisical project, `prod`, path `/mac-certs/`) via a dedicated workflow step using the org secrets `INFISICAL_FLEET_OPS_PROJECT_ID`, `INFISICAL_UNIVERSAL_AUTH_CLIENT_ID`, `INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET`.  Same-named GitHub repository secrets are the synced-copy fallback.
- `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8` — the App Store Connect API key; `notarytool` signs in with it.  Canonical in Fleet Secrets `/asc/`; same-named repository secrets as the fallback.
- `SPARKLE_ED_PRIVATE_KEY` — the EdDSA private key (base64 of the 32-byte seed) that signs each update archive; same-named repository secret as the fallback.  Generated 2026-10-15 for Usage Monitor; the matching public key is committed above.

With any of them missing the job still builds the bundle and verifies its signature, then skips publishing with a notice that names what is missing.

## Rollback

Every release is a GitHub release with its own appcast; rolling back is publishing the previous build's archive as the new latest (or re-running the workflow from the older commit).  The appcast never carries more than one item, so there is no feed history to rewrite.
