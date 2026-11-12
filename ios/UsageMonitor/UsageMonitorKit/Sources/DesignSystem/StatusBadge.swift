import SwiftUI

/// A small pill that labels a status or coverage caveat, e.g. "Over budget",
/// "Partial". Uses the semantic tint's soft wash so it reads as informative,
/// not alarming, unless `.danger`.
public struct StatusBadge: View {
    private let text: String
    private let status: Theme.SemanticStatus
    private let systemImage: String?

    public init(_ text: String, status: Theme.SemanticStatus, systemImage: String? = nil) {
        self.text = text
        self.status = status
        self.systemImage = systemImage
    }

    public var body: some View {
        HStack(spacing: Theme.Spacing.xs) {
            // Empty strings log "No symbol named '' found" and render nothing useful.
            if SystemImage.resolved(systemImage) != nil {
                Image(safeSystemName: systemImage).imageScale(.small)
            }
            Text(text)
        }
        .font(Theme.Typography.captionEmphasis)
        .foregroundStyle(status.tint)
        .padding(.horizontal, Theme.Spacing.sm)
        .padding(.vertical, Theme.Spacing.xs)
        .background(status.wash, in: Capsule())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(text)
    }
}

#Preview {
    VStack(alignment: .leading, spacing: Theme.Spacing.md) {
        StatusBadge("On track", status: .ok, systemImage: "checkmark.circle.fill")
        StatusBadge("Approaching budget", status: .warning, systemImage: "gauge.with.dots.needle.67percent")
        StatusBadge("Over budget", status: .danger, systemImage: "exclamationmark.octagon.fill")
        StatusBadge("Partial", status: .neutral)
    }
    .padding()
    .background(Theme.Colors.background)
}
