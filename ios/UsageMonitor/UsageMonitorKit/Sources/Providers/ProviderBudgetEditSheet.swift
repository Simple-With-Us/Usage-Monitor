import SwiftUI
import DesignSystem
import Models
import Networking

/// Sheet for editing a provider's monthly budget from Provider detail.
///
/// Mirrors Settings → Provider inventory's budget field: empty clears the
/// budget; non-negative decimals save via `APIClient.setProviderMonthlyBudget`
/// (session-gated). Loads inventory first so other plan fields round-trip
/// safely, matching the server's full-plan-preserving mutation contract.
struct ProviderBudgetEditSheet: View {
    let providerID: String
    let providerTitle: String
    let currentBudgetUsd: Double?
    let client: APIClient?
    let onSaved: () -> Void
    let onRequestSignIn: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var budgetInput = ""
    @State private var isSaving = false
    @State private var isLoadingInventory = false
    @State private var errorMessage: String?
    @State private var needsSignIn = false
    @FocusState private var fieldFocused: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack {
                        Text("$")
                            .foregroundStyle(Theme.Colors.secondaryText)
                        TextField("No budget", text: $budgetInput)
                            .keyboardType(.decimalPad)
                            .multilineTextAlignment(.trailing)
                            .focused($fieldFocused)
                            .accessibilityLabel("Monthly budget in US dollars")
                    }
                } header: {
                    Text("Monthly budget")
                } footer: {
                    Text(footerText)
                        .foregroundStyle(isValid ? Theme.Colors.secondaryText : Theme.Colors.danger)
                }

                if needsSignIn {
                    Section {
                        Button {
                            onRequestSignIn()
                        } label: {
                            Label("Sign in for full access", systemImage: "lock.open.fill")
                        }
                    } footer: {
                        Text("Editing budgets requires a dashboard session. Sign in with the dashboard password from Settings.")
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
            .navigationTitle(providerTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await save() } }
                        .disabled(!canSave)
                }
            }
            .onAppear {
                if let currentBudgetUsd, currentBudgetUsd > 0 {
                    budgetInput = currentBudgetUsd.formatted(
                        .number.precision(.fractionLength(0...2)).grouping(.never)
                    )
                }
                fieldFocused = true
            }
            .interactiveDismissDisabled(isSaving)
        }
    }

    private var footerText: String {
        if !isValid {
            return "Enter a non-negative amount using a decimal point."
        }
        return "Leave blank to remove the budget. Other provider-plan settings are preserved. Requires full access."
    }

    /// Empty input clears the budget; negative/invalid input disables Save.
    private var parsedBudget: Double?? {
        let trimmed = budgetInput.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return .some(nil) }
        guard let value = Double(trimmed), value.isFinite, value >= 0 else { return nil }
        return .some(value)
    }

    private var isValid: Bool { parsedBudget != nil }

    private var canSave: Bool {
        isValid && !isSaving && !isLoadingInventory && client != nil
    }

    @MainActor
    private func save() async {
        guard let client, let value = parsedBudget else {
            if client == nil {
                needsSignIn = true
                errorMessage = "Not connected. Sign in with full access from Settings."
            }
            return
        }

        isSaving = true
        isLoadingInventory = true
        errorMessage = nil
        needsSignIn = false
        defer {
            isSaving = false
            isLoadingInventory = false
        }

        do {
            let inventory = try await client.providerInventory()
            guard let item = inventory.first(where: { $0.id == providerID }) else {
                errorMessage = "Provider not found in management inventory."
                Haptics.error()
                return
            }
            _ = try await client.setProviderMonthlyBudget(
                provider: item,
                monthlyBudgetUsd: value
            )
            Haptics.success()
            onSaved()
        } catch let apiError as APIError {
            apply(apiError)
            Haptics.error()
        } catch {
            errorMessage = error.localizedDescription
            Haptics.error()
        }
    }

    private func apply(_ error: APIError) {
        switch error {
        case .unauthorized, .forbidden, .missingToken:
            needsSignIn = true
            errorMessage = "\(error.title). Sign in with the dashboard password for full access."
        default:
            errorMessage = "\(error.title): \(error.message)"
        }
    }
}
