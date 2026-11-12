import SwiftUI
import DesignSystem
import LocalStore
import LocalBudget
import UniformTypeIdentifiers
#if canImport(UIKit)
import UIKit
#endif

// MARK: - Fleet (Computers & Server Status in Local Monitor)

struct LocalFleetTab: View {
    @Bindable var model: LocalAppModel
    private var isDemo: Bool {
        LocalScreenshotDemoSeeder.isEnabled
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    let hostVal = isDemo ? "jays.services (jay · macbook.boa-roygbiv.ts.net)" : "Local Device"
                    LabeledContent("Host", value: hostVal)
                        .copyableRow(label: "Host", value: hostVal)
                    let chipVal = isDemo ? "Apple M5" : "iOS Device"
                    LabeledContent("Chip", value: chipVal)
                        .copyableRow(label: "Chip", value: chipVal)
                    let cpuVal = isDemo ? "14.2%" : "N/A"
                    LabeledContent("CPU Load", value: cpuVal)
                        .copyableRow(label: "CPU Load", value: cpuVal)
                    let memVal = isDemo ? "59.7%" : "N/A"
                    LabeledContent("Memory", value: memVal)
                        .copyableRow(label: "Memory", value: memVal)
                    let diskVal = isDemo ? "87%" : "N/A"
                    LabeledContent("Data Disk", value: diskVal)
                        .copyableRow(label: "Data Disk", value: diskVal)
                    let statusVal = isDemo ? "Online" : "Standalone"
                    LabeledContent("Status") {
                        if isDemo {
                            StatusBadge("Online", status: .ok, systemImage: "laptopcomputer")
                        } else {
                            StatusBadge("Standalone", status: .neutral, systemImage: "iphone")
                        }
                    }
                    .copyableRow(label: "Status", value: statusVal)
                } header: {
                    Text("Mac Host")
                } footer: {
                    Text(isDemo ? "Hardware and local health stats from this Mac." : "Local Data Plane runs standalone on this device. Remote Mac host telemetry is not connected.")
                }

                Section {
                    let syncVal = isDemo ? "Running" : "Not Connected"
                    LabeledContent("ag***-s**c") {
                        StatusBadge(syncVal, status: isDemo ? .ok : .neutral, systemImage: isDemo ? "checkmark.circle.fill" : "circle")
                    }
                    .copyableRow(label: "ag***-s**c", value: syncVal)
                    // Not-enabled services are intentionally not listed
                    // (owner 2026-08-31: no flags/rows for disabled processes).
                } header: {
                    Text("Local Services")
                }

                Section {
                    let agentState = isDemo ? "Active on Mac" : "Remote Only"
                    LabeledContent("Claude Code / Desktop") {
                        StatusBadge(agentState, status: isDemo ? .ok : .neutral, systemImage: isDemo ? "checkmark.circle.fill" : "circle")
                    }
                    .copyableRow(label: "Claude Code", value: agentState)
                    LabeledContent("Cursor") {
                        StatusBadge(agentState, status: isDemo ? .ok : .neutral, systemImage: isDemo ? "checkmark.circle.fill" : "circle")
                    }
                    .copyableRow(label: "Cursor", value: agentState)
                    LabeledContent("Grok Build & Leader") {
                        StatusBadge(agentState, status: isDemo ? .ok : .neutral, systemImage: isDemo ? "checkmark.circle.fill" : "circle")
                    }
                    .copyableRow(label: "Grok Build & Leader", value: agentState)
                    LabeledContent("OpenAI Codex") {
                        StatusBadge(agentState, status: isDemo ? .ok : .neutral, systemImage: isDemo ? "checkmark.circle.fill" : "circle")
                    }
                    .copyableRow(label: "OpenAI Codex", value: agentState)
                    LabeledContent("Antigravity") {
                        StatusBadge(agentState, status: isDemo ? .ok : .neutral, systemImage: isDemo ? "checkmark.circle.fill" : "circle")
                    }
                    .copyableRow(label: "Antigravity", value: agentState)
                    LabeledContent("GitHub Copilot") {
                        StatusBadge(agentState, status: isDemo ? .ok : .neutral, systemImage: isDemo ? "checkmark.circle.fill" : "circle")
                    }
                    .copyableRow(label: "GitHub Copilot", value: agentState)
                } header: {
                    Text("Coding Agents")
                } footer: {
                    Text(isDemo ? "Live execution state of agentic coding platforms on Mac." : "Mac daemon and coding agent monitoring require connection to a Mac server host.")
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Fleet & Computers")
            .navigationBarTitleDisplayMode(.inline)
            .refreshable {
                try? await model.reload()
            }
        }
    }
}

// MARK: - Alerts

struct LocalAlertsTab: View {
    @Bindable var model: LocalAppModel
    var openProvider: (String) -> Void
    var openNeedsKey: (() -> Void)? = nil

    var body: some View {
        NavigationStack {
            Group {
                if model.alerts.isEmpty {
                    ContentUnavailableView(
                        "All Clear",
                        systemImage: "checkmark.seal.fill",
                        description: Text("Budget and fetch issues show up here. Phone-local rules only — no fleet Slack/PagerDuty.")
                    )
                } else {
                    List {
                        Section {
                            ForEach(model.alerts) { alert in
                                Button {
                                    if let id = alert.providerId {
                                        openProvider(id)
                                    } else if alert.id == "needs-key-many" {
                                        openNeedsKey?()
                                    }
                                } label: {
                                    HStack(alignment: .top, spacing: Theme.Spacing.md) {
                                        Image(systemName: symbol(for: alert.severity))
                                            .foregroundStyle(color(for: alert.severity))
                                            .frame(width: 28)
                                        VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                                            Text(alert.title)
                                                .font(Theme.Typography.callout.weight(.semibold))
                                                .foregroundStyle(Theme.Colors.primaryText)
                                            Text(alert.message)
                                                .font(Theme.Typography.caption)
                                                .foregroundStyle(Theme.Colors.secondaryText)
                                                .fixedSize(horizontal: false, vertical: true)
                                        }
                                    }
                                }
                            }
                        } footer: {
                            Text("\(model.alerts.count) open · derived on-device from budgets and poll errors")
                        }
                    }
                    .listStyle(.insetGrouped)
                }
            }
            .navigationTitle("Alerts")
            .navigationBarTitleDisplayMode(.inline)
            .refreshable { try? await model.reload() }
        }
    }

    private func symbol(for severity: LocalAlertItem.Severity) -> String {
        switch severity {
        case .critical: return "exclamationmark.octagon.fill"
        case .warning: return "exclamationmark.triangle.fill"
        case .info: return "info.circle.fill"
        }
    }

    private func color(for severity: LocalAlertItem.Severity) -> Color {
        switch severity {
        case .critical: return Theme.Colors.danger
        case .warning: return Theme.Colors.warning
        case .info: return Theme.Colors.accent
        }
    }
}

// MARK: - Projects

struct LocalProjectsTab: View {
    @Bindable var model: LocalAppModel
    @State private var showAdd = false
    @State private var editProject: LocalProject?
    @State private var spentByProject: [String: Double] = [:]

    var body: some View {
        NavigationStack {
            List {
                if model.projects.isEmpty {
                    ContentUnavailableView(
                        "No Projects",
                        systemImage: "folder",
                        description: Text("Tag spend with project budgets (direct charges only). Residual % allocation stays on the web.")
                    )
                } else {
                    Section {
                        let totalSpent = spentByProject.values.reduce(0, +)
                        let budgeted = model.projects.compactMap(\.monthlyBudgetUsd).filter { $0 > 0 }
                        let totalBudget = budgeted.reduce(0, +)
                        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                            Text("All Projects")
                                .font(Theme.Typography.caption)
                                .foregroundStyle(Theme.Colors.secondaryText)
                            Text(CurrencyFormat.usd(totalSpent))
                                .font(Theme.Typography.hero)
                                .monospacedDigit()
                            if totalBudget > 0 {
                                LabeledBudgetMeter(
                                    title: "Budget",
                                    detail: "\(CurrencyFormat.usd(totalSpent)) of \(CurrencyFormat.usd(totalBudget))",
                                    fraction: totalSpent / totalBudget,
                                    status: meterStatus(spent: totalSpent, budget: totalBudget)
                                )
                            } else {
                                Text("no budget set")
                                    .font(Theme.Typography.caption)
                                    .foregroundStyle(Theme.Colors.secondaryText)
                            }
                            Text("\(model.projects.count) project\(model.projects.count == 1 ? "" : "s") · direct charges only")
                                .font(Theme.Typography.caption)
                                .foregroundStyle(Theme.Colors.tertiaryText)
                        }
                        .padding(.vertical, Theme.Spacing.xxs)
                    }

                    ForEach(model.projects) { project in
                        Button {
                            editProject = project
                        } label: {
                            VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                                HStack {
                                    Text(project.name)
                                        .font(Theme.Typography.callout.weight(.semibold))
                                        .foregroundStyle(Theme.Colors.primaryText)
                                    Spacer()
                                    Text(CurrencyFormat.usd(spentByProject[project.id] ?? 0))
                                        .font(Theme.Typography.callout.weight(.semibold))
                                        .monospacedDigit()
                                }
                                if let budget = project.monthlyBudgetUsd, budget > 0 {
                                    let spent = spentByProject[project.id] ?? 0
                                    LabeledBudgetMeter(
                                        title: "Budget",
                                        detail: "\(CurrencyFormat.usd(spent)) of \(CurrencyFormat.usd(budget))",
                                        fraction: spent / budget,
                                        status: meterStatus(spent: spent, budget: budget)
                                    )
                                } else {
                                    Text("no budget set")
                                        .font(Theme.Typography.caption)
                                        .foregroundStyle(Theme.Colors.secondaryText)
                                }
                            }
                            .padding(.vertical, Theme.Spacing.xxs)
                        }
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            Button(role: .destructive) {
                                Task { try? await model.deleteProject(id: project.id) }
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                        }
                    }
                }
            }
            .navigationTitle("Projects")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showAdd = true } label: {
                        Image(systemName: "plus")
                    }
                }
            }
            .sheet(isPresented: $showAdd) {
                ProjectEditorSheet(model: model, existing: nil)
            }
            .sheet(item: $editProject) { project in
                ProjectEditorSheet(model: model, existing: project)
            }
            .task { await refreshSpend() }
            .refreshable {
                try? await model.reload()
                await refreshSpend()
            }
        }
    }

    private func refreshSpend() async {
        var map: [String: Double] = [:]
        for p in model.projects {
            map[p.id] = (try? await model.projectSpentUsd(projectId: p.id)) ?? 0
        }
        spentByProject = map
    }

    private func meterStatus(spent: Double, budget: Double) -> Theme.SemanticStatus {
        let r = spent / budget
        if r >= 1 { return .danger }
        if r >= 0.8 { return .warning }
        return .ok
    }
}

private struct ProjectEditorSheet: View {
    @Bindable var model: LocalAppModel
    let existing: LocalProject?
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var description = ""
    @State private var budget = ""
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Project") {
                    TextField("Name", text: $name)
                    TextField("Description", text: $description, axis: .vertical)
                    HStack {
                        Text("$")
                        TextField("Monthly budget (optional)", text: $budget)
                            .keyboardType(.decimalPad)
                    }
                }
                if let error {
                    Text(error).foregroundStyle(Theme.Colors.danger)
                }
            }
            .navigationTitle(existing == nil ? "Add project" : "Edit project")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await save() } }
                        .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .onAppear {
                if let existing {
                    name = existing.name
                    description = existing.description ?? ""
                    if let b = existing.monthlyBudgetUsd {
                        budget = b.formatted(.number.precision(.fractionLength(0...2)))
                    }
                }
            }
        }
    }

    private func save() async {
        let trimmedBudget = budget.trimmingCharacters(in: .whitespacesAndNewlines)
        let budgetValue: Double? = trimmedBudget.isEmpty ? nil : Double(trimmedBudget)
        do {
            try await model.upsertProject(
                name: name,
                description: description.isEmpty ? nil : description,
                monthlyBudgetUsd: budgetValue,
                id: existing?.id
            )
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

// MARK: - Export share

struct LocalExportButton: View {
    @Bindable var model: LocalAppModel
    @State private var shareURL: URL?
    @State private var isExporting = false
    @State private var error: String?

    var body: some View {
        Button {
            Task { await export() }
        } label: {
            if isExporting {
                ProgressView()
            } else {
                Label("Export Data (No Secrets)", systemImage: "square.and.arrow.up")
            }
        }
        .disabled(isExporting)
        .contentShape(Rectangle())
        .frame(minHeight: 44)
        .sheet(isPresented: Binding(
            get: { shareURL != nil },
            set: { if !$0 { shareURL = nil } }
        )) {
            if let shareURL {
                ShareSheet(items: [shareURL])
            }
        }
        if let error {
            Text(error)
                .font(.caption)
                .foregroundStyle(Theme.Colors.danger)
        }
    }

    private func export() async {
        isExporting = true
        error = nil
        defer { isExporting = false }
        do {
            let data = try await model.exportPackageJSON()
            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent("usage-monitor-local-export-\(Int(Date().timeIntervalSince1970)).json")
            try data.write(to: url, options: .atomic)
            shareURL = url
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// Shared state for Import Package.  Merge vs Replace is chosen *after* the
/// file picker so a List Picker cannot swallow the button tap (owner 2026-09-04
/// and 2026-09-13: tapping Import always opened the Merge / Replace dropdown).
@MainActor
@Observable
final class LocalImportState {
    var isImporting: Bool = false
    var message: String? = nil
    var isImportError: Bool = false
    var showImporter: Bool = false
    var pendingData: Data? = nil
    var showModeSheet: Bool = false
}

struct LocalImportButton: View {
    @Bindable var model: LocalAppModel
    @Bindable var state: LocalImportState

    private static var packageTypes: [UTType] {
        var types: [UTType] = [.json, .data]
        if let umexport = UTType(filenameExtension: "umexport") {
            types.append(umexport)
        }
        return types
    }

    var body: some View {
        Button {
            state.showImporter = true
        } label: {
            if state.isImporting {
                ProgressView()
            } else {
                Label("Import Package", systemImage: "square.and.arrow.down")
            }
        }
        .disabled(state.isImporting)
        .buttonStyle(.borderless)
        .contentShape(Rectangle())
        .frame(maxWidth: .infinity, alignment: .leading)
        .frame(minHeight: 44)
        .fileImporter(
            isPresented: $state.showImporter,
            allowedContentTypes: Self.packageTypes,
            allowsMultipleSelection: false
        ) { result in
            handlePick(result)
        }
        .sheet(isPresented: $state.showModeSheet, onDismiss: {
            if !state.isImporting {
                state.pendingData = nil
            }
        }) {
            LocalImportModeSheet(model: model, state: state)
        }
    }

    private func handlePick(_ result: Result<[URL], Error>) {
        do {
            let urls = try result.get()
            guard let url = urls.first else { return }
            let access = url.startAccessingSecurityScopedResource()
            defer { if access { url.stopAccessingSecurityScopedResource() } }
            state.pendingData = try Data(contentsOf: url)
            state.message = nil
            state.isImportError = false
            Task { @MainActor in
                // fileImporter must finish dismissing before another sheet presents.
                try? await Task.sleep(nanoseconds: 400_000_000)
                guard state.pendingData != nil else { return }
                state.showModeSheet = true
            }
        } catch {
            state.isImportError = true
            state.message = error.localizedDescription
            state.pendingData = nil
        }
    }
}

private struct LocalImportModeSheet: View {
    @Bindable var model: LocalAppModel
    @Bindable var state: LocalImportState
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("Use the JSON from usage.jays.services (Download For Local) or a phone export.  There is no bundle key or passphrase for this file.  API keys are never included.")
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Colors.secondaryText)
                }
                Section {
                    Button("Merge (Skip Existing)") {
                        Task { await run(.merge) }
                    }
                    .disabled(state.isImporting || state.pendingData == nil)
                    Button("Replace All Data", role: .destructive) {
                        Task { await run(.replace) }
                    }
                    .disabled(state.isImporting || state.pendingData == nil)
                } footer: {
                    Text("Merge keeps cards already on this phone.  Replace All wipes local money data first, then loads the file.")
                }
                if state.isImporting {
                    Section {
                        HStack(spacing: Theme.Spacing.sm) {
                            ProgressView()
                            Text("Importing…")
                        }
                    }
                }
            }
            .navigationTitle("Import Package")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        state.pendingData = nil
                        dismiss()
                    }
                    .disabled(state.isImporting)
                }
            }
            .interactiveDismissDisabled(state.isImporting)
        }
    }

    private func run(_ mode: LocalImportMode) async {
        guard let data = state.pendingData else { return }
        state.isImporting = true
        defer { state.isImporting = false }
        do {
            let r = try await model.importPackage(data: data, mode: mode)
            state.isImportError = false
            state.message = r.summaryLine
            state.pendingData = nil
            dismiss()
        } catch {
            state.isImportError = true
            state.message = error.localizedDescription
        }
    }
}

struct LocalImportMessage: View {
    @Bindable var state: LocalImportState

    var body: some View {
        if let message = state.message {
            Text(message)
                .font(.caption)
                .foregroundStyle(state.isImportError ? Theme.Colors.danger : Theme.Colors.secondaryText)
        }
    }
}

struct LocalKeysImportButton: View {
    @Bindable var model: LocalAppModel
    @State private var showImporter = false
    @State private var pendingBundle: Data?
    @State private var message: String?
    @State private var messageIsError = false
    @State private var isImporting = false

    private static var bundleTypes: [UTType] {
        var types: [UTType] = []
        if let umkeys = UTType(filenameExtension: "umkeys") {
            types.append(umkeys)
        }
        types.append(.json)
        types.append(.data)
        return types
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Button {
                showImporter = true
            } label: {
                if isImporting {
                    ProgressView()
                } else {
                    Label("Import Keys", systemImage: "key.horizontal.fill")
                }
            }
            .disabled(isImporting)
            if let message {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(messageIsError ? Theme.Colors.danger : Theme.Colors.secondaryText)
            }
            Text("This is only for a Mac .umkeys file, not the website JSON.  Keys go to this device's Keychain.  Delete the bundle file after importing.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .fileImporter(
            isPresented: $showImporter,
            allowedContentTypes: Self.bundleTypes,
            allowsMultipleSelection: false
        ) { result in
            handlePick(result)
        }
        .sheet(isPresented: Binding(
            get: { pendingBundle != nil },
            set: { if !$0 { pendingBundle = nil } }
        )) {
            if let pendingBundle {
                LocalKeysPassphraseSheet(model: model, bundle: pendingBundle) { line, failed in
                    message = line
                    messageIsError = failed
                }
            }
        }
    }

    private func handlePick(_ result: Result<[URL], Error>) {
        do {
            let urls = try result.get()
            guard let url = urls.first else { return }
            let access = url.startAccessingSecurityScopedResource()
            defer { if access { url.stopAccessingSecurityScopedResource() } }
            pendingBundle = try Data(contentsOf: url)
            message = nil
            messageIsError = false
        } catch {
            message = error.localizedDescription
            messageIsError = true
        }
    }
}

private struct LocalKeysPassphraseSheet: View {
    @Bindable var model: LocalAppModel
    let bundle: Data
    let onFinish: (String, Bool) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var passphrase = ""
    @State private var error: String?
    @State private var isWorking = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    SecureField("Bundle passphrase", text: $passphrase)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } footer: {
                    Text("Enter the passphrase used when the bundle was created.  Keys are written to this device's Keychain only.")
                }
                if let error {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(Theme.Colors.danger)
                }
            }
            .navigationTitle("Import Keys")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Import") { Task { await run() } }
                        .disabled(isWorking || passphrase.isEmpty)
                }
            }
            .interactiveDismissDisabled(isWorking)
        }
    }

    private func run() async {
        isWorking = true
        error = nil
        defer { isWorking = false }
        do {
            let r = try await LocalKeysImportBuilder.importBundle(
                data: bundle,
                passphrase: passphrase,
                model: model
            )
            var line = "Imported \(r.imported) key\(r.imported == 1 ? "" : "s")"
            if r.replaced > 0 { line += ", replaced \(r.replaced)" }
            if r.skippedUnknown > 0 { line += ", skipped \(r.skippedUnknown) unknown" }
            line += "."
            if let c = r.configResult {
                line += "  Config: \(c.providers) providers, \(c.subscriptions) fees, \(c.snapshots) snapshots."
            }
            line += "  Delete the bundle file now — this app cannot delete the original."
            onFinish(line, false)
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

#if canImport(UIKit)
private struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }
    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}
#endif
