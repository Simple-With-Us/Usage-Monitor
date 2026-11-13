import SwiftUI
import DesignSystem
import LocalAdapters
import LocalBudget
import LocalStore
import AppCore

/// Full shell for **Usage Monitor Local** — on-device money-truth that aims to
/// match and exceed web/remote for personal poll + subscription tracking.
public struct LocalRootView: View {
    @Bindable var settings: AppSettings
    @State private var model = LocalAppModel()
    @State private var tab: Tab = LocalRootView.initialTab()
    @State private var showAddProvider = false
    @State private var pendingDeleteProvider: LocalProvider?
    @State private var showWipeConfirmation = false
    @State private var pathProviders = NavigationPath()
    @State private var providersFilter: LocalProviderFilter = .all
    /// Shared state for Import Package.  Mode is chosen after the file pick so
    /// a List Picker cannot swallow the button tap.
    @State private var importState = LocalImportState()

    /// Caller must supply a main-actor `AppSettings` (e.g. `@State` from the app
    /// entry). No default `AppSettings()` here — its `@MainActor` init cannot run
    /// as a nonisolated default argument expression.
    public init(settings: AppSettings) {
        self.settings = settings
        if LocalScreenshotDemoSeeder.isEnabled {
            // Screenshots must not block on Face ID.
            settings.appLockEnabled = false
        }
    }

    private static func initialTab() -> Tab {
        guard let raw = LocalScreenshotDemoSeeder.preferredTabRawValue,
              let tab = Tab(rawValue: raw) else {
            return .overview
        }
        return tab
    }

    public enum Tab: String, CaseIterable, Identifiable {
        case overview, providers, projects, fleet, alerts, learnMore, settings
        public var id: String { rawValue }
        var title: String {
            switch self {
            case .overview: return "Overview"
            case .providers: return "Providers"
            case .projects: return "Projects"
            case .fleet: return "Fleet"
            case .alerts: return "Alerts"
            case .learnMore: return "Learn More"
            case .settings: return "Settings"
            }
        }
        var systemImage: String {
            switch self {
            case .overview: return "chart.pie.fill"
            case .providers: return "server.rack"
            case .projects: return "folder.fill"
            case .fleet: return "laptopcomputer.and.ipad"
            case .alerts: return "bell.badge.fill"
            case .learnMore: return "info.circle.fill"
            case .settings: return "gearshape.fill"
            }
        }
    }

    public var body: some View {
        TabView(selection: $tab) {
            overviewTab
                .tabItem { Label(Tab.overview.title, systemImage: Tab.overview.systemImage) }
                .tag(Tab.overview)
            providersTab
                .tabItem { Label(Tab.providers.title, systemImage: Tab.providers.systemImage) }
                .tag(Tab.providers)
            LocalProjectsTab(model: model)
                .tabItem { Label(Tab.projects.title, systemImage: Tab.projects.systemImage) }
                .tag(Tab.projects)
            LocalFleetTab(model: model)
                .tabItem { Label(Tab.fleet.title, systemImage: Tab.fleet.systemImage) }
                .tag(Tab.fleet)
            LocalAlertsTab(model: model, openProvider: { providerId in
                tab = .providers
                pathProviders.append(providerId)
            }, openNeedsKey: {
                providersFilter = .needsKey
                tab = .providers
            })
            .tabItem { Label(Tab.alerts.title, systemImage: Tab.alerts.systemImage) }
            .tag(Tab.alerts)
            .badge(model.alerts.isEmpty ? 0 : model.alerts.count)
            // Owner 2026-09-09: "just have one part of local app that is a tab
            // for info about the server and client app including: features
            // that setup has, the big picture overview of how it works (not
            // details), and info/link to where they can go to learn more."
            // No live data, no model dependencies, no Settings state.
            LocalLearnMoreTab()
                .tabItem { Label(Tab.learnMore.title, systemImage: Tab.learnMore.systemImage) }
                .tag(Tab.learnMore)
            settingsTab
                .tabItem { Label(Tab.settings.title, systemImage: Tab.settings.systemImage) }
                .tag(Tab.settings)
        }
        .tabBarScrollClearance()
        .tint(Theme.Colors.accent)
        .task { await model.bootstrap() }
        .sheet(isPresented: $showAddProvider) {
            AddProviderSheet(model: model)
        }
    }

    // MARK: - Overview

    private var overviewTab: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                    // Always-visible product identity:  "Usage Monitor Local" in the app,  and the
                    // home-screen label is "Local Monitor".
                    HStack(spacing: Theme.Spacing.sm) {
                        Image(systemName: "iphone")
                            .font(.system(size: 14, weight: .semibold))
                        Text("ON-DEVICE · no server")
                            .font(Theme.Typography.captionEmphasis)
                        Spacer()
                        Text("Local")
                            .font(Theme.Typography.captionEmphasis)
                    }
                    .foregroundStyle(Color.white)
                    .padding(.horizontal, Theme.Spacing.md)
                    .padding(.vertical, Theme.Spacing.sm)
                    .background(Color(red: 0.05, green: 0.72, blue: 0.68), in: RoundedRectangle(cornerRadius: Theme.Radius.md))

                    if let err = model.lastError {
                        Text(err)
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.Colors.danger)
                            .dsCard()
                    }
                    if let s = model.summary, !s.providers.isEmpty {
                        LocalOverviewContent(
                            summary: s,
                            alertCount: model.alerts.count,
                            needsKeyCount: model.pollableProvidersNeedingKey.count,
                            onOpenProvider: { id in
                                tab = .providers
                                pathProviders.append(id)
                            },
                            onOpenAlerts: { tab = .alerts },
                            onAddProvider: { showAddProvider = true },
                            onShowNeedsKey: {
                                providersFilter = .needsKey
                                tab = .providers
                            }
                        )
                        if !model.subscriptions.filter({ $0.status == "active" && $0.costUsd > 0 }).isEmpty {
                            LocalRecurringFeesCard(
                                subscriptions: model.subscriptions,
                                providers: model.providers
                            )
                        }
                    } else if !model.isReady {
                        ProgressView("Opening local store…")
                            .frame(maxWidth: .infinity)
                            .padding()
                    } else {
                        EmptyState(
                            systemImage: "iphone",
                            title: "No Providers Yet",
                            message: "Add OpenRouter (Management key) or a subscription-only provider — same money model as the web (poll + fees).",
                            actionTitle: "Add Provider"
                        ) { showAddProvider = true }
                    }
                }
                .padding(Theme.Spacing.lg)
            }
            .dsScreenBackground()
            .navigationTitle("Overview")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await model.refreshAllDue(force: true) }
                    } label: {
                        if model.isRefreshing {
                            ProgressView()
                        } else {
                            Image(systemName: "arrow.clockwise")
                        }
                    }
                    .accessibilityLabel("Refresh")
                }
            }
            .refreshable { await model.refreshAllDue(force: true) }
        }
    }

    // MARK: - Providers

    private var providersTab: some View {
        NavigationStack(path: $pathProviders) {
            LocalProvidersListContent(
                model: model,
                filter: $providersFilter,
                onAdd: { showAddProvider = true },
                onRequestDelete: { pendingDeleteProvider = $0 }
            )
            .navigationTitle("Providers")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: String.self) { id in
                ProviderDetailView(model: model, providerId: id)
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showAddProvider = true } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityLabel("Add Provider")
                }
            }
            .confirmationDialog(
                "Delete this provider?",
                isPresented: Binding(
                    get: { pendingDeleteProvider != nil },
                    set: { if !$0 { pendingDeleteProvider = nil } }
                ),
                titleVisibility: .visible,
                presenting: pendingDeleteProvider
            ) { provider in
                Button("Delete \(provider.displayName)", role: .destructive) {
                    Task {
                        try? await model.deleteProvider(id: provider.id)
                        pendingDeleteProvider = nil
                    }
                }
                Button("Cancel", role: .cancel) {
                    pendingDeleteProvider = nil
                }
            } message: { provider in
                Text("“\(provider.displayName)” and its saved key will be removed from this phone.")
            }
        }
    }

    // MARK: - Settings

    private var settingsTab: some View {
        NavigationStack {
            List {
                connectAccountsSection
                Section("This App") {
                    let schemaVal = "v\(model.schemaVersion)"
                    let provVal = "\(model.providers.count)"
                    let subVal = "\(model.subscriptions.filter { $0.status == "active" }.count) active"
                    LabeledContent("Product", value: "on-device self-host")
                        .copyableRow(label: "Product", value: "on-device self-host")
                    LabeledContent("Schema", value: schemaVal)
                        .copyableRow(label: "Schema", value: schemaVal)
                    LabeledContent("Providers", value: provVal)
                        .copyableRow(label: "Providers", value: provVal)
                    LabeledContent("Subscriptions", value: subVal)
                        .copyableRow(label: "Subscriptions", value: subVal)
                    Text("Money-truth is local SQLite. Provider API keys stay in Keychain. No remote server required.")
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Colors.secondaryText)
                }
                Section("Subscriptions") {
                    let active = model.subscriptions.filter { $0.status == "active" && $0.costUsd > 0 }
                    if active.isEmpty {
                        Text("no active recurring fees")
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.Colors.secondaryText)
                    } else {
                        ForEach(active.sorted { $0.costUsd > $1.costUsd }) { sub in
                            let costStr = CurrencyFormat.usd(sub.costUsd)
                            LabeledContent(sub.name, value: costStr)
                                .copyableRow(label: sub.name, value: costStr)
                        }
                        let runRateStr = CurrencyFormat.usd(active.reduce(0) { $0 + $1.costUsd })
                        LabeledContent(
                            "Monthly Run-Rate",
                            value: runRateStr
                        )
                        .copyableRow(label: "Monthly Run-Rate", value: runRateStr)
                    }
                    Text("Edit fees on each provider detail (Recurring Fee). Materializer posts one charge per billing period into MTD spend.")
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Colors.secondaryText)
                }
                Section("Appearance") {
                    Picker("Theme", selection: $settings.theme) {
                        ForEach(AppTheme.allCases) { theme in
                            Text(theme.label).tag(theme)
                        }
                    }
                }
                Section("Security") {
                    Toggle("Require Face ID / Passcode", isOn: $settings.appLockEnabled)
                        .tint(Theme.Colors.accent)
                }
                Section {
                    LocalExportButton(model: model)
                } header: {
                    Text("Backup")
                } footer: {
                    Text("A backup restores cards, budgets, and fees — never API keys.")
                }
                // Own Section (not a Picker sibling).  A List Picker in the same
                // section still steals the next row's tap — owner 2026-09-04 and
                // 2026-09-13: Import Package always opened Merge / Replace All.
                Section {
                    LocalImportButton(model: model, state: importState)
                    LocalImportMessage(state: importState)
                } header: {
                    Text("Import Package")
                } footer: {
                    Text("Pick the JSON from usage.jays.services (Download For Local) or a phone export.  There is no bundle key or passphrase.  API keys are not in that file.")
                }
                Section {
                    LocalKeysImportButton(model: model)
                } header: {
                    Text("Import Keys")
                } footer: {
                    Text("Only for a Mac .umkeys file.  Needs the passphrase you set when you built it.  Do not use this for the website JSON.")
                }
                Section("Also in This Project") {
                    Text("**Usage Monitor Client** is the other app: a live-sync client for a server you host yourself (or the owner fleet). Use that when you run a VPS.")
                        .font(Theme.Typography.caption)
                }
                Section("Providers Catalog") {
                    Text("\(LocalProviderCatalog.all.count) known services.  Add Missing Providers only creates empty cards.  It does not connect accounts.  Open a card and tap Connect Account to paste a key.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Button("Add Missing Providers") {
                        Task {
                            _ = try? await model.ensureCatalogProviders()
                        }
                    }
                    Button("Remove Incorrect Catalog Fees") {
                        Task { _ = try? await model.scrubCatalogGuessCharges() }
                    }
                }
                Section("Data") {
                    Button("Refresh All Providers", role: nil) {
                        Task { await model.refreshAllDue(force: true) }
                    }
                    Button("Wipe All Local Data", role: .destructive) {
                        showWipeConfirmation = true
                    }
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .confirmationDialog(
                "Wipe All Local Data?",
                isPresented: $showWipeConfirmation,
                titleVisibility: .visible
            ) {
                Button("Wipe Everything", role: .destructive) {
                    Task { try? await model.wipeAll() }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Removes every provider, plan, subscription charge, and saved API key on this phone.")
            }
        }
    }

    @ViewBuilder
    private var connectAccountsSection: some View {
        let needingKey = model.pollableProvidersNeedingKey
        Section {
            if needingKey.isEmpty {
                Label("Pollable accounts have keys, or none need one yet.", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(Theme.Colors.secondaryText)
                    .font(Theme.Typography.caption)
            } else {
                Text("\(needingKey.count) account\(needingKey.count == 1 ? "" : "s") still need an API key.  Open a card and tap Connect Account.")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
                Button {
                    providersFilter = .needsKey
                    tab = .providers
                } label: {
                    Label("Show Accounts That Need a Key", systemImage: "key")
                }
                ForEach(needingKey.prefix(6)) { provider in
                    Button {
                        tab = .providers
                        pathProviders.append(provider.id)
                    } label: {
                        HStack {
                            Text(provider.displayName)
                            Spacer()
                            Text("Connect")
                                .font(Theme.Typography.captionEmphasis)
                                .foregroundStyle(Theme.Colors.accent)
                        }
                    }
                }
                if needingKey.count > 6 {
                    Text("+\(needingKey.count - 6) more")
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Colors.tertiaryText)
                }
            }
        } header: {
            Text("Connect Accounts")
        } footer: {
            Text("Restored cards start empty.  Connect Account on a provider saves the key on this phone and starts usage fetch.  Import Keys under Backup restores a key file from your Mac.")
        }
    }
}

// MARK: - Add provider

private struct AddProviderSheet: View {
    @Bindable var model: LocalAppModel
    @Environment(\.dismiss) private var dismiss

    @State private var search = ""
    @State private var selected: LocalProviderCatalogEntry?
    @State private var displayName = ""
    @State private var apiKey = ""
    @State private var teamId = ""
    @State private var accountSid = ""
    @State private var apiKeySid = ""
    @State private var budgetText = ""
    @State private var subCostText = ""
    @State private var error: String?
    @State private var seedMessage: String?

    private var filtered: [LocalProviderCatalogEntry] {
        LocalProviderCatalog.filtered(search: search)
    }

    private var grouped: [(String, [LocalProviderCatalogEntry])] {
        Dictionary(grouping: filtered, by: \.category)
            .map { ($0.key, $0.value.sorted { $0.displayName < $1.displayName }) }
            .sorted { $0.0 < $1.0 }
    }

    var body: some View {
        NavigationStack {
            Form {
                if selected == nil {
                    Section {
                        TextField("Search providers", text: $search)
                        Button("Add Missing Providers") {
                            Task { await seed() }
                        }
                        Text("Creates empty cards only.  After they appear, open a card and tap Connect Account to paste a key.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        if let seedMessage {
                            Text(seedMessage).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    ForEach(grouped, id: \.0) { category, entries in
                        Section(category) {
                            ForEach(entries) { entry in
                                Button {
                                    selected = entry
                                    displayName = entry.displayName
                                    subCostText = entry.suggestedMonthlyUsd.map { String(format: "%g", $0) } ?? ""
                                    apiKey = ""
                                    teamId = ""
                                    accountSid = ""
                                    apiKeySid = ""
                                    budgetText = ""
                                } label: {
                                    HStack {
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text(entry.displayName)
                                                .foregroundStyle(.primary)
                                            Text(entry.connectionSummary)
                                                .font(.caption)
                                                .foregroundStyle(.secondary)
                                                .lineLimit(2)
                                        }
                                        Spacer()
                                        if model.providers.contains(where: { $0.name == entry.name }) {
                                            Text(
                                                model.providers.first(where: { $0.name == entry.name })?.needsKey == true
                                                    ? "Needs key"
                                                    : "Added"
                                            )
                                            .font(.caption)
                                            .foregroundStyle(Theme.Colors.secondaryText)
                                        }
                                        Image(systemName: "chevron.right")
                                            .font(.caption)
                                            .foregroundStyle(.tertiary)
                                    }
                                }
                            }
                        }
                    }
                } else if let entry = selected {
                    Section {
                        Text(entry.help)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        FlowAbilityChips(abilities: entry.abilities)
                    } header: {
                        Text("What This Phone Can Do")
                    }
                    Section(entry.displayName) {
                        TextField("Display name", text: $displayName)
                        if entry.mode == .poll || entry.mode == .keyPlusSubscription {
                            SecureField(entry.keyFieldLabel, text: $apiKey)
                            if entry.requiresTeamId || entry.adapterKind == "xai" {
                                TextField("Team id (required for xAI)", text: $teamId)
                                    .textInputAutocapitalization(.never)
                                    .autocorrectionDisabled()
                            }
                            if entry.requiresAccountSid || entry.adapterKind == "twilio" {
                                TextField("Account SID (required)", text: $accountSid)
                                    .textInputAutocapitalization(.never)
                                    .autocorrectionDisabled()
                                TextField("API Key SID (optional)", text: $apiKeySid)
                                    .textInputAutocapitalization(.never)
                                    .autocorrectionDisabled()
                            }
                            TextField("Monthly budget USD (optional)", text: $budgetText)
                                .keyboardType(.decimalPad)
                        }
                        if entry.mode == .subscription || entry.mode == .keyPlusSubscription
                            || entry.mode == .poll {
                            TextField("Monthly fee USD (optional)", text: $subCostText)
                                .keyboardType(.decimalPad)
                        }
                    }
                    if let error {
                        Section { Text(error).foregroundStyle(.red).font(.caption) }
                    }
                }
            }
            .navigationTitle(selected == nil ? "Add Provider" : "Configure")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(selected == nil ? "Cancel" : "Back") {
                        if selected != nil {
                            selected = nil
                            error = nil
                        } else {
                            dismiss()
                        }
                    }
                }
                if selected != nil {
                    ToolbarItem(placement: .confirmationAction) {
                        Button(saveLabel) { Task { await save() } }
                    }
                }
            }
        }
    }

    private func seed() async {
        error = nil
        do {
            let n = try await model.ensureCatalogProviders()
            seedMessage = n == 0
                ? "All known services already have a card.  Open one and tap Connect Account to add a key."
                : "Added \(n) empty card\(n == 1 ? "" : "s").  Open a provider and tap Connect Account to add a key."
            try? await model.reload()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func save() async {
        error = nil
        guard let entry = selected else { return }
        do {
            let fee = Double(subCostText)
            try await model.addFromCatalog(
                entry: entry,
                displayName: displayName,
                apiKey: apiKey.isEmpty ? nil : apiKey,
                monthlyBudgetUsd: Double(budgetText),
                subscriptionCostUsd: fee.flatMap { $0 > 0 ? $0 : nil },
                subscriptionName: entry.suggestedSubscriptionName,
                teamId: teamId.isEmpty ? nil : teamId,
                accountSid: accountSid.isEmpty ? nil : accountSid,
                apiKeySid: apiKeySid.isEmpty ? nil : apiKeySid
            )
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private var saveLabel: String {
        guard let entry = selected else { return "Save" }
        if model.providers.contains(where: { $0.name == entry.name }) {
            return "Connect"
        }
        return "Save"
    }
}

// MARK: - Ability chips

private struct FlowAbilityChips: View {
    let abilities: [LocalConnectionAbility]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(abilities, id: \.self) { ability in
                HStack(alignment: .top, spacing: 8) {
                    Text(ability.chipLabel)
                        .font(Theme.Typography.caption.weight(.semibold))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(Theme.Colors.accentSoft, in: Capsule())
                        .foregroundStyle(Theme.Colors.accent)
                    Text(ability.detail)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}

// MARK: - Detail

private struct ProviderDetailView: View {
    @Bindable var model: LocalAppModel
    let providerId: String
    @State private var budgetText = ""
    @State private var feeText = ""
    @State private var feeName = ""
    @State private var showDeleteConfirm = false
    @State private var didSeedFields = false
    @State private var actionError: String?
    @State private var historyPoints: [Double] = []
    @State private var historyCaption: String?
    @State private var connectKey = ""
    @State private var connectTeamId = ""
    @State private var connectAccountSid = ""
    @State private var connectApiKeySid = ""
    @State private var isConnecting = false

    private var provider: LocalProvider? {
        model.providers.first { $0.id == providerId }
    }

    private var spend: BudgetEngine.ProviderSpend? {
        model.summary?.providers.first { $0.providerId == providerId }
    }

    var body: some View {
        List {
            if let p = provider {
                connectionSection(p)

                if let s = spend {
                    Section {
                        let totalStr = CurrencyFormat.usd(s.spentUsd)
                        LabeledContent("Total", value: totalStr)
                            .copyableRow(label: "Total", value: totalStr)
                        let pollStr = CurrencyFormat.usd(s.pollVariableUsd)
                        LabeledContent("Poll Variable", value: pollStr)
                            .copyableRow(label: "Poll Variable", value: pollStr)
                        let subStr = CurrencyFormat.usd(s.subscriptionChargesUsd)
                        LabeledContent("Subscriptions", value: subStr)
                            .copyableRow(label: "Subscriptions", value: subStr)
                        let planStr = CurrencyFormat.usd(s.planFixedUsd)
                        LabeledContent("Plan Fixed", value: planStr)
                            .copyableRow(label: "Plan Fixed", value: planStr)
                        if let b = s.monthlyBudgetUsd {
                            let budgetStr = CurrencyFormat.usd(b)
                            LabeledContent("Budget", value: budgetStr)
                                .copyableRow(label: "Budget", value: budgetStr)
                        } else {
                            LabeledContent("Budget", value: "no budget set")
                                .copyableRow(label: "Budget", value: "no budget set")
                        }
                    } header: {
                        Text("Spend (MTD)")
                    } footer: {
                        Text("Poll totals are provider-reported (taxes/VAT often missing). Subscription fees are what you enter here — include tax yourself if you want the full bill.")
                    }

                    if let proj = s.projectedEomUsd, proj > 0.005 {
                        Section {
                            let projStr = CurrencyFormat.usd(proj)
                            LabeledContent("Projected EOM", value: projStr)
                                .copyableRow(label: "Projected EOM", value: projStr)
                            let pacedStr = CurrencyFormat.usd(s.pacedVariableUsd)
                            LabeledContent("Usage (Extrapolated)", value: pacedStr)
                                .copyableRow(label: "Usage (Extrapolated)", value: pacedStr)
                            let fixedStr = CurrencyFormat.usd(s.fixedAccruedUsd)
                            LabeledContent("Fixed Accrued MTD", value: fixedStr)
                                .copyableRow(label: "Fixed Accrued MTD", value: fixedStr)
                            let remainStr = CurrencyFormat.usd(s.remainingScheduledUsd)
                            LabeledContent("Known Renewals Remaining", value: remainStr)
                                .copyableRow(label: "Known Renewals Remaining", value: remainStr)
                        } header: {
                            Text("EOM Projection Parts")
                        } footer: {
                            Text("Same composition as the web: paced variable usage + fixed accrued + known subscription renewals still due this UTC month.")
                        }
                    }
                }

                if historyPoints.count >= 2 {
                    Section {
                        SparklineCard(
                            title: "Poll history (total cost)",
                            value: historyCaption ?? "—",
                            caption: "\(historyPoints.count) samples",
                            points: historyPoints,
                            status: .neutral
                        )
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                    } header: {
                        Text("Snapshot history")
                    } footer: {
                        Text("On-device only — successive poll costs (not daily invoices).")
                    }
                }

                Section {
                    HStack {
                        Text("$")
                        TextField("No budget", text: $budgetText)
                            .keyboardType(.decimalPad)
                            .multilineTextAlignment(.trailing)
                    }
                    Button("Save Budget") {
                        Task {
                            let trimmed = budgetText.trimmingCharacters(in: .whitespacesAndNewlines)
                            let value: Double? = trimmed.isEmpty ? nil : Double(trimmed)
                            do {
                                try await model.setBudget(providerId: providerId, monthlyBudgetUsd: value)
                                actionError = nil
                            } catch {
                                actionError = error.localizedDescription
                            }
                        }
                    }
                } header: {
                    Text("Monthly Budget")
                }

                Section {
                    TextField("Plan name", text: $feeName)
                    HStack {
                        Text("$")
                        TextField("0 = no charge", text: $feeText)
                            .keyboardType(.decimalPad)
                            .multilineTextAlignment(.trailing)
                    }
                    Button("Save Recurring Fee") {
                        Task {
                            let cost = Double(feeText.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0
                            let name = feeName.trimmingCharacters(in: .whitespacesAndNewlines)
                            do {
                                try await model.setRecurringFee(
                                    providerId: providerId,
                                    name: name.isEmpty ? "\(p.displayName) plan" : name,
                                    costUsd: cost
                                )
                                actionError = nil
                            } catch {
                                actionError = error.localizedDescription
                            }
                        }
                    }
                    Button("Cancel Recurring Fees", role: .destructive) {
                        Task {
                            try? await model.cancelRecurringFees(providerId: providerId)
                            feeText = ""
                        }
                    }
                } header: {
                    Text("Recurring Fee")
                } footer: {
                    Text("Use this for Max/Pro, Workers Paid, Vercel Pro, etc. Leave $0 if you do not pay for this product.")
                }

                if p.isPollable {
                    Section {
                        if p.canFetch {
                            Button {
                                Task { await model.poll(providerId: providerId) }
                            } label: {
                                if model.isRefreshing {
                                    ProgressView()
                                } else {
                                    Label("Fetch Now", systemImage: "arrow.triangle.2.circlepath")
                                }
                            }
                            .disabled(model.isRefreshing)
                        } else {
                            Label("Paste a key above to enable Fetch", systemImage: "key")
                                .foregroundStyle(Theme.Colors.secondaryText)
                        }
                    } footer: {
                        Text(p.canFetch
                             ? "Pulls latest usage and cost from the provider.  Not an invoice."
                             : "Paste a key under Connect Account, or track cost as a Recurring Fee.")
                    }
                } else {
                    Section {
                        Label("No poll — subscription / push only", systemImage: "hand.raised")
                            .foregroundStyle(Theme.Colors.secondaryText)
                    } footer: {
                        Text("This provider cannot be fetched on the phone. Do not expect a Fetch button that only fails.")
                    }
                }

                Section {
                    Button("Delete Provider", role: .destructive) {
                        showDeleteConfirm = true
                    }
                }

                if let actionError {
                    Section("Error") {
                        Text(actionError).foregroundStyle(Theme.Colors.danger)
                    }
                }
            }
        }
        .navigationTitle(provider?.displayName ?? "Provider")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            seedFieldsIfNeeded()
            await loadHistory()
        }
        .confirmationDialog(
            "Delete this provider?",
            isPresented: $showDeleteConfirm,
            titleVisibility: .visible
        ) {
            Button("Delete", role: .destructive) {
                Task { try? await model.deleteProvider(id: providerId) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Removes this connection, its saved key, and local history for it.")
        }
    }

    @ViewBuilder
    private func connectionSection(_ p: LocalProvider) -> some View {
        let entry = LocalProviderCatalog.entry(name: p.name)
        Section {
            LabeledContent("Name", value: p.displayName)
            LabeledContent("Status", value: connectionStatus(p, entry: entry))
            if let entry {
                Text(entry.help)
                    .font(.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
                FlowAbilityChips(abilities: entry.abilities)
            }

            if p.isPollable || entry?.mode == .keyPlusSubscription || entry?.mode == .poll {
                if p.canFetch {
                    Label("API key saved on this phone", systemImage: "checkmark.circle.fill")
                        .foregroundStyle(Theme.Colors.success)
                    SecureField(entry?.keyFieldLabel ?? "Replacement API key", text: $connectKey)
                    extraConnectFields(entry)
                    Button("Replace Key") {
                        Task { await saveConnectKey() }
                    }
                    .disabled(connectKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isConnecting)
                    Button("Remove Key", role: .destructive) {
                        Task { await removeConnectKey() }
                    }
                } else {
                    SecureField(entry?.keyFieldLabel ?? "API key", text: $connectKey)
                    extraConnectFields(entry)
                    Button {
                        Task { await saveConnectKey() }
                    } label: {
                        if isConnecting {
                            ProgressView()
                        } else {
                            Label("Connect Account", systemImage: "key.fill")
                        }
                    }
                    .disabled(connectKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isConnecting)
                }
            }

            if p.canFetch {
                Toggle("Fetch Usage Automatically", isOn: Binding(
                    get: { p.isActive },
                    set: { next in
                        Task {
                            try? await model.setActive(providerId: providerId, isActive: next)
                        }
                    }
                ))
            }

            if let last = p.lastFetchAt {
                LabeledContent("Last Fetch", value: last.formatted())
            }
            if let err = p.lastFetchError, !err.isEmpty {
                Text(err)
                    .font(.caption)
                    .foregroundStyle(Theme.Colors.warning)
            }
        } header: {
            Text("Connect Account")
        } footer: {
            Text(connectionFooter(p, entry: entry))
        }
    }

    @ViewBuilder
    private func extraConnectFields(_ entry: LocalProviderCatalogEntry?) -> some View {
        if entry?.requiresTeamId == true || entry?.adapterKind == "xai" {
            TextField("Team id (required for xAI)", text: $connectTeamId)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
        }
        if entry?.requiresAccountSid == true || entry?.adapterKind == "twilio" {
            TextField("Account SID (required)", text: $connectAccountSid)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            TextField("API Key SID (optional)", text: $connectApiKeySid)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
        }
    }

    private func connectionStatus(_ p: LocalProvider, entry: LocalProviderCatalogEntry?) -> String {
        if p.canFetch { return p.isActive ? "connected · polling" : "connected · paused" }
        if p.needsKey { return "needs API key" }
        if entry?.mode == .subscription { return "recurring fee only" }
        return "not connected"
    }

    private func connectionFooter(_ p: LocalProvider, entry: LocalProviderCatalogEntry?) -> String {
        if p.canFetch {
            return "The key is saved on this phone.  Fetch Usage Automatically runs on refresh.  Turn it off to pause fetch without removing the key."
        }
        if p.isPollable {
            return "This card is empty until you paste a key.  Connect Account saves the key and starts usage fetch."
        }
        if entry?.mode == .keyPlusSubscription {
            return "A key is optional.  Most cost for this service is the Recurring Fee below."
        }
        return "This service does not fetch usage on the phone.  Enter a Recurring Fee below if you pay for it."
    }

    private func saveConnectKey() async {
        isConnecting = true
        defer { isConnecting = false }
        do {
            try await model.connectCredentials(
                providerId: providerId,
                apiKey: connectKey,
                teamId: connectTeamId.isEmpty ? nil : connectTeamId,
                accountSid: connectAccountSid.isEmpty ? nil : connectAccountSid,
                apiKeySid: connectApiKeySid.isEmpty ? nil : connectApiKeySid
            )
            connectKey = ""
            connectTeamId = ""
            connectAccountSid = ""
            connectApiKeySid = ""
            actionError = nil
        } catch {
            actionError = error.localizedDescription
        }
    }

    private func removeConnectKey() async {
        do {
            try await model.disconnectCredentials(providerId: providerId)
            actionError = nil
        } catch {
            actionError = error.localizedDescription
        }
    }

    private func seedFieldsIfNeeded() {
        guard !didSeedFields, let p = provider else { return }
        didSeedFields = true
        if let b = spend?.monthlyBudgetUsd {
            budgetText = b.formatted(.number.precision(.fractionLength(0...2)))
        }
        if let subUsd = spend?.subscriptionChargesUsd, subUsd > 0 {
            feeText = subUsd.formatted(.number.precision(.fractionLength(0...2)))
        }
        feeName = "\(p.displayName) plan"
    }

    private func loadHistory() async {
        guard let snaps = try? await model.snapshots(for: providerId, limit: 48) else {
            historyPoints = []
            return
        }
        // Oldest → newest for sparkline
        let ordered = snaps.reversed()
        let costs = ordered.compactMap(\.totalCost)
        historyPoints = costs
        if let last = costs.last {
            historyCaption = CurrencyFormat.usd(last)
        }
    }
}
