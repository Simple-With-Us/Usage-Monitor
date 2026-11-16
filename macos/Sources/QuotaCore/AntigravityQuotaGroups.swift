import Foundation

/// Antigravity has two shared model pools, each with a short and weekly cap.
/// Per-model reports are observations of those pools, never additive quotas.
public enum AntigravityQuotaGroups {
    public static func normalize(_ windows: [QuotaWindow], includeMissing: Bool = false) -> [QuotaWindow] {
        let other = windows.filter { $0.canonicalProviderKey != "google-antigravity" }
        let reports = windows.filter { $0.canonicalProviderKey == "google-antigravity" }
        guard !reports.isEmpty else { return windows }
        var result = other
        for family in ["gemini", "third-party"] {
            for period in ["5h", "weekly"] {
                let candidates = reports.filter { pool($0) == family && cadence($0) == period }
                // Prefer the latest observation.  Tied model observations of the same
                // shared pool use the lower value; never average or add percentages.
                let selected = candidates.sorted {
                    let left = $0.occurredDate ?? .distantPast
                    let right = $1.occurredDate ?? .distantPast
                    if left != right { return left > right }
                    return ($0.boundedRemainingPercent ?? 101) < ($1.boundedRemainingPercent ?? 101)
                }.first
                guard selected != nil || includeMissing else { continue }
                let title = family == "gemini" ? "Gemini" : "Third-Party"
                var value = selected ?? QuotaWindow(id: "", provider: "Antigravity", label: "", remainingUnknown: true, occurredAt: "")
                value.id = "antigravity:\(family):\(period)"
                value.provider = "Antigravity"
                value.providerKey = "google-antigravity"
                value.providerLabel = "Antigravity"
                value.via = "antigravity"
                value.modelId = nil
                value.modelType = nil
                value.label = "\(title) · \(period == "5h" ? "5-Hour" : "Weekly")"
                value.window = period
                // Model-specific units cannot establish a shared absolute cap.
                value.absoluteRemaining = nil
                value.absoluteLimit = nil
                value.quotaUnit = nil
                result.append(value)
            }
        }
        return result
    }

    private static func pool(_ value: QuotaWindow) -> String? {
        let identity = [value.modelId, value.modelType, value.label].compactMap { $0 }.joined(separator: " ").lowercased()
        if identity.contains("gemini") { return "gemini" }
        if ["third-party", "third party", "third_party", "claude", "gpt", "openai", "anthropic"].contains(where: identity.contains) { return "third-party" }
        return nil
    }

    private static func cadence(_ value: QuotaWindow) -> String? {
        let token = value.window?.lowercased().replacingOccurrences(of: " ", with: "")
        if ["weekly", "week", "1w", "7d", "168h", "10080m"].contains(token ?? "") || value.label.lowercased().contains("weekly") { return "weekly" }
        if ["5h", "5hr", "5-hour", "5hours", "300m"].contains(token ?? "") { return "5h" }
        // The helper's model quotaInfo is the short pool.  A weekly reading
        // must be explicitly identified; a reset's distance is not a duration.
        if token == nil && value.sourceApp == "local-mac" && value.modelId != nil { return "5h" }
        return nil
    }
}
