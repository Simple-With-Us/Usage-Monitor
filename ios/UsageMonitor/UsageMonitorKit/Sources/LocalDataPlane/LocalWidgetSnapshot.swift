import Foundation
import LocalBudget
import WidgetShared

/// Writes BudgetEngine summary into the **Local** app-group widget file.
/// Shares the unified `group.com.simplewithus.usage` container with the
/// remote client; the legacy separate-group separation is gone after the
/// 2026-09-22 bundle-ID migration.  Local writes its own
/// `local-widget-snapshot.json` filename (not `widget-snapshot.json` — that
/// is the client's legacy filename and is actively deleted by
/// `WidgetShared.SharedStore.cleanupLegacyData()` / `clear()` on every
/// client write), and the client writes `widget-snapshot-v2.json`, so the
/// two snapshots coexist inside the shared container without the client
/// cleanup path wiping Local's payload.
public enum LocalAppGroup {
    public static let identifier = "group.com.simplewithus.usage"

    public static var containerURL: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: identifier)
    }

    public static var defaults: UserDefaults {
        guard containerURL != nil, let g = UserDefaults(suiteName: identifier) else {
            return .standard
        }
        return g
    }
}

public enum LocalWidgetSnapshotWriter {
    private static let fileName = "local-widget-snapshot.json"

    public static func write(from summary: BudgetEngine.Summary, now: Date = Date()) {
        guard let dir = LocalAppGroup.containerURL else { return }
        let meters: [WidgetSnapshot.Meter] = summary.providers
            .filter { ($0.monthlyBudgetUsd ?? 0) > 0 }
            .sorted {
                let lb = max($0.monthlyBudgetUsd ?? 0, 0.01)
                let rb = max($1.monthlyBudgetUsd ?? 0, 0.01)
                return ($0.spentUsd / lb) > ($1.spentUsd / rb)
            }
            .prefix(5)
            .map { row in
                let budget = row.monthlyBudgetUsd
                let pct = budget.map { $0 > 0 ? row.spentUsd / $0 : 0 }
                return WidgetSnapshot.Meter(
                    id: row.providerId,
                    name: row.displayName,
                    spentUsd: row.spentUsd,
                    budgetUsd: budget,
                    percentUsed: pct,
                    status: row.level.rawValue,
                    projectedEomUsd: row.projectedEomUsd
                )
            }

        let totalBudget = summary.totalBudgetUsd ?? 0
        let percentUsed = totalBudget > 0 ? summary.totalSpentUsd / totalBudget : nil
        let projected = summary.providers.compactMap(\.projectedEomUsd).reduce(0, +)
        let warning =
            summary.overBudget
            || summary.providers.contains { $0.level == .warning }

        let snapshot = WidgetSnapshot(
            generatedAt: now,
            month: monthLabel(summary.monthStart),
            totalSpentUsd: summary.totalSpentUsd,
            totalBudgetUsd: totalBudget,
            projectedEomUsd: projected,
            percentUsed: percentUsed,
            overBudget: summary.overBudget,
            warning: warning,
            topMeters: Array(meters),
            projects: []
        )

        do {
            let data = try JSONEncoder().encode(snapshot)
            let url = dir.appendingPathComponent(fileName)
            try data.write(to: url, options: [.atomic])
            LocalAppGroup.defaults.set(now.timeIntervalSince1970, forKey: "widget.snapshot.writtenAt")
        } catch {
            // Best-effort — never fail money path for widget I/O.
            return
        }

        // The write is useless unless WidgetKit is told to re-read. The Local
        // app never called this, so even a correct payload sat unread until the
        // widget's own 30-minute timeline policy elapsed.  Do not force: the
        // shared 60s throttle coalesces bursts of Local writes, and WidgetKit
        // budgets repeated reloadAllTimelines() calls (unhonoured requests
        // are silently dropped by the system).
        WidgetTimelineReloader.reload(force: false, now: now)
    }

    private static func monthLabel(_ monthStart: Date) -> String {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.timeZone = TimeZone(secondsFromGMT: 0)
        f.dateFormat = "yyyy-MM"
        return f.string(from: monthStart)
    }
}
