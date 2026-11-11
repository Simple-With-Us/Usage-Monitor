# Usage Monitor iOS

Two shipped apps share one XcodeGen project and one Swift package:

| App | Bundle ID | Scheme | Entry |
|-----|-----------|--------|-------|
| Usage Monitor Client | `com.simplewithus.usage.client.ios` | `UsageMonitor` | `App/UsageMonitorApp.swift` (talks to the server) |
| Usage Monitor Local | `com.simplewithus.usage.local.ios` | `LocalUsageMonitor` | `LocalApp/LocalUsageMonitorApp.swift` (on-device, no server) |

**Project:** `ios/UsageMonitor/UsageMonitor.xcodeproj`
**XcodeGen:** `ios/UsageMonitor/project.yml` — edit this, then `xcodegen generate`. Do not hand-edit `project.pbxproj`.
**Shared code:** `ios/UsageMonitor/UsageMonitorKit` (Swift package — `Package.swift` is agent-editable).
**Team:** `CC8UTF7ATG`
**Ship:** GitHub-hosted `macos-latest` via `.github/workflows/ios-ship.yml` (`scripts/ios-ship-testflight.sh` → in-repo `scripts/ios-fleet/`). LocalUsageMonitor stays skipped. Do not exec `/Users/jay/apps/ios-fleet` on a hosted runner. Do not mint a new ASC key.

Binding fleet rule: `/Users/jay/apps/FLEET-PROTOCOL.md` § iOS agent build loop. `xcodebuild` / `xcrun simctl` via bash are pre-approved. Do not ask. Do not stand up or narrate Xcode MCP.

## Build & test

```bash
xcodebuild -project ios/UsageMonitor/UsageMonitor.xcodeproj -scheme UsageMonitor \
  -destination 'generic/platform=iOS Simulator' build

xcodebuild -project ios/UsageMonitor/UsageMonitor.xcodeproj -scheme LocalUsageMonitor \
  -destination 'generic/platform=iOS Simulator' build
```

Discover simulators with `xcrun simctl list devices available`. After a user-visible change:

```bash
xcrun simctl io booted screenshot /tmp/um-ios-verify.png
```

`BUILD SUCCEEDED` is not visual QA.

## File structure

```
ios/UsageMonitor/
├── project.yml                         # XcodeGen source of truth
├── UsageMonitor.xcodeproj/             # generated — do not hand-edit
├── App/                                # remote client target
│   └── UsageMonitorApp.swift
├── LocalApp/                           # local-only target
│   └── LocalUsageMonitorApp.swift
├── UsageMonitorKit/                    # shared package
│   ├── Package.swift
│   └── Sources/
│       ├── AppCore/                    # BudgetStore, RootView, settings, theme
│       ├── Dashboard/                  # Overview + spend charts
│       ├── Providers/                  # Provider list / money / keys
│       ├── ProjectBudgets/
│       ├── Platforms/
│       ├── ServerStatus/
│       ├── Settings/
│       ├── Alerts/
│       ├── AppLock/
│       ├── Networking/                 # APIClient, TokenStore
│       ├── Models/
│       ├── DesignSystem/
│       ├── OfflineCache/
│       ├── PushScaffold/
│       ├── LocalStore/ / LocalDataPlane / LocalBudget / LocalAdapters / LocalSecrets
│       └── WidgetShared/
├── UsageMonitorWidget/                 # home-screen widget
├── UsageMonitorTests/
└── UsageMonitorWidgetTests/
```

Put shared UI and models in `UsageMonitorKit`. Put only the `@main` entry in `App/` or `LocalApp/`.

## Rules

- `@Observable` + `@MainActor` on stores. Never `ObservableObject`.
- `NavigationStack` + value-based `NavigationLink`. Never `NavigationView`.
- Light is the product default. Do not ship dark-first chrome.
- Two spaces between sentences in user-visible copy.
- Device-local timestamps are correct in product UI (fleet timestamp exception).
- Never hand-edit `.pbxproj`, `.entitlements`, `.xib`, `.storyboard`.
- Secrets live in Infisical Fleet-OPS (`fleet-secrets get NAME [--path /folder]`); nothing reads `~/.secrets` (AFC-359). Never print them.
