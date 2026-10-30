// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "UsageMonitorMac",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "UsageMonitorMenu", targets: ["UsageMonitorMenu"]),
        .library(name: "QuotaCore", targets: ["QuotaCore"]),
    ],
    dependencies: [
        // Sparkle 2: self-update for the Mac app (Mac target only; AppKit-only,
        // must never link into anything iOS).  scripts/mac-release-build.sh
        // embeds the framework and asserts it; see docs/AUTO-UPDATE.md.
        .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.10.1"),
    ],
    targets: [
        .target(name: "QuotaCore", linkerSettings: [.linkedLibrary("sqlite3")]),
        .executableTarget(
            name: "UsageMonitorMenu",
            dependencies: [
                "QuotaCore",
                .product(name: "Sparkle", package: "Sparkle"),
            ],
            resources: [.process("Resources")]
        ),
        .testTarget(name: "QuotaCoreTests", dependencies: ["QuotaCore"]),
    ]
)
