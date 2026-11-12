import SwiftUI

/// A convenience wrapper over `ScrollView` + `.refreshable` with the app's
/// standard content insets and grouped background. Every scrolling feature
/// screen uses this so pull-to-refresh behavior, padding, and background are
/// identical everywhere.
///
/// The `onRefresh` closure is `async`; the system shows the refresh control
/// until it returns.
public struct RefreshableScrollView<Content: View>: View {
    private let spacing: CGFloat
    private let onRefresh: @Sendable () async -> Void
    private let content: Content

    public init(
        spacing: CGFloat = Theme.Spacing.lg,
        onRefresh: @escaping @Sendable () async -> Void,
        @ViewBuilder content: () -> Content
    ) {
        self.spacing = spacing
        self.onRefresh = onRefresh
        self.content = content()
    }

    public var body: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: spacing) {
                content
            }
            .padding(.horizontal, Theme.Spacing.lg)
            .padding(.vertical, Theme.Spacing.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
            .containerRelativeFrame(.horizontal, alignment: .leading)
        }
        // Tab-bar clearance is applied ONCE at the tab shell (RootView).
        // Applying it here too stacked ~2x(96pt padding + 96pt margins) of
        // bottom inset and blanked most of the Platforms tab (owner 2026-08-31).
        .background(Theme.Colors.background)
        .refreshable { await onRefresh() }
    }
}

public extension View {
    /// Apply the app's standard grouped screen background, ignoring safe-area
    /// so the color reaches the edges.
    func dsScreenBackground() -> some View {
        background(Theme.Colors.background.ignoresSafeArea())
    }
}

#Preview {
    RefreshableScrollView(onRefresh: {}) {
        SectionHeader("Section")
        ForEach(0..<4, id: \.self) { i in
            StatTile(label: "Tile \(i)", value: "$\(i * 42)")
        }
    }
}
