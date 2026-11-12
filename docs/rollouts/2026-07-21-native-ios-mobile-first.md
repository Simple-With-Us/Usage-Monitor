# 2026-07-21 — Usage Monitor native iOS mobile-first phase

## Outcome

The existing SwiftUI app is now a credible primary personal client rather than a read-only companion.
It targets iOS 26, keeps the existing Overview/Providers/Alerts/Projects/Settings shell, widget, App Lock,
charts, offline-first loading, and background refresh, and adds bounded native management through the
server's existing authenticated routes.

## Authentication and management

- Read access uses either a dedicated bearer stored in Keychain or a verified HttpOnly dashboard session.
- The dashboard password is accepted only as a transient login argument and is never retained.
- Candidate bearer verification uses a cookie-free disposable session so a valid dashboard cookie cannot
  make an invalid replacement token appear valid.
- Native Settings presents provider and subscription inventory, confirmed provider enable/disable,
  full-plan-preserving monthly-budget edit/clear, and confirmed subscription pause.
- Provider credentials, purchase/resume context, destructive provider removal, and project mutations remain
  web/server-only until their native server-validated contracts are implemented.

## Offline and identity safety

- Budget cache files are schema-versioned and host/auth scoped without persisting the bearer itself.
- Cache and widget writes are atomic, backup-excluded, first-unlock protected, size bounded, symlink rejecting,
  and permission hardened.
- Token, host, login, and logout boundaries synchronously hide old money state and fence in-flight responses.
- Host changes clear the prior origin's local dashboard cookie. Local logout is fail-closed even on server 5xx.

## Notification and release posture

Notification permission is requested only after an explicit Settings opt-in. The existing local/background
scaffold remains; server APNs enrollment and durable remote delivery are not claimed. Release signing remains
enabled in the tracked XcodeGen project, while headless builds disable signing only at the command line.

## Verification

- XcodeGen generation passed.
- Generic iOS Simulator app/test-target `build-for-testing` passed after final adversarial fixes.
- Release iOS Simulator compile passed after fixing preview-only code that leaked into Release.
- Focused budget-route Vitest passed 4/4.
- Scoped ESLint and TypeScript passed after rebasing onto current `origin/main`; its budget freshness
  response headers are preserved alongside the new session-auth path.
- `git diff --check` passed.
- Runtime XCTest is blocked only by the absence of an installed Simulator runtime.

## On-device-first boundary

The iPhone can eventually own local history, UI, direct user-triggered provider refreshes, lightweight
analysis, widgets, and opportunistic background work. A thin service remains necessary for continuous
provider polling, OTLP/usage ingest, email/webhook receipts, durable scheduling, backups, and time-critical
remote alerts; iOS background execution is not an always-on server.
