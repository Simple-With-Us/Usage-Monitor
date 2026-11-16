# 2026-11-14 — iOS widgets stuck on "Open the app to load …": diagnosis and Settings diagnostics

## Symptom

Every Usage Monitor iOS widget has sat in its designed empty state ("Open the app to load Mac stats." and the matching copy on the other topics) for a long time, including across routine app use and TestFlight updates.  The app itself loads live data normally.

## What the empty state proves

`WidgetUnavailableContent` substitutes "Widget storage is unavailable on this install.  Reinstall the app to restore it." whenever `WidgetSnapshotResolver.isAppGroupUnavailable` is true in the widget process.  The widgets show the plain "Open the app to load …" copy instead, so the app-group container **does** resolve inside the widget extension — and the snapshot the extension reads is missing (or missing the section a topic needs).  The break is on the write side of the boundary, not the read side.

## Audit (repo, at `ee316ba0`)

Everything the repository controls is correct and consistent:

- `CODE_SIGN_ENTITLEMENTS` for **both** Debug and Release, in both the checked-in `project.pbxproj` and its XcodeGen source `project.yml`: Client → `App/Resources/UsageMonitor.entitlements`, widget → `UsageMonitorWidget/UsageMonitorWidget.entitlements`, Local → `LocalApp/Resources/LocalUsageMonitor.entitlements`.  All three files declare `group.com.simplewithus.usage`.
- Ship pipeline (`.github/workflows/ios-ship.yml` → `scripts/ios-fleet/ship-testflight.sh`): `xcodebuild archive` with `-allowProvisioningUpdates` and the ASC API key, ExportOptions `signingStyle: automatic`, no provisioning-profile overrides, no entitlements stripping.  The Nov 12, 2026 ship run's full job log contains no entitlement or application-groups output from the signed steps — the exported entitlements are not observable from the repo or CI.
- Write path: `OfflineCacheSnapshotSink` is installed in `UsageMonitorApp.init`; `BudgetStore` calls `sink.store` on every successful budget response; the root view's `.task` and every foregrounding call `WidgetSnapshotStore.refreshSecondarySections` (LLM, server, Mac) and `BackgroundRefreshManager.performRefresh`; `ComputersStore` also writes the Mac section.  `SharedStore.writeUnlocked` writes the envelope to **both** the app-group `UserDefaults` suite and `widget-snapshot-v2.json`.  No trigger is tab-gated, flag-gated, or platform-gated.
- Builder: the one division is guarded (`totalBudget > 0`), fractions are clamped, `macSection` always produces a section from a successful response, and `GET /api/health/mac`'s payload still matches `MacHealthResponse` field for field.  No silent-abort path fits a chronic, all-topics failure.
- History: the chain broke around the 2026-09-22/23 bundle-ID rename (#1524/#1525), was repaired in code Oct 5–9 (#1587, #1614, #1635, #1586), and on 2026-10-11 the apps moved onto **newly created** App Store Connect records (#1652: "appleId 6820881005 is the new record created for it").  A new ASC record means a new developer-portal App ID, and a new App ID carries **no capabilities** until they are enabled in the portal — no commit can do that step.  #1652's note that the App Group "is a separate namespace and is unchanged" is true of the group identifier string; the per-App-ID assignment is portal state the repo cannot see.

## Diagnosis

The Client app's App ID is the prime suspect: if `group.com.simplewithus.usage` is not assigned to `com.simplewithus.usage.client.ios` in the developer portal, `AppGroup.containerURL` is nil **in the app process**, so every write silently falls back to the app's private `UserDefaults` and no file is written — while the widget extension (whose own App ID assignment evidently resolves) reads an empty shared container forever.  That is exactly the failure `WidgetSnapshotResolver`'s diagnostics describe ("the app has data but the widget never gets it"), it is chronic by construction, and it survives reinstalls and updates because provisioning is portal state, not device state.

## Owner check (developer portal)

In Certificates, Identifiers & Profiles → Identifiers, for **each** of these App IDs, confirm the **App Groups** capability is enabled and `group.com.simplewithus.usage` is assigned:

- `com.simplewithus.usage.client.ios` (Client — the writer; the one that matters most)
- `com.simplewithus.usage.client.ios.widget` (widget extension — the reader)
- `com.simplewithus.usage.local.ios` (Local — also writes into the same group)

After any change, the next `ios-ship.yml` run regenerates the managed App Store profiles automatically (`-allowProvisioningUpdates`); no repo change is needed for the fix itself.

## Change in this PR

`WidgetSnapshotDiagnostics` existed and was unit-tested but had **no production consumer** — the resolver's doc comment claimed it was "surfaced in the app's Settings diagnostics row", and no such row existed.  This PR wires it up: Settings gains a **Widgets** section (Shared Storage / Snapshot Source / Snapshot Age, plus a rejection row when a snapshot file fails validation), reading `WidgetSnapshotResolver.shared.readDetailed()` in the app process.  After the next TestFlight build installs, one glance separates the two remaining cases before touching the portal:

- **Shared Storage: Unavailable on this install** → the app-side container does not resolve; the portal assignment above is the fix.
- **Shared Storage: Available, Snapshot Source: None written** → the container resolves in the app too, and the writer is the remaining suspect.

On-device proof requires the shipped build; CI green is not device proof.
