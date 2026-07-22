# Plan

Updated: 2026-07-21

## Objective

Make Usage Monitor's native iPhone app the primary personal control surface while retaining the server
only for continuous provider polling, ingest, webhooks, receipts, durable scheduling, and remote alerts.

## Completed locally

1. Retargeted the app and Swift package to iOS 26 with Release signing enabled.
2. Preserved the existing five-tab native product, widget, App Lock, background refresh, charts, alerts,
   provider/project detail, Dynamic Type, dark mode, and offline-first behavior.
3. Added dual read authentication: Keychain bearer or HttpOnly dashboard session.
4. Added transient dashboard-password login, fail-closed logout, session status, capability presentation,
   provider inventory, safe active/budget controls, subscription inventory, and pause.
5. Hardened candidate-token verification against cookie-auth substitution.
6. Scoped protected cache data to host/auth identity, fenced in-flight refreshes, cleared stale widget
   state at identity boundaries, rejected unsafe files, and bounded cache sizes.
7. Made mutation refreshes update the shared overview/alerts/projects/widget state.
8. Moved notification permission to an explicit contextual opt-in.
9. Added focused Swift compile-time tests and server route auth tests; adversarial review returned LAND.

## Remaining

1. Publish through a PR, resolve review/checks, merge, and verify the exact deployed server revision.
2. Run XCTest/UI/accessibility tests with an installed iOS 26+ Simulator or the owner's device.
3. Add native project create/edit/allocation and safe provider credential/bootstrap flows before the web
   admin can be retired completely.
4. Add server APNs device enrollment and durable remote delivery; local/background notification scaffolding
   is not an end-to-end push service.
5. Keep continuous ingest, scheduled polling, webhook/receipt handling, backups, and time-critical alerts in
   a thin service. iOS background execution is opportunistic and must not become the sole durable scheduler.
