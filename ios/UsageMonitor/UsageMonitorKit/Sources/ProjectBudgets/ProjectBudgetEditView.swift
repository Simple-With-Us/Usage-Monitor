import SwiftUI
import AppCore
import DesignSystem
import Models
import Networking

/// Add or edit a project budget. Presented as a sheet. Collects name, an
/// optional description, and a monthly budget (blank = no cap), validates, and
/// persists through the session-gated monitor API via `ProjectManagementStore`
/// (`POST/PUT/DELETE /api/projects`). A successful save refreshes the shared
/// `BudgetStore`, so spend/coverage/status come back server-recomputed.
struct ProjectBudgetEditView: View {
    @Environment(\.dismiss) private var dismiss
    @FocusState private var focus: Field?

    /// The project being edited, or `nil` when adding.
    private let existing: ProjectBudgetStatus?
    private let store: ProjectManagementStore
    private let client: APIClient
    private let budgetStore: BudgetStore

    @State private var draft: ProjectBudgetDraft
    @State private var errorMessage: String?
    @State private var showDeleteConfirmation = false

    private enum Field: Hashable { case name, details, budget }

    init(
        existing: ProjectBudgetStatus?,
        store: ProjectManagementStore,
        client: APIClient,
        budgetStore: BudgetStore
    ) {
        self.existing = existing
        self.store = store
        self.client = client
        self.budgetStore = budgetStore
        _draft = State(initialValue: existing.map(ProjectBudgetDraft.init(editing:)) ?? ProjectBudgetDraft())
    }

    private var isEditing: Bool { existing != nil }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Project name", text: $draft.name)
                        .focused($focus, equals: .name)
                        .textInputAutocapitalization(.words)
                        .submitLabel(.next)
                        .onSubmit { focus = .details }
                        .accessibilityLabel("Project name")
                    TextField("Description (optional)", text: $draft.details, axis: .vertical)
                        .focused($focus, equals: .details)
                        .lineLimit(1...3)
                        .accessibilityLabel("Project description")
                } header: {
                    Text("Project")
                } footer: {
                    Text("A short name you'll recognize in the list. Names must be unique — case-insensitive equivalents are rejected.")
                }

                Section {
                    HStack {
                        Text("$")
                            .foregroundStyle(Theme.Colors.secondaryText)
                        TextField("0", text: $draft.monthlyBudgetInput)
                            .focused($focus, equals: .budget)
                            .keyboardType(.decimalPad)
                            .monospacedDigit()
                            .accessibilityLabel("Monthly budget in US dollars")
                    }
                    if let preview = parsedPreview {
                        LabeledContent("Monthly budget", value: preview)
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.Colors.secondaryText)
                    }
                } header: {
                    Text("Monthly budget")
                } footer: {
                    Text("Leave blank to track spend without a budget cap. USD only.")
                }

                if let errorMessage {
                    Section {
                        Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.Colors.danger)
                            .accessibilityLabel("Error: \(errorMessage)")
                    }
                }

                if isEditing {
                    Section {
                        Button(role: .destructive) {
                            showDeleteConfirmation = true
                        } label: {
                            if store.isSaving {
                                HStack {
                                    ProgressView()
                                    Text("Working…")
                                        .foregroundStyle(Theme.Colors.secondaryText)
                                }
                            } else {
                                Label("Delete project", systemImage: "trash")
                            }
                        }
                        .disabled(store.isSaving)
                        .accessibilityHint("Removes the project. Recorded usage history is kept.")
                    } footer: {
                        Text("Deleting removes the project and its budget. Usage already recorded is kept and becomes unattributed.")
                    }
                }
            }
            .navigationTitle(isEditing ? "Edit project" : "New project")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isEditing ? "Save" : "Add") { save() }
                        .fontWeight(.semibold)
                        .disabled(!draft.isValid || store.isSaving)
                }
            }
            .onAppear { if !isEditing { focus = .name } }
            .confirmationDialog(
                "Delete this project?",
                isPresented: $showDeleteConfirmation,
                titleVisibility: .visible
            ) {
                Button("Delete project", role: .destructive) { deleteProject() }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("“\(draft.trimmedName)” and its budget are removed. Recorded usage history is kept.")
            }
        }
    }

    private var parsedPreview: String? {
        guard let value = try? draft.parsedBudget() else { return nil }
        return CurrencyFormat.usd(value)
    }

    private func save() {
        do {
            try draft.validate()
        } catch let error as ProjectBudgetDraftError {
            errorMessage = error.message
            Haptics.warning()
            return
        } catch {
            errorMessage = "Something went wrong. Check the fields and try again."
            Haptics.warning()
            return
        }

        errorMessage = nil
        Task {
            let succeeded: Bool
            if let existing {
                succeeded = await store.update(
                    draft,
                    projectID: existing.id,
                    using: client,
                    refreshing: budgetStore
                )
            } else {
                succeeded = await store.create(
                    draft,
                    using: client,
                    refreshing: budgetStore
                ) != nil
            }
            if succeeded {
                Haptics.success()
                dismiss()
            } else {
                errorMessage = store.actionError.map { "\($0.title). \($0.message)" }
                    ?? "Couldn't save the project. Please try again."
                Haptics.error()
            }
        }
    }

    private func deleteProject() {
        guard let existing else { return }
        errorMessage = nil
        Task {
            let succeeded = await store.delete(
                projectID: existing.id,
                using: client,
                refreshing: budgetStore
            )
            if succeeded {
                Haptics.success()
                dismiss()
            } else {
                errorMessage = store.actionError.map { "\($0.title). \($0.message)" }
                    ?? "Couldn't delete the project. Please try again."
                Haptics.error()
            }
        }
    }
}

// MARK: - Previews

#if DEBUG
#Preview("Add") {
    ProjectBudgetEditView(
        existing: nil,
        store: .preview(),
        client: APIClient(tokenStore: InMemoryTokenStore()),
        budgetStore: AppEnvironment.preview().budgetStore
    )
}

#Preview("Edit (dark)") {
    ProjectBudgetEditView(
        existing: .sampleTrade,
        store: .preview(),
        client: APIClient(tokenStore: InMemoryTokenStore()),
        budgetStore: AppEnvironment.preview().budgetStore
    )
    .preferredColorScheme(.dark)
}
#endif
