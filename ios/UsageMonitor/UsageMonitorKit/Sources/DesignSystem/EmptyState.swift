import SwiftUI

/// A centered, friendly empty state: an SF Symbol in a soft circle, a title, a
/// message, and an optional call-to-action button. Use when a screen has no
/// data to show (no providers configured, no alerts, first run).
public struct EmptyState: View {
    private let systemImage: String
    private let title: String
    private let message: String
    private let actionTitle: String?
    private let action: (() -> Void)?

    public init(
        systemImage: String,
        title: String,
        message: String,
        actionTitle: String? = nil,
        action: (() -> Void)? = nil
    ) {
        self.systemImage = systemImage
        self.title = title
        self.message = message
        self.actionTitle = actionTitle
        self.action = action
    }

    public var body: some View {
        VStack(spacing: Theme.Spacing.lg) {
            Image(safeSystemName: systemImage, fallback: "tray")
                .font(.system(size: 34, weight: .semibold))
                .foregroundStyle(Theme.Colors.accent)
                .frame(width: 76, height: 76)
                .background(Theme.Colors.accentSoft, in: Circle())

            VStack(spacing: Theme.Spacing.sm) {
                Text(title)
                    .font(Theme.Typography.title)
                    .foregroundStyle(Theme.Colors.primaryText)
                    .multilineTextAlignment(.center)
                Text(message)
                    .font(Theme.Typography.callout)
                    .foregroundStyle(Theme.Colors.secondaryText)
                    .multilineTextAlignment(.center)
            }

            if let actionTitle, let action {
                Button(action: action) {
                    Text(actionTitle)
                        .font(Theme.Typography.callout.weight(.semibold))
                        .padding(.horizontal, Theme.Spacing.xl)
                        .padding(.vertical, Theme.Spacing.sm)
                }
                .buttonStyle(.borderedProminent)
                .tint(Theme.Colors.accent)
            }
        }
        .padding(Theme.Spacing.xl)
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
    }
}

#Preview {
    EmptyState(
        systemImage: "checkmark.seal.fill",
        title: "All clear",
        message: "No providers are near their budget this month. Pull to refresh for the latest.",
        actionTitle: "Refresh"
    ) {}
    .frame(maxHeight: .infinity)
    .background(Theme.Colors.background)
}
