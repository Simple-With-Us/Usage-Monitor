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
        actionProviderID = providerID
        actionError = nil
        defer { actionProviderID = nil }
        do {
            _ = try await client.setProviderMonthlyBudget(
                provider: provider,
                monthlyBudgetUsd: monthlyBudgetUsd
            )
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
                Section("Connections") {
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
                    }
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
                Text("month to date")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(provider.title), \(provider.isActive ? "active" : "inactive"), \(rowDetail)")
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
                ProviderSpendSection(provider: provider)
                ProviderBudgetSection(
                    provider: provider,
                    budgetInput: $budgetInput,
                    isBusy: store.actionProviderID == provider.id,
                    save: saveBudget
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

    /// Empty input clears the budget; negative/invalid input disables Save.
    private var parsedBudget: Double?? {
        let trimmed = budgetInput.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return .some(nil) }
        guard let value = Double(trimmed), value.isFinite, value >= 0 else { return nil }
        return .some(value)
    }
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
        Section("Current month") {
            LabeledContent("Spent", value: provider.spentUsd.map(CurrencyFormat.usd) ?? "Unknown")
            LabeledContent("Projected", value: provider.projectedEomUsd.map(CurrencyFormat.usd) ?? "Unknown")
            LabeledContent("Coverage", value: provider.spendCoverage?.label ?? "Unknown")
            if let balance = provider.latestSnapshot?.balance {
                LabeledContent("Balance", value: CurrencyFormat.usd(balance))
            }
            if let date = provider.latestSnapshotDate {
                LabeledContent("Last refresh", value: date.formatted(.relative(presentation: .named)))
            }
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
