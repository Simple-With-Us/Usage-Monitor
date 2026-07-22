# Status

Updated: 2026-07-21

## Current state

- Native mobile-first work is isolated on `codex/mobile-first-ios-parity-20260721` in
  `/Users/jay/apps/usage-monitor-mobile-first`.
- The app now targets iOS 26 and retains automatic Release signing for team `CC8UTF7ATG`.
- Existing Overview, Providers, Alerts, Projects, Settings, Widget, App Lock, offline cache, and
  background-refresh surfaces are preserved. Settings now adds session-backed native provider and
  subscription management without storing the dashboard password.
- `GET /api/budget-status` accepts either the dedicated read bearer or a verified dashboard session;
  mutations remain session-only.
- No Oracle, DNS, writer, scheduler, production data, provider, or secret mutation occurred.

## Native hardening and management

- Candidate read tokens are verified in a cookie-free disposable session, so an existing dashboard
  cookie cannot mask a bad replacement token.
- Dashboard logout deletes the local cookie even if the server is offline. Host switches clear the
  prior host's local session and token/host changes invalidate in-memory, disk, and widget money state.
- Offline budget files are versioned, identity-scoped, atomic, backup-excluded, first-unlock protected,
  size bounded, symlink rejecting, and stored with restrictive permissions.
- Native full access lists providers and tracked subscriptions, safely toggles eligible providers,
  edits or explicitly clears monthly budgets while preserving the rest of the plan, and pauses active
  subscriptions after confirmation. Successful mutations refresh the shared budget/widget state.
- Notification permission is requested only after explicit Settings opt-in; launch only restores APNs
  registration for an already-authorized user.

## Verification

- XcodeGen generation: passed.
- Generic iOS Simulator app/test-target `build-for-testing`: passed after the final security fixes.
- Release simulator compile: passed after fixing preview-only code that leaked into Release.
- Focused budget-route Vitest: 4/4 passed; scoped ESLint and TypeScript passed after the upstream rebase.
- `git diff --check`: passed.
- XCTest execution is blocked because this machine has no installed iOS Simulator runtime; test-target
  compilation is green.

## Remaining release stages

Open a PR, resolve hosted review/checks, merge, and verify the deployed server SHA separately.
The native binary still needs a real-device/App Store archive and TestFlight receipt before it is shipped.
