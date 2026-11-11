# 2026-08-25 — Pin AppUpdatePrompt.swift for both Usage Monitor iOS targets

## Why

Jay wants one pinned `AppUpdatePrompt.swift` copied into each iOS target, not a
Swift package.  Usage Monitor has two targets.  The hardcoded `knownAppleIds`
map still listed stale `online.dealdex`.  Live DealDex is `net.dealdex`
(Apple ID `6802474288`).

## What

- Vendor `scripts/ios-fleet/AppUpdatePrompt.swift` and pin it in
  `scripts/ios-fleet.sha256` next to the ship scripts.
- Copy that exact file into `ios/UsageMonitor/App/` and
  `ios/UsageMonitor/LocalApp/`.
- `ios-fleet-pin.sh --check` now fails if either copy drifts, or if the pin
  still embeds `knownAppleIds`.
- Move Apple IDs into `scripts/ios-fleet/apps.json`.  Runtime still reads
  `jaywedgeworth22/ios-app-versions` `versions.json` (already has
  `net.dealdex` / `6802474288`).

## Not in this change

- No Swift package.
- `testers.json` untouched (this repo does not have one).
- No `--force-ship`.
- No TestFlight upload for LocalUsageMonitor.  `ios-ship.yml` still ships
  Usage Client Monitor only.
- No spend.

## Verify

```bash
bash scripts/ios-fleet-pin.sh --check
bash scripts/test-ios-fleet-appupdate-pin.sh
```
