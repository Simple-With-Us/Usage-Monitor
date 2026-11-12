import SwiftUI

/// Safe SF Symbol rendering — empty / whitespace names never hit the system
/// catalog (which logs "No symbol named '' found in system symbol set" per frame).
public enum SystemImage {
    /// Returns `nil` when `name` is empty or whitespace-only.
    public static func resolved(_ name: String?) -> String? {
        guard let name else { return nil }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// Prefer this over `Image(systemName:)` when the name is dynamic.
    /// Falls back to `fallback` (default: "circle") so layout never collapses.
    public static func name(_ name: String?, fallback: String = "circle") -> String {
        resolved(name) ?? fallback
    }
}

public extension Image {
    /// Like `Image(systemName:)` but never resolves an empty string.
    /// Returns an empty `Image` when both `systemName` and `fallback` are empty.
    init(safeSystemName systemName: String?, fallback: String? = "circle") {
        if let resolved = SystemImage.resolved(systemName) {
            self.init(systemName: resolved)
        } else if let fallback, let resolvedFallback = SystemImage.resolved(fallback) {
            self.init(systemName: resolvedFallback)
        } else {
            self.init(systemName: "circle")
        }
    }
}
