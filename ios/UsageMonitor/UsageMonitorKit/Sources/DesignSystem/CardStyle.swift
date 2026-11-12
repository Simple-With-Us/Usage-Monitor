import SwiftUI

/// The standard card surface: a rounded, padded container on the elevated
/// surface color with a hairline stroke. Every tile/row/section card uses this
/// so corners, insets, and elevation stay consistent app-wide.
public struct CardModifier: ViewModifier {
    private let padding: CGFloat
    private let radius: CGFloat

    public init(padding: CGFloat = Theme.Spacing.lg, radius: CGFloat = Theme.Radius.lg) {
        self.padding = padding
        self.radius = radius
    }

    public func body(content: Content) -> some View {
        content
            .padding(padding)
            .background(Theme.Colors.surface, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .strokeBorder(Theme.Colors.separator.opacity(0.5), lineWidth: 0.5)
            )
    }
}

public extension View {
    /// Wrap the view in the standard design-system card surface.
    func dsCard(padding: CGFloat = Theme.Spacing.lg, radius: CGFloat = Theme.Radius.lg) -> some View {
        modifier(CardModifier(padding: padding, radius: radius))
    }
}
