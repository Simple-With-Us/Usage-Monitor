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
///   3. Appearance, security, notifications, and app information.
///
/// Live server status and host usage live on the Server tab
/// (`ServerStatusRootView`).  Settings keeps connection, appearance, and a
/// jump-link to that tab.
///
/// Contract: keeps `public struct SettingsRootView: View` + `public init()`,
/// owns its own `NavigationStack` + title, and reads everything through
/// `@Environment(AppEnvironment.self)`.
public struct SettingsRootView: View {
    @Environment(AppEnvironment.self) private var env
    @State private var model: SettingsViewModel
    @State private var access: ManagementAccessStore
    @State private var showProviderInventory = false

    public init() {
        _model = State(initialValue: SettingsViewModel())
        _access = State(initialValue: ManagementAccessStore())
    }

    /// Preview/test seam — inject a stubbed view-model.
    init(model: SettingsViewModel) {
        _model = State(initialValue: model)
        _access = State(initialValue: ManagementAccessStore())
    }

    public var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                Form {
                    // Connect order: (1) server → (2) dashboard password → (3) optional token
                    ConnectionSection(model: model)
                    FullAccessSection(store: access)
                    TokenConnectionSection(model: model)
                    HostUsageLinkSection()
                    NotificationsSection()
                    AppearanceSection(settings: env.settings)
                    SecuritySection(settings: env.settings)
                    AboutSection(host: model.resolvedHostDisplay)
                }
                .navigationTitle(AppTab.settings.title)
                // Inline (centered compact) title — avoid large left-aligned title at rest.
                .navigationBarTitleDisplayMode(.inline)
                .scrollDismissesKeyboard(.interactively)
                .task {
                    if ProcessInfo.processInfo.arguments.contains("-ScreenshotScrollBottom") {
                        try? await Task.sleep(for: .milliseconds(300))
                        withAnimation {
                            proxy.scrollTo("settings-bottom-row", anchor: .bottom)
                        }
                    }
                }
            }
            .task {
                model.bind(to: env)
            }
            .task(id: env.accessIdentityRevision) {
                access.resetForIdentityChange()
                await access.loadIfNeeded(using: env.apiClient)
            }
            .refreshable {
                await access.refresh(using: env.apiClient)
            }
            .navigationDestination(isPresented: $showProviderInventory) {
                ProviderManagementInventoryView(
                    client: env.apiClient,
                    afterMutation: { await env.budgetStore.refresh() }
                )
            }
            .onChange(of: env.pendingSettingsDestination) { _, destination in
                guard let destination else { return }
                switch destination {
                case .providerBudgets:
                    showProviderInventory = true
                }
                env.pendingSettingsDestination = nil
            }
        }
    }
}

/// Settings stays the place to *connect*.  Host CPU, risk, and fleet backups
/// live on the Server tab so they have a full screen instead of a buried card.
private struct HostUsageLinkSection: View {
    @Environment(AppEnvironment.self) private var env

    var body: some View {
        Section {
            Button {
                env.selectTab?(.serverStatus)
            } label: {
                Label("Open Host Usage", systemImage: "server.rack")
            }
        } header: {
            Text("Host")
        } footer: {
            Text("CPU, disk, fleet apps, and backups live on the Server tab.")
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
            Text("Choose how \(AppInfo.displayName) looks. \"System\" follows your device's Light/Dark setting.")
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
                    Image(safeSystemName: biometry.systemImage, fallback: "lock.fill")
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
            let versionString = "\(AppInfo.version) (\(AppInfo.build))"
            LabeledContent("App Version", value: versionString)
                .copyableRow(label: "App Version", value: versionString)
            LabeledContent("Monitor", value: host)
                .copyableRow(label: "Monitor", value: host)
            if let url = URL(string: "https://\(host)") {
                Link(destination: url) {
                    Label("Open the monitor", systemImage: "safari")
                }
            }
            Text(AppInfo.aboutFooter)
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Colors.secondaryText)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: Theme.Spacing.sm, leading: Theme.Spacing.xs, bottom: Theme.Spacing.sm, trailing: Theme.Spacing.xs))
                .id("settings-bottom-row")
        } header: {
            Text("About")
        }
    }
}

// MARK: - Previews

#Preview("Not connected — Light") {
    SettingsRootView(
        model: SettingsViewModel(verifier: StubTokenVerifier(.failure(.unauthorized)))
    )
    .environment(AppEnvironment.preview(token: nil))
    .preferredColorScheme(.light)
}

#Preview("Connected — Dark") {
    SettingsRootView(
        model: SettingsViewModel(verifier: StubTokenVerifier(.success(())))
    )
    .environment(AppEnvironment.preview(token: "verified-token"))
    .preferredColorScheme(.dark)
}
