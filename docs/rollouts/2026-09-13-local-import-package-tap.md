# 2026-09-13 — Local Import Package tap + website JSON

**Branch:** `fx/local-import-tap`
**Board:** `b4ebf716`
**App:** Usage Local Monitor (`services.jays.usage.local.monitor`)

> **[ARCHAEOLOGY / pre-2026-09-22]**  Bundle ID `services.jays.usage.local.monitor` referenced in this rollout is the pre-2026-09-22 fleet-wide bundle-ID state and has not been retconned.  Canonical ID after the fleet-wide rename: `com.simplewithus.usagemonitor.local.ios`.  See `docs/rollouts/2026-09-22-bundle-id-migration.md`.

## Why

Owner could not tap **Import Package** in Usage Local Monitor.  A List Picker for Merge / Replace All sat in the same Settings section and stole the button tap, so every press opened that dropdown.  Splitting the picker and button into separate SwiftUI views (2026-09-04) was not enough — iOS still groups a Picker with the next row in one Section.

The website **Download For Local** JSON is the package.  There is no bundle key or passphrase for that file.  `.umkeys` + passphrase is a separate Mac-only keys path.

## What landed

- Removed the adjacent Import Mode picker from Settings.
- **Import Package** is its own section and opens the file picker immediately.
- After a file is chosen, a sheet asks Merge (Skip Existing) vs Replace All Data, with copy that the website JSON needs no bundle key.
- Website Settings card and export `copyInstructions` / `note` say the same: this JSON is the package; no bundle key; API keys are not included.
- `LocalImportResult.summaryLine` always reminds to re-enter keys.

## How to move data (owner)

1. On usage.jays.services → Settings → **Download For Local**.  File: `usage-monitor-workspace-export.json`.  Format field inside: `usage-monitor-local-export` v1.
2. AirDrop / Files that JSON onto the phone.
3. Usage Local Monitor → Settings → **Import Package** → pick the JSON → Merge (usual) or Replace All Data.
4. Re-enter API keys on each provider (Connect Account).

Optional keys path (not the website JSON): on the Mac, `scripts/local-keys-bundle.mjs build --passphrase-file … --out ….umkeys`, then Settings → **Import Keys** and the passphrase from that file.

## Verification

Ran from `~/apps/usage-fx-import-tap`:

- `npx vitest run src/lib/__tests__/workspace-copy.test.ts` — 3 passed.
- `npx eslint` on `WorkspaceCopyCard.tsx`, `workspace-copy.ts`, and its test — clean.
- `xcodebuild build -scheme LocalDataPlane -sdk iphonesimulator` — **BUILD SUCCEEDED** (exit 0).  Compiles Import Package UI + importer.
- This Mac has the iOS Simulator SDK but no simulator runtime, so `LocalUsageMonitor` app build, kit tests, and screenshots could not run here.  CI `ios-build.yml` still compiles the client scheme.

## Follow-ups

- TestFlight ship of Usage Local Monitor after merge (iOS, not Coolify).
- Visual QA screenshot once a simulator runtime is installed on this Mac.


