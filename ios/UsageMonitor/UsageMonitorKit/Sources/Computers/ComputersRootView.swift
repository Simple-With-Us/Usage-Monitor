import SwiftUI
import AppCore
import DesignSystem
import Models
import Networking

/// Mac hardware and launchd/process flags from `/api/health/mac`.  Hetzner
/// host usage stays on Server / Settings — this tab is the Mac.
public struct ComputersRootView: View {
    @Environment(AppEnvironment.self) private var env: AppEnvironment?
    @State private var store: ComputersStore

    public init() {
        _store = State(initialValue: ComputersStore())
    }

    init(store: ComputersStore) {
        _store = State(initialValue: store)
    }

    public var body: some View {
        NavigationStack {
            Form {
                if let lastError = store.lastError {
                    Section {
                        ComputersRefreshErrorBanner(error: lastError)
                    }
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                }

                ComputersSection(store: store) {
                    guard let env else { return }
                    await store.refresh(using: env.apiClient)
                } onOpenSettings: {
                    env?.selectTab?(.settings)
                }
            }
            // Tab-bar clearance comes from the tab shell (RootView) — a second
            // application here doubled the bottom inset.
            .navigationTitle(AppTab.computers.title)
            .navigationBarTitleDisplayMode(.inline)
            .refreshable {
                guard let env else { return }
                await store.refresh(using: env.apiClient)
            }
        }
        .task(id: env?.accessIdentityRevision) {
            guard let env else { return }
            store.reset()
            await store.loadIfNeeded(using: env.apiClient)
        }
    }
}

private struct ComputersRefreshErrorBanner: View {
    let error: APIError

    var body: some View {
        HStack(spacing: Theme.Spacing.sm) {
            Image(systemName: "wifi.exclamationmark")
                .foregroundStyle(Theme.Colors.warning)
            Text(error.computersTitle)
                .font(Theme.Typography.captionEmphasis)
                .foregroundStyle(Theme.Colors.primaryText)
            Spacer(minLength: 0)
            Text("Showing saved data")
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Colors.secondaryText)
        }
        .padding(.horizontal, Theme.Spacing.md)
        .padding(.vertical, Theme.Spacing.sm)
        .background(Theme.Colors.warning.opacity(0.12), in: RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(error.computersTitle). Showing saved data.")
    }
}

#Preview("Online — Light") {
    ComputersRootView(store: ComputersStore(probe: { _ in .previewOnline }))
        .environment(AppEnvironment.preview(token: "verified-token"))
        .preferredColorScheme(.light)
}

private extension MacHealthResponse {
    static let previewOnline = MacHealthResponse(
        ok: true,
        status: "online",
        lastHeartbeatAt: "2026-08-16T12:00:00Z",
        secondsSinceHeartbeat: 18,
        mac: MacHostTelemetry(
            hostname: "jays-macbook-pro",
            osVersion: "macOS 26.0",
            arch: "arm64",
            cpuUsagePct: 24,
            memoryUsagePct: 61,
            diskUsagePct: 47,
            uptimeSeconds: 345_600,
            processes: [
                "com.jay.claude-remote-control": "running",
                "com.jay.agy-acp": "degraded",
            ],
            lastHeartbeatAt: "2026-08-16T12:00:00Z"
        )
    )
}
