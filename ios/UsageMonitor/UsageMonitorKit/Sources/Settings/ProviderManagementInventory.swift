import SwiftUI
import Observation
import AppCore
import DesignSystem
import Models
import Networking

@MainActor
@Observable
final class ProviderManagementStore {
    private(set) var state: LoadState<[ProviderManagementItem]> = .idle
    private(set) var actionProviderID: String?
    private(set) var actionError: APIError?

    var providers: [ProviderManagementItem] {
        state.value ?? []
    }

    func loadIfNeeded(using client: APIClient) async {
        guard state.value == nil, !state.isLoading else { return }
        await load(using: client, showInitialLoading: true)
    }

    func refresh(using client: APIClient) async {
        await load(using: client, showInitialLoading: state.value == nil)
    }

    func setActive(
        providerID: String,
        isActive: Bool,
        using client: APIClient,
        afterMutation: ManagementMutationHandler
    ) async -> Bool {
        guard actionProviderID == nil,
              let provider = providers.first(where: { $0.id == providerID }),
              provider.canToggleActive
        else {
            return false
        }
        actionProviderID = providerID
        actionError = nil
        defer { actionProviderID = nil }
        do {
            _ = try await client.setProviderActive(id: providerID, isActive: isActive)
            await afterMutation()
            await load(using: client, showInitialLoading: false)
            return actionError == nil
        } catch let apiError as APIError {
            actionError = apiError
            return false
        } catch {
            actionError = .transport(error.localizedDescription)
            return false
        }
    }

    func setMonthlyBudget(
        providerID: String,
        monthlyBudgetUsd: Double?,
        using client: APIClient,
        afterMutation: ManagementMutationHandler
    ) async -> Bool {
        guard actionProviderID == nil,
              let provider = providers.first(where: { $0.id == providerID })
        else {
            return false
        }
        return await mutate(providerID: providerID, using: client, afterMutation: afterMutation) { client in
            _ = try await client.setProviderMonthlyBudget(
                provider: provider,
                monthlyBudgetUsd: monthlyBudgetUsd
            )
        }
    }

    /// Submit the plan editor's full form state (budget, fixed cost, renewal,
    /// billing interval, notes). Editable fields clear on nil; unmanaged plan
    /// fields round-trip from the inventory item.
    func updatePlan(
        providerID: String,
        patch: ProviderPlanPatch,
        using client: APIClient,
        afterMutation: ManagementMutationHandler
    ) async -> Bool {
        guard actionProviderID == nil,
              let provider = providers.first(where: { $0.id == providerID })
        else {
            return false
        }
        return await mutate(providerID: providerID, using: client, afterMutation: afterMutation) { client in
            _ = try await client.updateProviderPlan(provider: provider, patch: patch)
        }
    }

    /// Trigger an immediate provider poll (`POST /api/providers/:id/fetch`)
    /// instead of waiting for the next scheduled refresh.
    func fetchNow(
        providerID: String,
        using client: APIClient,
        afterMutation: ManagementMutationHandler
    ) async -> Bool {
        guard actionProviderID == nil,
              providers.contains(where: { $0.id == providerID })
        else {
            return false
        }
        return await mutate(providerID: providerID, using: client, afterMutation: afterMutation) { client in
            _ = try await client.fetchProviderNow(id: providerID)
        }
    }

    /// Delete a provider. Callers must only offer this when `canDelete` is true.
    func delete(
        providerID: String,
        using client: APIClient,
        afterMutation: ManagementMutationHandler
    ) async -> Bool {
        guard actionProviderID == nil,
              let provider = providers.first(where: { $0.id == providerID }),
              provider.canDelete
        else {
            return false
        }
        return await mutate(providerID: providerID, using: client, afterMutation: afterMutation) { client in
            _ = try await client.deleteProvider(id: providerID)
        }
    }

    private func mutate(
        providerID: String,
        using client: APIClient,
        afterMutation: ManagementMutationHandler,
        action: @MainActor (APIClient) async throws -> Void
    ) async -> Bool {
        actionProviderID = providerID
        actionError = nil
        defer { actionProviderID = nil }
        do {
            try await action(client)
            await afterMutation()
            await load(using: client, showInitialLoading: false)
            return actionError == nil
        } catch let apiError as APIError {
            actionError = apiError
            return false
        } catch {
            actionError = .transport(error.localizedDescription)
            return false
        }
    }

    private func load(using client: APIClient, showInitialLoading: Bool) async {
        if showInitialLoading { state = .loading }
        do {
            let providers = try await client.providerInventory()
            state = .loaded(providers.sorted { left, right in
                if left.isActive != right.isActive { return left.isActive }
                return left.title.localizedCaseInsensitiveCompare(right.title) == .orderedAscending
            })
            actionError = nil
        } catch is CancellationError {
            return
        } catch let apiError as APIError {
            if state.value == nil {
                state = .failed(apiError)
            } else {
                actionError = apiError
            }
        } catch {
            let apiError = APIError.transport(error.localizedDescription)
            if state.value == nil {
                state = .failed(apiError)
            } else {
                actionError = apiError
            }
        }
    }
}

struct ProviderManagementInventoryView: View {
    let client: APIClient
    let afterMutation: ManagementMutationHandler
    @State private var store = ProviderManagementStore()
    @State private var pendingDelete: ProviderManagementItem?

    var body: some View {
        List {
            if store.state.isInitialLoading || store.state == .idle {
                ProviderInventoryLoadingSection()
            } else if let error = store.state.error {
                Section {
                    ErrorState(
                        systemImage: "exclamationmark.triangle.fill",
                        title: error.title,
                        message: error.message,
                        retryTitle: error.isRetryable ? "Try Again" : nil
                    ) {
                        Task { await store.refresh(using: client) }
                    }
                }
                .listRowBackground(Color.clear)
            } else if store.providers.isEmpty {
                Section {
                    EmptyState(
                        systemImage: "square.stack.3d.up.slash",
                        title: "No providers",
                        message: "No provider connections are configured on this monitor."
                    )
                }
                .listRowBackground(Color.clear)
            } else {
                ProviderInventorySummarySection(providers: store.providers)
                // Title+footer requires header:/footer: form — SwiftUI has no
                // Section(_ title:){…} footer:{…} overload (Footer would not be EmptyView).
                Section {
                    ForEach(store.providers) { provider in
                        NavigationLink {
                            ProviderManagementDetailView(
                                providerID: provider.id,
                                store: store,
                                client: client,
                                afterMutation: afterMutation
                            )
                        } label: {
                            ProviderInventoryRow(provider: provider)
                        }
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            if provider.canDelete {
                                Button(role: .destructive) {
                                    pendingDelete = provider
                                } label: {
                                    Label("Delete", systemImage: "trash")
                                }
                                .accessibilityLabel("Delete \(provider.title)")
                            }
                        }
                        .contextMenu {
                            if provider.canFetch {
                                Text("Pollable connection")
                            } else {
                                Text("Manually only — no Fetch")
                            }
                            if provider.canDelete {
                                Button(role: .destructive) {
                                    pendingDelete = provider
                                } label: {
                                    Label("Delete", systemImage: "trash")
                                }
                            }
                        }
                    }
                } header: {
                    Text("Connections")
                } footer: {
                    Text("Swipe left or long-press to delete. Managed (Infisical) providers cannot be deleted — deactivate them instead.")
                }
            }

            if let error = store.actionError {
                Section("Last action") {
                    Label("\(error.title): \(error.message)", systemImage: "exclamationmark.triangle.fill")
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Colors.warning)
                }
            }
        }
        .navigationTitle("Providers")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable {
            await store.refresh(using: client)
        }
        .task {
            await store.loadIfNeeded(using: client)
        }
        .confirmationDialog(
            "Delete this provider?",
            isPresented: Binding(
                get: { pendingDelete != nil },
                set: { if !$0 { pendingDelete = nil } }
            ),
            titleVisibility: .visible,
            presenting: pendingDelete
        ) { provider in
            Button("Delete \(provider.title)", role: .destructive) {
                Task {
                    let success = await store.delete(
                        providerID: provider.id,
                        using: client,
                        afterMutation: afterMutation
                    )
                    success ? Haptics.success() : Haptics.error()
                    pendingDelete = nil
                }
            }
            Button("Cancel", role: .cancel) { pendingDelete = nil }
        } message: { provider in
            Text("“\(provider.title)” will be removed. Providers with API-key attribution history cannot be deleted — deactivate instead.")
        }

    }
}

private struct ProviderInventoryLoadingSection: View {
    var body: some View {
        Section("Connections") {
            ForEach(0..<5, id: \.self) { _ in
                HStack {
                    SkeletonBlock(width: 40, height: 40, radius: Theme.Radius.md)
                    VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                        SkeletonBlock(width: 150, height: 14)
                        SkeletonBlock(width: 100, height: 11)
                    }
                }
                .accessibilityHidden(true)
            }
        }
    }
}

private struct ProviderInventorySummarySection: View {
    let providers: [ProviderManagementItem]

    var body: some View {
        Section("Inventory") {
            LabeledContent("Tracked", value: "\(providers.count)")
            LabeledContent("Active", value: "\(providers.filter(\.isActive).count)")
            LabeledContent(
                "With budgets",
                value: "\(providers.filter { ($0.plan?.monthlyBudgetUsd ?? 0) > 0 }.count)"
            )
            LabeledContent(
                "Managed credentials",
                value: "\(providers.filter { $0.credentialManagement != nil }.count)"
            )
        }
    }
}

private struct ProviderInventoryRow: View {
    let provider: ProviderManagementItem

    var body: some View {
        HStack(spacing: Theme.Spacing.sm) {
            Image(systemName: provider.isActive ? "checkmark.circle.fill" : "pause.circle.fill")
                .font(.title3)
                .foregroundStyle(provider.isActive ? Theme.Colors.success : Theme.Colors.secondaryText)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                Text(provider.title)
                    .foregroundStyle(Theme.Colors.primaryText)
                Text(rowDetail)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
                    .lineLimit(1)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: Theme.Spacing.xxs) {
                Text(provider.spentUsd.map(CurrencyFormat.compactUSD) ?? "Unknown")
                    .font(Theme.Typography.callout.weight(.semibold))
                Text(provider.inventoryStatusLabel)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(provider.title), \(provider.inventoryStatusLabel), \(rowDetail)")
    }

    private var rowDetail: String {
        var parts = [provider.type.capitalized]
        if let budget = provider.plan?.monthlyBudgetUsd, budget > 0 {
            parts.append("\(CurrencyFormat.compactUSD(budget)) budget")
        } else {
            parts.append("no budget")
        }
        if provider.credentialManagement != nil { parts.append("managed") }
        return parts.joined(separator: " · ")
    }
}

private struct ProviderManagementDetailView: View {
    let providerID: String
    let store: ProviderManagementStore
    let client: APIClient
    let afterMutation: ManagementMutationHandler
    @State private var budgetInput = ""
    @State private var didSeedBudget = false
    @State private var showActiveConfirmation = false
    @State private var pendingActiveValue = false
    @State private var notesInput = ""
    @State private var fixedCostInput = ""
    @State private var hasRenewalDate = false
    @State private var renewalDate = Date()
    @State private var billingInterval = ""
    @State private var didSeedPlan = false

    private var provider: ProviderManagementItem? {
        store.providers.first { $0.id == providerID }
    }

    var body: some View {
        Form {
            if let provider {
                ProviderIdentitySection(provider: provider)
                ProviderStatusSection(
                    provider: provider,
                    isBusy: store.actionProviderID == provider.id,
                    requestActiveChange: requestActiveChange
                )
                if provider.canFetch {
                    fetchNowSection(provider)
                } else {
                    manualOnlySection(provider)
                }
                ProviderSpendSection(provider: provider)
                ProviderBudgetSection(
                    provider: provider,
                    budgetInput: $budgetInput,
                    isBusy: store.actionProviderID == provider.id,
                    save: saveBudget
                )
                ProviderPlanSection(
                    fixedCostInput: $fixedCostInput,
                    hasRenewalDate: $hasRenewalDate,
                    renewalDate: $renewalDate,
                    billingInterval: $billingInterval,
                    notesInput: $notesInput,
                    isBusy: store.actionProviderID == provider.id,
                    isFixedCostValid: isFixedCostValid,
                    save: savePlan
                )
                if let error = store.actionError {
                    Section("Action failed") {
                        Label("\(error.title): \(error.message)", systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(Theme.Colors.warning)
                    }
                }
            } else {
                ContentUnavailableView(
                    "Provider unavailable",
                    systemImage: "questionmark.square.dashed",
                    description: Text("Refresh the inventory and try again.")
                )
            }
        }
        .navigationTitle(provider?.title ?? "Provider")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            seedBudgetIfNeeded()
            seedPlanIfNeeded()
        }
        .confirmationDialog(
            pendingActiveValue ? "Activate this provider?" : "Deactivate this provider?",
            isPresented: $showActiveConfirmation,
            titleVisibility: .visible
        ) {
            Button(pendingActiveValue ? "Activate" : "Deactivate", role: pendingActiveValue ? nil : .destructive) {
                applyActiveChange()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(pendingActiveValue
                 ? "The monitor will resume scheduled provider refreshes."
                 : "Scheduled refreshes stop, but existing history is retained.")
        }
    }

    private func seedBudgetIfNeeded() {
        guard !didSeedBudget, let provider else { return }
        didSeedBudget = true
        if let budget = provider.plan?.monthlyBudgetUsd {
            budgetInput = budget.formatted(.number.precision(.fractionLength(0...2)))
        }
    }

    private func seedPlanIfNeeded() {
        guard !didSeedPlan, let provider else { return }
        didSeedPlan = true
        let plan = provider.plan
        notesInput = plan?.notes ?? ""
        if let fixed = plan?.fixedMonthlyCostUsd {
            fixedCostInput = fixed.formatted(.number.precision(.fractionLength(0...2)))
        }
        if let renewal = plan?.renewalDate, !renewal.isEmpty {
            hasRenewalDate = true
            renewalDate = ISO8601DateParser.date(from: renewal)
                ?? Self.renewalDayFormatter.date(from: renewal)
                ?? Date()
        }
        billingInterval = plan?.billingInterval ?? ""
    }

    private func requestActiveChange(_ isActive: Bool) {
        pendingActiveValue = isActive
        showActiveConfirmation = true
    }

    private func applyActiveChange() {
        Task {
            let success = await store.setActive(
                providerID: providerID,
                isActive: pendingActiveValue,
                using: client,
                afterMutation: afterMutation
            )
            success ? Haptics.success() : Haptics.error()
        }
    }

    private func saveBudget() {
        guard let value = parsedBudget else { return }
        Task {
            let success = await store.setMonthlyBudget(
                providerID: providerID,
                monthlyBudgetUsd: value,
                using: client,
                afterMutation: afterMutation
            )
            success ? Haptics.success() : Haptics.error()
        }
    }

    private func savePlan() {
        guard let provider, isFixedCostValid else { return }
        let patch = ProviderPlanPatch(
            // The Budget section owns monthlyBudgetUsd; round-trip the current
            // value so this save never clears it.
            monthlyBudgetUsd: provider.plan?.monthlyBudgetUsd,
            fixedMonthlyCostUsd: parsedFixedCost,
            notes: trimmedOrNil(notesInput),
            renewalDate: hasRenewalDate ? Self.renewalDayFormatter.string(from: renewalDate) : nil,
            billingInterval: billingInterval.isEmpty ? nil : billingInterval
        )
        Task {
            let success = await store.updatePlan(
                providerID: providerID,
                patch: patch,
                using: client,
                afterMutation: afterMutation
            )
            success ? Haptics.success() : Haptics.error()
        }
    }

    private func fetchNow() {
        Task {
            let success = await store.fetchNow(
                providerID: providerID,
                using: client,
                afterMutation: afterMutation
            )
            success ? Haptics.success() : Haptics.error()
        }
    }

    private func fetchNowSection(_ provider: ProviderManagementItem) -> some View {
        Section {
            Button(action: fetchNow) {
                if store.actionProviderID == provider.id {
                    HStack {
                        ProgressView()
                        Text("Working…")
                            .foregroundStyle(Theme.Colors.secondaryText)
                    }
                } else {
                    Label("Fetch usage now", systemImage: "arrow.triangle.2.circlepath")
                }
            }
            .disabled(store.actionProviderID != nil)
        } footer: {
            Text("Polls the provider immediately and records a fresh snapshot. Reported totals may still omit taxes or fees the provider never exposes.")
        }
    }

    private func manualOnlySection(_ provider: ProviderManagementItem) -> some View {
        Section {
            Label("Manually only — no poll", systemImage: "hand.raised")
                .foregroundStyle(Theme.Colors.secondaryText)
        } footer: {
            Text("This connection has no working usage poll. Track spend with a subscription fee, push events, or the web Settings form — a Fetch button would only fail.")
        }
    }

    /// Empty input clears the budget; negative/invalid input disables Save.
    private var parsedBudget: Double?? {
        let trimmed = budgetInput.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return .some(nil) }
        guard let value = Double(trimmed), value.isFinite, value >= 0 else { return nil }
        return .some(value)
    }

    private var isFixedCostValid: Bool {
        let trimmed = fixedCostInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return true }
        guard let value = Double(trimmed) else { return false }
        return value.isFinite && value >= 0
    }

    /// Empty input clears the fixed cost (JSON null on the wire).
    private var parsedFixedCost: Double? {
        let trimmed = fixedCostInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let value = Double(trimmed), value.isFinite, value >= 0 else { return nil }
        return value
    }

    private func trimmedOrNil(_ value: String) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// Renewal dates are submitted as `yyyy-MM-dd`; the server parses them as
    /// calendar dates (`parseNullableDate`).
    private static let renewalDayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()
}

private struct ProviderIdentitySection: View {
    let provider: ProviderManagementItem

    var body: some View {
        Section("Connection") {
            LabeledContent("Provider", value: provider.name)
            LabeledContent("Type", value: provider.type.capitalized)
            if let label = provider.label, !label.isEmpty {
                LabeledContent("Account", value: label)
            }
            if let keyPreview = provider.keyPreview, !keyPreview.isEmpty {
                LabeledContent("Credential", value: keyPreview)
                    .privacySensitive()
            }
            LabeledContent("Refresh", value: "Every \(provider.refreshIntervalMin) min")
        }
    }
}

private struct ProviderStatusSection: View {
    let provider: ProviderManagementItem
    let isBusy: Bool
    let requestActiveChange: (Bool) -> Void

    var body: some View {
        Section {
            Toggle(
                isOn: Binding(
                    get: { provider.isActive },
                    set: requestActiveChange
                )
            ) {
                Label("Scheduled refresh", systemImage: "arrow.triangle.2.circlepath")
            }
            .tint(Theme.Colors.accent)
            .disabled(isBusy || !provider.canToggleActive)

            if isBusy {
                HStack {
                    ProgressView()
                    Text("Applying change…")
                        .foregroundStyle(Theme.Colors.secondaryText)
                }
            }
        } header: {
            Text("Status")
        } footer: {
            if let management = provider.credentialManagement,
               management.readOnlyFields.contains("isActive") {
                Text("Active state is read-only because this credential is managed by \(management.source.capitalized).")
            } else {
                Text("Deactivating stops scheduled refreshes without deleting usage history.")
            }
        }
    }
}

private struct ProviderSpendSection: View {
    let provider: ProviderManagementItem

    var body: some View {
        Section {
            LabeledContent("Spent", value: provider.spentUsd.map(CurrencyFormat.usd) ?? "Unknown")
            LabeledContent("Projected", value: provider.projectedEomUsd.map(CurrencyFormat.usd) ?? "Unknown")
            LabeledContent("Coverage", value: provider.spendCoverage?.label ?? "Unknown")
            if let balance = provider.latestSnapshot?.balance {
                LabeledContent("Balance", value: CurrencyFormat.usd(balance))
            }
            if let date = provider.latestSnapshotDate {
                LabeledContent("Last refresh", value: date.formatted(.relative(presentation: .named)))
            }
        } header: {
            Text("Current month")
        } footer: {
            Text(spendFooter)
        }
    }

    private var spendFooter: String {
        switch provider.spendCoverage {
        case .complete:
            return "Provider-reported totals. Sales tax, VAT, and invoice-only fees appear only when the provider includes them in the API."
        case .partial, .legacyUnknown:
            return "Partial coverage — usage and/or plan fees may be incomplete. Taxes and invoice adjustments often never appear in the API."
        case .unknown, .none:
            return "Spend is best-effort. Most APIs omit taxes and some fixed fees; set fixed monthly cost or a subscription when you know the real bill."
        }
    }
}

private struct ProviderBudgetSection: View {
    let provider: ProviderManagementItem
    @Binding var budgetInput: String
    let isBusy: Bool
    let save: () -> Void

    private var isValid: Bool {
        let trimmed = budgetInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return true }
        guard let value = Double(trimmed) else { return false }
        return value.isFinite && value >= 0
    }

    var body: some View {
        Section {
            HStack {
                Text("$")
                    .foregroundStyle(Theme.Colors.secondaryText)
                TextField("No budget", text: $budgetInput)
                    .keyboardType(.decimalPad)
                    .multilineTextAlignment(.trailing)
                    .accessibilityLabel("Monthly budget in US dollars")
            }
            Button(action: save) {
                if isBusy {
                    ProgressView()
                } else {
                    Label("Save monthly budget", systemImage: "checkmark.circle")
                }
            }
            .disabled(isBusy || !isValid)
        } header: {
            Text("Budget")
        } footer: {
            Text(isValid
                 ? "Leave blank to remove the budget. Other provider-plan settings are preserved."
                 : "Enter a non-negative amount using a decimal point.")
                .foregroundStyle(isValid ? Theme.Colors.secondaryText : Theme.Colors.danger)
        }
    }
}

/// The wider provider-plan editor: fixed monthly cost, renewal date, billing
/// interval, and notes (I6). Unmanaged plan fields (billing mode, request
/// limit, low-balance/credit thresholds) round-trip untouched server-side.
private struct ProviderPlanSection: View {
    @Binding var fixedCostInput: String
    @Binding var hasRenewalDate: Bool
    @Binding var renewalDate: Date
    @Binding var billingInterval: String
    @Binding var notesInput: String
    let isBusy: Bool
    let isFixedCostValid: Bool
    let save: () -> Void

    var body: some View {
        Section {
            HStack {
                Text("$")
                    .foregroundStyle(Theme.Colors.secondaryText)
                TextField("No fixed cost", text: $fixedCostInput)
                    .keyboardType(.decimalPad)
                    .multilineTextAlignment(.trailing)
                    .accessibilityLabel("Fixed monthly cost in US dollars")
            }
            Toggle("Renewal date", isOn: $hasRenewalDate.animation())
                .tint(Theme.Colors.accent)
            if hasRenewalDate {
                DatePicker(
                    "Renews on",
                    selection: $renewalDate,
                    displayedComponents: .date
                )
            }
            Picker("Billing interval", selection: $billingInterval) {
                Text("None").tag("")
                Text("Weekly").tag("weekly")
                Text("Monthly").tag("monthly")
                Text("Quarterly").tag("quarterly")
                Text("Annual").tag("annual")
            }
            TextField("Notes", text: $notesInput, axis: .vertical)
                .lineLimit(3, reservesSpace: false)
            Button(action: save) {
                if isBusy {
                    ProgressView()
                } else {
                    Label("Save plan", systemImage: "checkmark.circle")
                }
            }
            .disabled(isBusy || !isFixedCostValid)
        } header: {
            Text("Plan")
        } footer: {
            if !isFixedCostValid {
                Text("Enter a non-negative amount using a decimal point.")
                    .foregroundStyle(Theme.Colors.danger)
            } else {
                Text("Model a recurring fee EITHER as a fixed monthly cost here OR as a tracked Subscription — the server rejects a plan price while an active/considering subscription exists, to avoid double-counting. Blank fields clear the stored value.")
            }
        }
    }
}
