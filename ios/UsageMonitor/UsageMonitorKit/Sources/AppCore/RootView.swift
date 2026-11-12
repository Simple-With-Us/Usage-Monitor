import SwiftUI
import DesignSystem

/// The destinations of the app. Also the deep-link / programmatic-selection
/// vocabulary (a notification tap or widget deep link can select a tab).
///
/// `allCases` order is the **canonical tab order**: the customizable bar
/// renders pinned tabs in this order regardless of when they were pinned
/// (membership set semantics, mirroring the socratictrade.com mobile console).
public enum AppTab: String, CaseIterable, Hashable, Sendable, Identifiable {
    case dashboard
    case providers
    case alerts
    case serverStatus
    case computers
    case agents
    case platforms
    case projects
    case settings

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .dashboard: return "Overview"
        case .providers: return "Providers"
        case .alerts: return "Alerts"
        case .serverStatus: return "Server"
        case .computers: return "Computers"
        case .agents: return "Agents"
        case .platforms: return "Platforms"
        case .projects: return "Projects"
        case .settings: return "Settings"
        }
    }

    public var systemImage: String {
        switch self {
        case .dashboard: return "chart.pie.fill"
        case .providers: return "square.stack.3d.up.fill"
        case .alerts: return "bell.fill"
        case .serverStatus: return "waveform.path.ecg"
        case .computers: return "laptopcomputer"
        case .agents: return "cpu.fill"
        case .platforms: return "server.rack"
        case .projects: return "folder.fill"
        case .settings: return "gearshape.fill"
        }
    }

    /// Concise explanation shown in the More sheet under each destination.
    public var summary: String {
        switch self {
        case .dashboard: return "Budgets and spend at a glance."
        case .providers: return "Per-provider usage and budgets."
        case .alerts: return "Threshold alerts and notifications."
        case .serverStatus: return "Host usage, fleet apps, and backups."
        case .computers: return "Mac hardware, load, and process flags."
        case .agents: return "AI coding agents, tokens, and savings."
        case .platforms: return "Status across every platform."
        case .projects: return "Project budgets and burn."
        case .settings: return "Connection, appearance, security."
        }
    }
}

/// The feature roots the shell mounts, one closure per tab.
///
/// This is the seam that keeps `AppCore` free of any dependency on the feature
/// targets: the **app target** imports every feature module and supplies its
/// root view here (each feature exposes a `public struct <Name>RootView: View`
/// with a `public init()`), while `AppCore` only ever calls the closures. That
/// is exactly why nine agents can build features in parallel without editing a
/// shared file.
public struct AppFeatures {
    public var dashboard: () -> AnyView
    public var providers: () -> AnyView
    public var alerts: () -> AnyView
    public var serverStatus: () -> AnyView
    public var computers: () -> AnyView
    public var agents: () -> AnyView
    public var platforms: () -> AnyView
    public var projects: () -> AnyView
    public var settings: () -> AnyView

    public init(
        dashboard: @escaping () -> AnyView,
        providers: @escaping () -> AnyView,
        alerts: @escaping () -> AnyView,
        serverStatus: @escaping () -> AnyView,
        computers: @escaping () -> AnyView,
        agents: @escaping () -> AnyView = { AnyView(Text("Agents")) },
        platforms: @escaping () -> AnyView,
        projects: @escaping () -> AnyView,
        settings: @escaping () -> AnyView
    ) {
        self.dashboard = dashboard
        self.providers = providers
        self.alerts = alerts
        self.serverStatus = serverStatus
        self.computers = computers
        self.agents = agents
        self.platforms = platforms
        self.projects = projects
        self.settings = settings
    }

    func view(for tab: AppTab) -> AnyView {
        switch tab {
        case .dashboard: return dashboard()
        case .providers: return providers()
        case .alerts: return alerts()
        case .serverStatus: return serverStatus()
        case .computers: return computers()
        case .agents: return agents()
        case .platforms: return platforms()
        case .projects: return projects()
        case .settings: return settings()
        }
    }
}

/// The app's root scaffold: mounts the injected feature roots behind a
/// **customizable glass tab bar** — the user picks which destinations live in
/// the bar (2–4 pins, canonical order), and a permanent **More** control opens
/// a sheet listing every destination with pin toggles, mirroring the
/// socratictrade.com mobile console's bottom bar.
///
/// Each feature root is responsible for its own `NavigationStack` and
/// navigation title (a feature owns everything inside its tab). The shell owns
/// only tab selection, pinning, and app-wide chrome.
///
/// Content mounting is lazy-once (a destination mounts on first visit and
/// stays mounted), so tab state — scroll positions, navigation stacks — is
/// preserved across switches, matching `TabView` behavior.
public struct RootView: View {
    private let environment: AppEnvironment
    private let features: AppFeatures
    @State private var internalSelection: AppTab
    /// When the app drives tab selection externally (deep links / push taps),
    /// it passes a binding; otherwise the shell owns selection internally.
    private let externalSelection: Binding<AppTab>?
    @State private var preferences: TabPreferences
    /// Destinations that have been selected at least once (lazy-once mount).
    @State private var visited: Set<AppTab>
    @State private var moreSheetPresented = false

    public init(
        environment: AppEnvironment,
        features: AppFeatures,
        initialTab: AppTab = .dashboard
    ) {
        self.environment = environment
        self.features = features
        self.externalSelection = nil
        self._internalSelection = State(initialValue: initialTab)
        self._preferences = State(initialValue: TabPreferences())
        self._visited = State(initialValue: [initialTab])
    }

    /// Selection-driven initializer: the app owns an `AppTab` state (seeded from
    /// a cold-launch deep link and updated on warm-launch notification taps) and
    /// passes it here so tab switching can be driven programmatically.
    public init(
        environment: AppEnvironment,
        features: AppFeatures,
        selection: Binding<AppTab>
    ) {
        self.environment = environment
        self.features = features
        self.externalSelection = selection
        self._internalSelection = State(initialValue: selection.wrappedValue)
        self._preferences = State(initialValue: TabPreferences())
        self._visited = State(initialValue: [selection.wrappedValue])
    }

    /// Preview/test seam — inject preferences backed by throwaway defaults.
    init(
        environment: AppEnvironment,
        features: AppFeatures,
        selection: Binding<AppTab>,
        preferences: TabPreferences
    ) {
        self.environment = environment
        self.features = features
        self.externalSelection = selection
        self._internalSelection = State(initialValue: selection.wrappedValue)
        self._preferences = State(initialValue: preferences)
        self._visited = State(initialValue: [selection.wrappedValue])
    }

    /// The effective selection binding: the app-provided one when present, else
    /// the shell's own state.
    private var selection: Binding<AppTab> {
        externalSelection ?? $internalSelection
    }

    public var body: some View {
        let selected = selection.wrappedValue
        ZStack {
            // Lazy-once mounting: only visited destinations exist in the
            // hierarchy; the selected one is visible and hit-testable.
            ForEach(AppTab.allCases) { tab in
                if visited.contains(tab) {
                    features.view(for: tab)
                        .tabBarScrollClearance()
                        .opacity(tab == selected ? 1 : 0)
                        .allowsHitTesting(tab == selected)
                        .accessibilityHidden(tab != selected)
                }
            }
        }
        .glassTabBarSafeArea {
            GlassTabBar(
                pinned: preferences.pinned,
                selection: selected,
                alertBadge: activeAlertCount,
                onSelect: { select($0) },
                onMore: { moreSheetPresented = true },
                moreActive: !preferences.isPinned(selected) || moreSheetPresented
            )
        }
        .sheet(isPresented: $moreSheetPresented) {
            MoreSheet(
                preferences: preferences,
                selection: selected,
                alertBadge: activeAlertCount,
                onSelect: { tab in
                    moreSheetPresented = false
                    select(tab)
                }
            )
        }
        .tint(Theme.Colors.accent)
        // Give every lane a way to drive tab selection (e.g. an error-state CTA
        // that jumps to Settings). Bound here because the shell owns selection.
        .onAppear {
            let binding = selection
            environment.selectTab = { binding.wrappedValue = $0 }
            visited.insert(selected)
            if ProcessInfo.processInfo.arguments.contains("-ScreenshotMore") {
                moreSheetPresented = true
            }
        }
        // External selection changes (deep links) must also mount the target.
        .onChange(of: selected) { _, tab in
            visited.insert(tab)
        }
        // Canonical injection: everything is reachable via AppEnvironment;
        // BudgetStore and AppSettings are also provided directly for ergonomic
        // `@Environment(BudgetStore.self)` / `@Environment(AppSettings.self)`.
        .environment(environment)
        .environment(environment.budgetStore)
        .environment(environment.settings)
        .preferredColorScheme(environment.settings.theme.colorScheme)
    }

    private func select(_ tab: AppTab) {
        guard tab != selection.wrappedValue else { return }
        Haptics.selection()
        visited.insert(tab)
        selection.wrappedValue = tab
    }

    /// Active provider alerts for the Alerts tab badge (0 hides the badge).
    private var activeAlertCount: Int {
        environment.budgetStore.alertItems.count
    }
}

// MARK: - Glass tab bar

/// The floating glass bar: pinned destinations plus the permanent More slot.
/// Liquid Glass on OS versions that have it, ultra-thin material everywhere
/// else — the bar always reads as glass over the content scrolling beneath it.
struct GlassTabBar: View {
    let pinned: [AppTab]
    let selection: AppTab
    let alertBadge: Int
    let onSelect: (AppTab) -> Void
    let onMore: () -> Void
    let moreActive: Bool

    var body: some View {
        HStack(spacing: 0) {
            ForEach(pinned) { tab in
                item(
                    title: tab.title,
                    systemImage: tab.systemImage,
                    active: tab == selection && !moreActive,
                    badge: tab == .alerts ? alertBadge : 0
                ) {
                    onSelect(tab)
                }
            }
            item(
                title: "More",
                systemImage: "square.grid.2x2",
                active: moreActive,
                badge: pinned.contains(.alerts) ? 0 : alertBadge
            ) {
                onMore()
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity)
        .glassBarBackground()
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Tab bar")
    }

    private func item(
        title: String,
        systemImage: String,
        active: Bool,
        badge: Int,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            VStack(spacing: 3) {
                ZStack {
                    // Active pill — the accent-soft highlight behind the icon,
                    // same affordance as the web console's active tab pill.
                    Capsule()
                        .fill(active ? Theme.Colors.accentSoft : .clear)
                        .frame(width: 44, height: 28)
                    Image(systemName: systemImage)
                        .font(.system(size: 17, weight: .medium))
                        .symbolRenderingMode(.hierarchical)
                        .overlay(alignment: .topTrailing) {
                            if badge > 0 {
                                Text("\(min(badge, 99))")
                                    .font(.system(size: 10, weight: .bold))
                                    .foregroundStyle(.white)
                                    .padding(.horizontal, 4)
                                    .padding(.vertical, 1)
                                    .background(Theme.Colors.danger, in: Capsule())
                                    .offset(x: 10, y: -8)
                                    .accessibilityHidden(true)
                            }
                        }
                }
                Text(title)
                    .font(.system(size: 10, weight: active ? .bold : .medium))
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            .foregroundStyle(active ? Theme.Colors.accent : Theme.Colors.secondaryText)
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(badge > 0 ? "\(title), \(badge) alerts" : title)
        .accessibilityAddTraits(active ? [.isSelected] : [])
    }
}

private extension View {
    /// iOS 26 treats a custom bar as a real chrome edge so Form/List can
    /// inset the last footer above it.  `safeAreaInset` alone left that
    /// footer in the scroll-edge fade — visible only while overscrolling.
    @ViewBuilder
    func glassTabBarSafeArea<Bar: View>(@ViewBuilder bar: () -> Bar) -> some View {
        self.safeAreaInset(edge: .bottom, spacing: 0) {
            bar()
        }
    }

    /// Full-width anchored bar (owner 2026-08-31): mostly-solid, slightly
    /// glassy, flush with the screen's sides and bottom — no floating capsule
    /// gaps.  `.bar` is the system chrome material; a hairline divider marks
    /// the top edge and the material extends under the home indicator.
    func glassBarBackground() -> some View {
        self.background {
            Rectangle()
                .fill(.bar)
                .overlay(alignment: .top) { Divider() }
                .ignoresSafeArea(edges: .bottom)
        }
    }
}

// MARK: - More sheet

/// Sheet height for the More menu: tall enough for every destination row,
/// never more than 88% of the available sheet height.  `.medium` is ~50%
/// and clips Settings (and Dynamic Type) behind a scroll.
enum MoreSheetLayout {
    static let maxScreenFraction: CGFloat = 0.92
    static let rowHeight: CGFloat = 68
    static let chromeHeight: CGFloat = 200

    static func detentHeight(tabCount: Int, maxDetentValue: CGFloat) -> CGFloat {
        let needed = chromeHeight + rowHeight * CGFloat(max(tabCount, 1))
        return min(needed, maxDetentValue * maxScreenFraction)
    }
}

private struct MoreMenuDetent: CustomPresentationDetent {
    static func height(in context: Context) -> CGFloat? {
        MoreSheetLayout.detentHeight(
            tabCount: AppTab.allCases.count,
            maxDetentValue: context.maxDetentValue
        )
    }
}

/// Every destination, in canonical order, each with a pin toggle — the
/// destination picker and the bar customizer are the same surface, exactly
/// like the web console's More sheet. Tapping a row goes there; tapping the
/// pin adds/removes it from the bar within the 2–4 bound.
struct MoreSheet: View {
    let preferences: TabPreferences
    let selection: AppTab
    let alertBadge: Int
    let onSelect: (AppTab) -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(AppTab.allCases) { tab in
                        row(tab)
                    }
                } footer: {
                    Text("Pin up to \(TabPreferences.maxPinned) destinations to the tab bar.  Keep at least \(TabPreferences.minPinned).  Everything stays reachable here.")
                        .padding(.bottom, Theme.Spacing.md)
                }
            }
            .contentMargins(.bottom, Theme.Spacing.xl, for: .scrollContent)
            .navigationTitle("More")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
        // Fit the destination list (not the system .medium ~50% detent) and
        // cap at 88% so every tab is on screen without covering the whole phone.
        .presentationDetents([.custom(MoreMenuDetent.self), .large])
        .presentationContentInteraction(.scrolls)
        .presentationDragIndicator(.visible)
        .presentationBackground(.thinMaterial)
    }

    @ViewBuilder
    private func row(_ tab: AppTab) -> some View {
        let pinned = preferences.isPinned(tab)
        let canToggle = preferences.canToggle(tab)
        HStack(spacing: 12) {
            Button {
                onSelect(tab)
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: tab.systemImage)
                        .font(.system(size: 16, weight: .medium))
                        .foregroundStyle(tab == selection ? Theme.Colors.accent : Theme.Colors.secondaryText)
                        .frame(width: 28)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(tab.title)
                            .font(.body.weight(tab == selection ? .semibold : .regular))
                            .foregroundStyle(Theme.Colors.primaryText)
                        Text(tab.summary)
                            .font(.caption)
                            .foregroundStyle(Theme.Colors.secondaryText)
                    }
                    Spacer(minLength: 0)
                    if tab == .alerts, alertBadge > 0 {
                        Text("\(min(alertBadge, 99))")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Theme.Colors.danger, in: Capsule())
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            Button {
                Haptics.selection()
                preferences.togglePin(tab)
            } label: {
                Image(systemName: pinned ? "pin.fill" : "pin")
                    .font(.system(size: 15))
                    .foregroundStyle(
                        canToggle
                            ? (pinned ? Theme.Colors.accent : Theme.Colors.secondaryText)
                            : Theme.Colors.secondaryText.opacity(0.4)
                    )
                    .frame(width: 32, height: 32)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!canToggle)
            .accessibilityLabel(pinned ? "Remove \(tab.title) from tab bar" : "Add \(tab.title) to tab bar")
            .accessibilityHint(
                canToggle
                    ? ""
                    : pinned
                        ? "Keep at least \(TabPreferences.minPinned) tabs"
                        : "Up to \(TabPreferences.maxPinned) tabs — remove one first"
            )
        }
        .accessibilityElement(children: .contain)
    }
}
