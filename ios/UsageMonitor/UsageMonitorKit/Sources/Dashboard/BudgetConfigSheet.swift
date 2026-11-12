import SwiftUI
import DesignSystem
import Models
import Networking

/// Budget configuration sheet opened from the Overview hero card
/// (owner 2026-08-31: tapping the budget card should open a config popup).
///
/// The hero's "overall budget" is the SUM of per-provider monthly budgets
/// (see `DashboardViewData.totalBudget`), so this sheet edits exactly those
/// inputs: one row per provider, blank clears the budget.  Saves go through
/// `APIClient.setProviderMonthlyBudget` (session-gated; plan fields are
/// round-tripped so partial updates are never destructive).
struct BudgetConfigSheet: View {
    let providers: [ProviderBudgetStatus]
    let client: APIClient?
    let onSaved: () -> Void
    let onRequestSignIn: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var inputs: [String: String] = [:]
    @State private var isSaving = false
    @State private var errorMessage: String?
    @State private var needsSignIn = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ForEach(providers) { provider in
                        HStack {
                            Text(provider.title)
                                .lineLimit(1)
                            Spacer()
                            Text("$")
                                .foregroundStyle(Theme.Colors.secondaryText)
                            TextField("None", text: binding(for: provider.id))
                                .keyboardType(.decimalPad)
                                .multilineTextAlignment(.trailing)
                                .frame(maxWidth: 100)
                                .accessibilityLabel("\(provider.title) monthly budget in US dollars")
                        }
                    }
                } header: {
                    Text("Provider monthly budgets")
                } footer: {
                    Text(footerText)
                        .foregroundStyle(allValid ? Theme.Colors.secondaryText : Theme.Colors.danger)
                }

                if needsSignIn {
                    Section {
                        Button {
                            dismiss()
                            onRequestSignIn()
                        } label: {
                            Label("Sign in for full access", systemImage: "lock.open.fill")
                        }
                    } footer: {
                        Text("Editing budgets requires a dashboard session.  Sign in with the dashboard password from Settings.")
                    }
                }

                if let errorMessage {
                    Section {
                        Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.Colors.warning)
                    }
                }
            }
            .navigationTitle("Budget")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving {
                        ProgressView()
                    } else {
                        Button("Save") { Task { await save() } }
                            .disabled(!canSave)
                    }
                }
            }
            .onAppear { seedInputs() }
            .interactiveDismissDisabled(isSaving)
        }
    }

    // MARK: - Input state

    private func seedInputs() {
        guard inputs.isEmpty else { return }
        for provider in providers {
            if let budget = provider.monthlyBudgetUsd, budget > 0 {
                inputs[provider.id] = budget.formatted(
                    .number.precision(.fractionLength(0...2)).grouping(.never)
                )
            } else {
                inputs[provider.id] = ""
            }
        }
    }

    private func binding(for id: String) -> Binding<String> {
        Binding(
            get: { inputs[id] ?? "" },
            set: { inputs[id] = $0 }
        )
    }

    /// Empty input clears the budget; negative/invalid input blocks Save.
    private func parsed(_ raw: String) -> Double?? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return .some(nil) }
        guard let value = Double(trimmed), value.isFinite, value >= 0 else { return nil }
        return .some(value)
    }

    private var allValid: Bool {
        inputs.values.allSatisfy { parsed($0) != nil }
    }

    /// Providers whose entered value differs from the current budget.
    private var changedIDs: [String] {
        providers.compactMap { provider in
            guard case let .some(newValue) = parsed(inputs[provider.id] ?? "") else { return nil }
            let current = (provider.monthlyBudgetUsd ?? 0) > 0 ? provider.monthlyBudgetUsd : nil
            return newValue == current ? nil : provider.id
        }
    }

    private var canSave: Bool {
        allValid && !changedIDs.isEmpty && !isSaving && client != nil
    }

    private var footerText: String {
        guard allValid else {
            return "Enter non-negative amounts using a decimal point."
        }
        let total = providers.reduce(0.0) { sum, provider in
            guard case let .some(.some(value)) = parsed(inputs[provider.id] ?? "") else { return sum }
            return sum + value
        }
        let formatted = total.formatted(.currency(code: "USD").precision(.fractionLength(0)))
        return "These budgets sum to the overall budget shown on the Overview card: \(formatted)/mo.  Leave blank to remove a budget."
    }

    // MARK: - Save

    @MainActor
    private func save() async {
        guard let client else {
            needsSignIn = true
            return
        }
        isSaving = true
        errorMessage = nil
        needsSignIn = false
        defer { isSaving = false }

        do {
            let inventory = try await client.providerInventory()
            for id in changedIDs {
                guard case let .some(newValue) = parsed(inputs[id] ?? "") else { continue }
                guard let item = inventory.first(where: { $0.id == id }) else {
                    errorMessage = "\(id) is missing from the management inventory."
                    Haptics.error()
                    return
                }
                _ = try await client.setProviderMonthlyBudget(
                    provider: item,
                    monthlyBudgetUsd: newValue
                )
            }
            Haptics.success()
            onSaved()
            dismiss()
        } catch let error as APIError {
            switch error {
            case .unauthorized, .missingToken, .forbidden:
                needsSignIn = true
                errorMessage = "Full access required to edit budgets."
            default:
                errorMessage = error.localizedDescription
            }
            Haptics.error()
        } catch {
            errorMessage = error.localizedDescription
            Haptics.error()
        }
    }
}
