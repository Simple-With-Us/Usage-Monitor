import SwiftUI
import AppCore
import DesignSystem
import Networking

/// The **Settings** feature root (owned by the Settings lane).
///
/// Composition of a native settings and management `Form`:
///   1. Server address + API-token entry (`ConnectionSection`) — verifies a
///      token via a disposable client **before** writing it to the Keychain
///      (`AppEnvironment.setToken`); never persists to `UserDefaults`.
///   2. Full dashboard-session access with native management inventory.
///   3. Live server status from the public health probes (`ServerStatusSection`).
///   4. Appearance, security, notifications, and app information.
///
/// Contract: keeps `public struct SettingsRootView: View` + `public init()`,
/// owns its own `NavigationStack` + title, and reads everything through
/// `@Environment(AppEnvironment.self)`.
public struct SettingsRootView: View {
    @Environment(AppEnvironment.self) private var env
    @State private var model: SettingsViewModel
    @State private var status: ServerStatusStore
    @State private var access: ManagementAccessStore

    public init() {
        _model = State(initialValue: SettingsViewModel())
        _status = State(initialValue: ServerStatusStore())
        _access = State(initialValue: ManagementAccessStore())
    }

    /// Preview/test seam — inject a stubbed view-model and status store.
    init(model: SettingsViewModel, status: ServerStatusStore) {
        _model = State(initialValue: model)
        _status = State(initialValue: status)
        _access = State(initialValue: ManagementAccessStore())
    }

    public var body: some View {
        NavigationStack {
            Form {
                ConnectionSection(model: model)
                FullAccessSection(store: access)
                ServerStatusSection(store: status) {
                    await status.refresh(using: env.apiClient)
                }
                NotificationsSection()
                AppearanceSection(settings: env.settings)
                SecuritySection(settings: env.settings)
                AboutSection(host: model.resolvedHostDisplay)
            }
            .navigationTitle(AppTab.settings.title)
            .scrollDismissesKeyboard(.interactively)
            .task {
                model.bind(to: env)
                await status.loadIfNeeded(using: env.apiClient)
            }
            .task(id: env.accessIdentityRevision) {
                access.resetForIdentityChange()
                await access.loadIfNeeded(using: env.apiClient)
            }
            .refreshable {
                await status.refresh(using: env.apiClient)
                await access.refresh(using: env.apiClient)
            }
        }
    }
}

// MARK: - Appearance

/// Theme picker. Binds straight to `AppSettings.theme`; the app target applies
/// the chosen `colorScheme` at the window root.
private struct AppearanceSection: View {
    @Bindable var settings: AppSettings

    var body: some View {
        Section {
            Picker(selection: $settings.theme) {
                ForEach(AppTheme.allCases) { theme in
                    Text(theme.label).tag(theme)
                }
            } label: {
                Label("Appearance", systemImage: "circle.lefthalf.filled")
            }
            .onChange(of: settings.theme) { _, _ in Haptics.selection() }
        } header: {
            Text("Appearance")
        } footer: {
            Text("Choose how Usage Monitor looks. \"System\" follows your device's Light/Dark setting.")
        }
    }
}

// MARK: - Security

/// App-lock toggle. AppCore only stores the flag; the AppLock integration reads
/// it and enforces `LocalAuthentication` on launch / foreground.
private struct SecuritySection: View {
    @Bindable var settings: AppSettings
    private let biometry = BiometryInfo.current()

    var body: some View {
        Section {
            Toggle(isOn: $settings.appLockEnabled) {
                Label {
                    Text(lockTitle)
                } icon: {
                    Image(systemName: biometry.systemImage)
                }
            }
            .tint(Theme.Colors.accent)
            .onChange(of: settings.appLockEnabled) { _, _ in Haptics.selection() }
        } header: {
            Text("Security")
        } footer: {
            Text(biometry.requirementCaption)
        }
    }

    private var lockTitle: String {
        biometry.isAvailable ? "Require \(biometry.label)" : "Require passcode"
    }
}

// MARK: - About

private struct AboutSection: View {
    let host: String

    var body: some View {
        Section {
            LabeledContent("Version", value: "\(AppInfo.version) (\(AppInfo.build))")
            LabeledContent("Monitor", value: host)
            if let url = URL(string: "https://\(host)") {
                Link(destination: url) {
                    Label("Open the monitor", systemImage: "safari")
                }
            }
        } header: {
            Text("About")
        } footer: {
            Text("\(AppInfo.displayName) shows your AI provider budgets at a glance. Data stays on your device and the monitor you point it at.")
        }
    }
}

// MARK: - Previews

#Preview("Not connected — Light") {
    SettingsRootView(
        model: SettingsViewModel(verifier: StubTokenVerifier(.failure(.unauthorized))),
        status: ServerStatusStore(probe: PreviewProbe.healthy)
    )
    .environment(AppEnvironment.preview(token: nil))
    .preferredColorScheme(.light)
}

#Preview("Connected — Dark") {
    SettingsRootView(
        model: SettingsViewModel(verifier: StubTokenVerifier(.success(()))),
        status: ServerStatusStore(probe: PreviewProbe.healthy)
    )
    .environment(AppEnvironment.preview(token: "verified-token"))
    .preferredColorScheme(.dark)
}

#Preview("Status degraded — Light") {
    SettingsRootView(
        model: SettingsViewModel(verifier: StubTokenVerifier(.success(()))),
        status: ServerStatusStore(probe: PreviewProbe.degraded)
    )
    .environment(AppEnvironment.preview(token: "verified-token"))
    .preferredColorScheme(.light)
}

/// Deterministic probes for the SwiftUI canvas (no network).
private enum PreviewProbe {
    static let healthy: @Sendable (Networking.APIClient) async throws -> ServerStatusSnapshot = { _ in
        try? await Task.sleep(nanoseconds: 200_000_000)
        return ServerStatusSnapshot(
            health: .init(
                ok: true,
                status: "ok",
                uptimeSeconds: 273_600,
                service: "usage-monitor",
                version: "1.8.2",
                commit: "fe6d9c6d1a"
            ),
            readiness: .init(
                ok: true,
                status: "ready",
                checks: .init(
                    database: .init(ok: true),
                    scheduler: .init(ok: true),
                    backup: .init(ok: true)
                )
            ),
            fetchedAt: Date()
        )
    }

    static let degraded: @Sendable (Networking.APIClient) async throws -> ServerStatusSnapshot = { _ in
        ServerStatusSnapshot(
            health: .init(ok: true, status: "ok", uptimeSeconds: 3_600, service: "usage-monitor", version: "1.8.2"),
            readiness: .init(
                ok: false,
                status: "degraded",
                checks: .init(database: .init(ok: true), scheduler: .init(ok: false), backup: .init(ok: true))
            ),
            fetchedAt: Date()
        )
    }
}
