import Foundation
import LocalBudget
import LocalStore

/// On-device alert derived from BudgetEngine + fetch errors — no remote fleet needed.
public struct LocalAlertItem: Identifiable, Equatable, Sendable, Hashable {
    public enum Severity: String, Sendable {
        case critical
        case warning
        case info
    }

    public var id: String
    public var title: String
    public var message: String
    public var severity: Severity
    public var providerId: String?
    public var projectId: String?

    public init(
        id: String,
        title: String,
        message: String,
        severity: Severity,
        providerId: String? = nil,
        projectId: String? = nil
    ) {
        self.id = id
        self.title = title
        self.message = message
        self.severity = severity
        self.providerId = providerId
        self.projectId = projectId
    }
}

public enum LocalAlertBuilder {
    public static func build(
        summary: BudgetEngine.Summary,
        providers: [LocalProvider],
        projects: [LocalProject]
    ) -> [LocalAlertItem] {
        var items: [LocalAlertItem] = []
        let byId = Dictionary(uniqueKeysWithValues: providers.map { ($0.id, $0) })

        for row in summary.providers {
            switch row.level {
            case .exceeded:
                items.append(
                    LocalAlertItem(
                        id: "budget-exceeded-\(row.providerId)",
                        title: "\(row.displayName) over budget",
                        message: "MTD \(format(row.spentUsd))"
                            + (row.monthlyBudgetUsd.map { " of \(format($0))" } ?? "")
                            + ". Phone-local rule — not a provider invoice.",
                        severity: .critical,
                        providerId: row.providerId
                    )
                )
            case .warning:
                items.append(
                    LocalAlertItem(
                        id: "budget-warning-\(row.providerId)",
                        title: "\(row.displayName) approaching budget",
                        message: "MTD \(format(row.spentUsd))"
                            + (row.monthlyBudgetUsd.map { " of \(format($0))" } ?? "")
                            + (row.projectedEomUsd.map { "; projected EOM \(format($0))" } ?? ""),
                        severity: .warning,
                        providerId: row.providerId
                    )
                )
            case .ok, .unconfigured:
                break
            }

            if let err = row.lastFetchError, !err.isEmpty, byId[row.providerId]?.isActive == true {
                items.append(
                    LocalAlertItem(
                        id: "fetch-error-\(row.providerId)",
                        title: "\(row.displayName) fetch issue",
                        message: err,
                        severity: .warning,
                        providerId: row.providerId
                    )
                )
            }
        }

        let needingKey = providers.filter(\.needsKey).sorted {
            $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending
        }
        if needingKey.count == 1, let only = needingKey.first {
            items.append(
                LocalAlertItem(
                    id: "needs-key-\(only.id)",
                    title: "\(only.displayName) needs API key",
                    message: "Open this provider and tap Connect Account to paste a key.",
                    severity: .info,
                    providerId: only.id
                )
            )
        } else if needingKey.count > 1 {
            items.append(
                LocalAlertItem(
                    id: "needs-key-many",
                    title: "\(needingKey.count) accounts need an API key",
                    message: "Restored cards start empty.  Open Providers, choose Needs Key, and tap Connect Account on each.",
                    severity: .info
                )
            )
        }

        if summary.overBudget {
            items.append(
                LocalAlertItem(
                    id: "portfolio-over",
                    title: "Portfolio over budget",
                    message: "Combined MTD \(format(summary.totalSpentUsd))"
                        + (summary.totalBudgetUsd.map { " exceeds \(format($0))" } ?? " with budgets set")
                        + ".",
                    severity: .critical
                )
            )
        }

        // Project budgets (direct charges only — Local v1).
        for project in projects {
            guard let budget = project.monthlyBudgetUsd, budget > 0 else { continue }
            // spent filled by caller via charges in model if needed — approximate from summary not available
            // Project spend computed separately in UI; still surface unbudgeted projects with zero spend as info? skip
            _ = budget
        }

        return items.sorted { lhs, rhs in
            severityRank(lhs.severity) < severityRank(rhs.severity)
                || (severityRank(lhs.severity) == severityRank(rhs.severity) && lhs.title < rhs.title)
        }
    }

    private static func severityRank(_ s: LocalAlertItem.Severity) -> Int {
        switch s {
        case .critical: return 0
        case .warning: return 1
        case .info: return 2
        }
    }

    private static func format(_ v: Double) -> String {
        v.formatted(.currency(code: "USD").precision(.fractionLength(2)))
    }
}
