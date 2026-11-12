import Foundation

/// Receipt from `POST /api/projects` (create) or `PUT /api/projects/:id`
/// (update). Both routes return the stored project row; the create route may
/// additionally report how many previously untagged usage events were
/// back-filled onto the new project.
public struct ProjectMutationReceipt: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var description: String?
    public var monthlyBudgetUsd: Double?
    /// Create-only: number of legacy `metadata.project`-tagged events the
    /// server attached to the new project id (omitted when zero / on update).
    public var backfilledEvents: Int?

    public init(
        id: String,
        name: String,
        description: String? = nil,
        monthlyBudgetUsd: Double? = nil,
        backfilledEvents: Int? = nil
    ) {
        self.id = id
        self.name = name
        self.description = description
        self.monthlyBudgetUsd = monthlyBudgetUsd
        self.backfilledEvents = backfilledEvents
    }
}

/// Response from `DELETE /api/projects/:id` (`{ "success": true }`). Historical
/// usage events survive the delete (their `projectId` is set-null server-side).
public struct ProjectDeleteReceipt: Codable, Hashable, Sendable {
    public var success: Bool

    public init(success: Bool) {
        self.success = success
    }
}
