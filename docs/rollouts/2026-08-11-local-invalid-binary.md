# 2026-08-11 — Usage Local/Client Monitor Invalid Binary (ASC)

> **[ARCHAEOLOGY / pre-2026-09-22]**  Bundle IDs and App Group `services.jays.usage.client.monitor` / `services.jays.usage.local.monitor` / `group.services.jays.usage.local.monitor` referenced below are the pre-2026-09-22 fleet-wide bundle-ID state and have not been retconned.  Canonical IDs after the fleet-wide rename: `com.simplewithus.usagemonitor.ios`, `com.simplewithus.usagemonitor.local.ios`, App Group `group.com.simplewithus.usagemonitor`.  See `docs/rollouts/2026-09-22-bundle-id-migration.md`.

## Symptom
App Store Connect History: `Waiting for Review` → `Invalid Binary` within minutes.
Usage Local **and** Usage Client versions both show `INVALID_BINARY`. TestFlight
builds remain `VALID`.

## Fixed on portal + ship path

1. **App Store profiles** regenerated with App Groups (not empty `[]`).
2. **PrivacyInfo.xcprivacy** on Local/Client/widget targets (UserDefaults reason too).
3. Content rights: `DOES_NOT_USE_THIRD_PARTY_CONTENT`.
4. Listing/screenshots/privacy URLs pushed (`scripts/asc-push-listing.rb`).
5. Deployment target lowered **26.0 → 17.0** (Congress.Trade parity) so review
   devices are not forced onto iOS 26-only binaries.

## Re-submit 2026-08-11 (Grok closeout)

- Attached Client `202608110228` + Local `202608110240`, submitted both to
  `WAITING_FOR_REVIEW` ~17:37Z — both flipped **`INVALID_BINARY` again within
  ~2 minutes** while TF builds stayed VALID.
- Root cause remaining: **build host is macOS 27 beta**
  (`BuildMachineOSBuild=26A5353q`) with Xcode 26.6. Apple rejects App Store
  review binaries from beta OS even when TestFlight accepts them.

## Owner / agent next step (required for green review)

1. Rebuild + upload from **stable macOS + GM Xcode**, or **Xcode Cloud** with a
   non-beta image (minOS 17.0 after this PR).
2. Prefer build number `> 202608110240`.
3. Attach new build to 1.0.0 → Submit for Review (reuse listing pack).
4. Forward any Apple ITMS email if present.

## References
- Local ASC app id `6799230729` · Client `6799230435`
- Latest TF VALID builds: Client `202608110228`, Local `202608110240`
