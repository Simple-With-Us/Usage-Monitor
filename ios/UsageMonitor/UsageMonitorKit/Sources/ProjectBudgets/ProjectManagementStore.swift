import Foundation
import Observation
import AppCore
import Models
import Networking

// ---------------------------------------------------------------------------
// Session-backed project management (I4).
//
// Project create/edit/delete used to be disabled on the rationale that the
// app's bearer token can only read. The app now carries a dashboard session,
// and `POST/PUT/DELETE /api/projects` are session-gated — exactly like the
// provider/subscription mutations Settings already performs. This store is the
// ProjectBudgets-lane equivalent of Settings' `ProviderManagementStore`:
//   - probes session capability so the UI only offers mutations when the
//     server will accept them,
//   - performs the mutation through `APIClient`,
//   - refreshes the shared `BudgetStore` afterwards so list/detail re-read the
//     server's recomputed project budgets (spend, coverage, status) rather
//     than trying to patch them locally.
// ---------------------------------------------------------------------------

@MainActor
@Observable
public final class ProjectManagementStore {
    /// Server-validated dashboard-session state; mutations require `.active`.
    public private(set) var sessionStatus: DashboardSessionStatus = .signedOut
    public private(set) var isProbing = false
    /// Whether a create/update/delete is currently in flight.
    public private(set) var isSaving = false
    /// The last failed mutation's typed error (drives inline form errors).
    public private(set) var actionError: APIError?

    /// When `true` (previews), mutations validate locally and report success
    /// without touching the network or the budget store.
    private let simulated: Bool

    public init() {
        self.simulated = false
    }

    private init(simulated: Bool) {
        self.simulated = simulated
    }

    public var canManage: Bool { simulated || sessionStatus.isActive }

    /// Probe the dashboard session. `APIClient.sessionStatus()` caches its
    /// probe briefly, so calling this on every tab appear is cheap and keeps
    /// the Add/Edit affordances in step with sign-in/sign-out in Settings.
    public func probeCapabilities(using client: APIClient) async {
        guard !simulated, !isProbing else { return }
        isProbing = true
        defer { isProbing = false }
        do {
            sessionStatus = try await client.sessionStatus()
        } catch is CancellationError {
            return
        } catch {
            // A probe failure must not hide read-only data; it only means the
            // mutation affordances stay off until the next successful probe.
            sessionStatus = .signedOut
        }
    }

    /// Create a project from a validated draft. Returns the receipt on success.
    @discardableResult
    public func create(
        _ draft: ProjectBudgetDraft,
        using client: APIClient,
        refreshing budgetStore: BudgetStore
    ) async -> ProjectMutationReceipt? {
        guard let budget = try? draft.validate() else { return nil }
        if simulated { return ProjectMutationReceipt(id: "proj_preview", name: draft.trimmedName) }
        return await mutate(using: client, refreshing: budgetStore) { client in
            try await client.createProject(
                name: draft.trimmedName,
                description: draft.trimmedDetails.isEmpty ? nil : draft.trimmedDetails,
                monthlyBudgetUsd: budget
            )
        }
    }

    /// Update an existing project from a validated draft.
    @discardableResult
    public func update(
        _ draft: ProjectBudgetDraft,
        projectID: String,
        using client: APIClient,
        refreshing budgetStore: BudgetStore
    ) async -> Bool {
        guard let budget = try? draft.validate() else { return false }
        if simulated { return true }
        return await mutate(using: client, refreshing: budgetStore) { client in
            try await client.updateProject(
                id: projectID,
                name: draft.trimmedName,
                description: draft.trimmedDetails,
                monthlyBudgetUsd: budget
            )
        } != nil
    }

    /// Delete a project. Usage history survives server-side (`projectId` is
    /// set-null on tagged events).
    @discardableResult
    public func delete(
        projectID: String,
        using client: APIClient,
        refreshing budgetStore: BudgetStore
    ) async -> Bool {
        if simulated { return true }
        return await mutate(using: client, refreshing: budgetStore) { client in
            try await client.deleteProject(id: projectID)
        } != nil
    }

    /// Run one mutation, then refresh the shared budget data so every screen
    /// re-reads the server's recomputed project budgets. An `unauthorized`
    /// means the session expired mid-edit — flip capability off so the
    /// affordances disappear until the user signs in again.
    private func mutate<T>(
        using client: APIClient,
        refreshing budgetStore: BudgetStore,
        action: @MainActor (APIClient) async throws -> T
    ) async -> T? {
        guard !isSaving else { return nil }
        isSaving = true
        actionError = nil
        defer { isSaving = false }
        do {
            let result = try await action(client)
            await budgetStore.refresh()
            return result
        } catch is CancellationError {
            return nil
        } catch let apiError as APIError {
            actionError = apiError
            if apiError == .unauthorized {
                sessionStatus = .signedOut
            }
            return nil
        } catch {
            actionError = .transport(error.localizedDescription)
            return nil
        }
    }
}

#if DEBUG
extension ProjectManagementStore {
    /// A preview store whose mutations simulate success without any network
    /// access, so form previews render and save without an `APIClient`.
    public static func preview(canManage: Bool = true) -> ProjectManagementStore {
        ProjectManagementStore(simulated: canManage)
    }
}
#endif
