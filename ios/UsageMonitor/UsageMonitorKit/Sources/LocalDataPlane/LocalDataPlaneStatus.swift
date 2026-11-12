import Foundation

/// Product identity and readiness for the **Usage Monitor Local** app shell.
public struct LocalDataPlaneStatus: Equatable, Sendable {
    public enum Phase: String, Equatable, Sendable {
        /// Kit + app shell only; no GRDB money tables yet.
        case scaffold
        /// LocalStore migration v1 applied (PR-2+).
        case storeReady
        /// At least one provider configured and BudgetEngine can run (PR-5+).
        case budgetReady
    }

    public var phase: Phase
    public var schemaVersion: Int
    public var appDisplayName: String
    public var detail: String

    public init(
        phase: Phase,
        schemaVersion: Int,
        appDisplayName: String = "Usage Monitor Local",
        detail: String
    ) {
        self.phase = phase
        self.schemaVersion = schemaVersion
        self.appDisplayName = appDisplayName
        self.detail = detail
    }

    public static let scaffold = LocalDataPlaneStatus(
        phase: .scaffold,
        schemaVersion: 0,
        detail: "On-device data plane scaffold. Local SQLite (GRDB), provider keys in Keychain, and poll adapters ship in Milestone A PRs."
    )
}
