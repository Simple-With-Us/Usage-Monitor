# Apple surfaces and account-scoped alerts (2026-07-21)

## Scope

- Restore a buildable universal Safari web extension without restoring the
  credential-scraping design removed in July.
- Make headless iOS builds explicitly unsigned while retaining automatic
  Release/Archive signing for the app and widget.
- Keep local notification identity and resolved-alert history isolated by
  monitor host plus API credential.

## Security boundary

The Safari extension is a least-privilege launcher. Its iOS and macOS targets
share only `chrome-extension/manifest.json` and `chrome-extension/popup/`.
The manifest requests `storage` only and has no host grants, content scripts,
or background worker. The popup stores only a non-secret dashboard URL, rejects
remote plain HTTP, and can open the app through `usagemonitor://dashboard`.
The native extension handler does not inspect, echo, or log browser messages.

The restored project deliberately does not reference the deleted scraper
scripts, missing icon directory, or repository README. The containment test and
Apple-project verifier fail if these boundaries regress.

## Account isolation

Local notification request IDs, dedupe history, active-alert history, and
resolved-alert history are scoped by a SHA-256 digest of canonical monitor host
plus the Keychain-backed API credential. The raw credential is never persisted
to defaults or notification identifiers. Switching or disconnecting accounts
removes pending and delivered notifications from the prior account.
The app-owned token-store wrapper emits only a metadata-free lifecycle signal,
so foreground token replacement/removal activates cleanup immediately without
placing the credential in notifications or editing the Settings feature.

Only successfully scheduled notifications enter dedupe history. Cleared alerts
are forgotten so a later recurrence can notify, while scheduling failures remain
retryable.

## Signing and verification

`project.yml` no longer hard-disables signing. Release build settings for the
app, widget, and Safari extension resolve to automatic signing with team
`CC8UTF7ATG`; headless commands pass `CODE_SIGNING_ALLOWED=NO` and
`CODE_SIGNING_REQUIRED=NO` explicitly.

Verification on Apple Silicon with Xcode 27 beta:

- iOS app + widget Debug simulator build: pass.
- iOS app + widget Debug test-target build: pass.
- iOS app + widget unsigned Release/device build: pass.
- UsageMonitorKit iOS test-target build: pass.
- Safari iOS simulator build: pass.
- Safari macOS build: pass.
- Extension containment tests: 9/9 pass.
- ESLint and TypeScript typecheck: pass.

No iOS Simulator runtime was installed on the verification host, so XCTest
bundles were compiled with `build-for-testing` but not executed there.
