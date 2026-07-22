// swift-tools-version: 5.9
import PackageDescription

// ---------------------------------------------------------------------------
// UsageMonitorKit — the modular core of the Usage Monitor iOS app.
//
// Every target is declared UP FRONT here so that the ~9 parallel feature /
// integration agents each own a single source directory (Sources/<Target>/)
// and NEVER have to edit this manifest or Xcode's merge-hostile .pbxproj.
// SPM auto-discovers every .swift file under a target's Sources directory,
// so adding a screen is "drop a file in your folder" — zero manifest churn,
// zero merge conflicts between lanes.
//
// Dependency layers (acyclic):
//   Models          → (no deps)          Codable API types + date parsing
//   DesignSystem     → (no deps)          tokens + reusable SwiftUI components
//   Networking       → Models             APIClient actor + Keychain token store
//   AppCore          → Models, Networking, DesignSystem   app state / routing / theme / tab scaffold
//   WidgetShared     → DesignSystem       app<->widget snapshot bridge (app group)
//   <Feature>        → AppCore, DesignSystem, Networking, Models
//   AppLock          → AppCore, DesignSystem            LocalAuthentication gate
//   OfflineCache     → Models, Networking, WidgetShared  disk cache + snapshot writer
//   PushScaffold     → AppCore, Models                  UserNotifications / push scaffold
// ---------------------------------------------------------------------------

let package = Package(
    name: "UsageMonitorKit",
    defaultLocalization: "en",
    platforms: [
        .iOS("26.0")
    ],
    products: [
        .library(name: "Models", targets: ["Models"]),
        .library(name: "DesignSystem", targets: ["DesignSystem"]),
        .library(name: "Networking", targets: ["Networking"]),
        .library(name: "AppCore", targets: ["AppCore"]),
        .library(name: "WidgetShared", targets: ["WidgetShared"]),
        .library(name: "Dashboard", targets: ["Dashboard"]),
        .library(name: "Providers", targets: ["Providers"]),
        .library(name: "Alerts", targets: ["Alerts"]),
        .library(name: "ProjectBudgets", targets: ["ProjectBudgets"]),
        .library(name: "Settings", targets: ["Settings"]),
        .library(name: "AppLock", targets: ["AppLock"]),
        .library(name: "OfflineCache", targets: ["OfflineCache"]),
        .library(name: "PushScaffold", targets: ["PushScaffold"]),
    ],
    targets: [
        // ---- Shared foundation ------------------------------------------
        .target(name: "Models"),
        .target(name: "DesignSystem"),
        .target(name: "Networking", dependencies: ["Models"]),
        .target(
            name: "AppCore",
            dependencies: ["Models", "Networking", "DesignSystem"]
        ),
        .target(name: "WidgetShared", dependencies: ["DesignSystem"]),

        // ---- Features (one target each, one owner each) -----------------
        .target(
            name: "Dashboard",
            dependencies: ["AppCore", "DesignSystem", "Networking", "Models"]
        ),
        .target(
            name: "Providers",
            dependencies: ["AppCore", "DesignSystem", "Networking", "Models"]
        ),
        .target(
            name: "Alerts",
            dependencies: ["AppCore", "DesignSystem", "Networking", "Models", "PushScaffold"]
        ),
        .target(
            name: "ProjectBudgets",
            dependencies: ["AppCore", "DesignSystem", "Networking", "Models"]
        ),
        .target(
            name: "Settings",
            dependencies: ["AppCore", "DesignSystem", "Networking", "Models", "PushScaffold"]
        ),

        // ---- Integrations (one target each) -----------------------------
        .target(name: "AppLock", dependencies: ["AppCore", "DesignSystem"]),
        .target(
            name: "OfflineCache",
            dependencies: ["Models", "Networking", "WidgetShared"]
        ),
        .target(name: "PushScaffold", dependencies: ["AppCore", "Models", "Networking"]),

        // ---- Tests (foundation-owned; feature agents add their own) -----
        .testTarget(
            name: "UsageMonitorKitTests",
            dependencies: [
                "Models", "Networking", "AppCore", "DesignSystem",
                "Dashboard", "Providers", "Alerts", "ProjectBudgets",
                "Settings", "AppLock", "OfflineCache", "WidgetShared",
                "PushScaffold",
            ]
        ),
    ]
)
