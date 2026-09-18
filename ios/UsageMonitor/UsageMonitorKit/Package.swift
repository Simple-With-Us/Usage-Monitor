// swift-tools-version: 5.9
import PackageDescription

// ---------------------------------------------------------------------------
// UsageMonitorKit — the modular core of the Usage Monitor iOS apps.
//
// Remote client features: Models → Networking → AppCore → feature lanes.
// Local on-device product: LocalStore → LocalSecrets → LocalAdapters →
// LocalBudget → LocalDataPlane (no Networking money writes).
// ---------------------------------------------------------------------------

let package = Package(
    name: "UsageMonitorKit",
    defaultLocalization: "en",
    platforms: [
        .iOS("17.0")
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
        .library(name: "Platforms", targets: ["Platforms"]),
        .library(name: "ServerStatus", targets: ["ServerStatus"]),
        .library(name: "Computers", targets: ["Computers"]),
        .library(name: "Settings", targets: ["Settings"]),
        .library(name: "AppLock", targets: ["AppLock"]),
        .library(name: "OfflineCache", targets: ["OfflineCache"]),
        .library(name: "PushScaffold", targets: ["PushScaffold"]),
        // Usage Local Monitor (on-device product) — not linked by the remote client app.
        .library(name: "LocalStore", targets: ["LocalStore"]),
        .library(name: "LocalSecrets", targets: ["LocalSecrets"]),
        .library(name: "LocalAdapters", targets: ["LocalAdapters"]),
        .library(name: "LocalBudget", targets: ["LocalBudget"]),
        .library(name: "LocalDataPlane", targets: ["LocalDataPlane"]),
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
            dependencies: ["AppCore", "DesignSystem", "Networking", "Models", "OfflineCache", "ProjectBudgets"]
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
            name: "Platforms",
            dependencies: ["AppCore", "DesignSystem", "Networking", "Models"]
        ),
        .target(
            name: "ServerStatus",
            dependencies: ["AppCore", "DesignSystem", "Networking", "Models", "OfflineCache"]
        ),
        .target(
            name: "Computers",
            dependencies: ["AppCore", "Dashboard", "DesignSystem", "Networking", "Models", "OfflineCache"]
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

        // ---- Usage Local Monitor (on-device self-host product) -----------
        .target(name: "LocalStore"),
        .target(name: "LocalSecrets"),
        .target(name: "LocalAdapters", dependencies: ["LocalSecrets"]),
        .target(name: "LocalBudget", dependencies: ["LocalStore"]),
        .target(
            name: "LocalDataPlane",
            dependencies: [
                "DesignSystem",
                "AppCore",
                "AppLock",
                "WidgetShared",
                "LocalStore",
                "LocalSecrets",
                "LocalAdapters",
                "LocalBudget",
            ]
        ),

        // ---- Tests ------------------------------------------------------
        .testTarget(
            name: "UsageMonitorKitTests",
            dependencies: [
                "Models", "Networking", "AppCore", "DesignSystem",
                "Dashboard", "Providers", "Alerts", "ProjectBudgets",
                "Platforms", "ServerStatus", "Computers", "Settings", "AppLock", "OfflineCache", "WidgetShared",
                "PushScaffold",
                "LocalStore", "LocalSecrets", "LocalAdapters", "LocalBudget", "LocalDataPlane",
            ]
        ),
    ]
)
