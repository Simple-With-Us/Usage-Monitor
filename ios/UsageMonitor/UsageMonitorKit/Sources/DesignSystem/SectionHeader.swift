import SwiftUI

/// A consistent section header for grouped content: an uppercase-ish title with
/// an optional trailing accessory (a "See all" button, a count, etc.).
public struct SectionHeader<Accessory: View>: View {
    private let title: String
    private let subtitle: String?
    private let accessory: Accessory

    public init(
        _ title: String,
        subtitle: String? = nil,
        @ViewBuilder accessory: () -> Accessory
    ) {
        self.title = title
        self.subtitle = subtitle
        self.accessory = accessory()
    }

    public var body: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                Text(title)
                    .font(Theme.Typography.sectionHeader)
                    .foregroundStyle(Theme.Colors.primaryText)
                if let subtitle {
                    Text(subtitle)
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Colors.secondaryText)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: Theme.Spacing.sm)
            accessory
        }
        .accessibilityElement(children: .combine)
    }
}

public extension SectionHeader where Accessory == EmptyView {
    init(_ title: String, subtitle: String? = nil) {
        self.init(title, subtitle: subtitle) { EmptyView() }
    }
}

#Preview {
    VStack(spacing: Theme.Spacing.xl) {
        SectionHeader("Providers", subtitle: "Month to date")
        SectionHeader("Alerts") {
            Text("3").font(Theme.Typography.captionEmphasis)
                .foregroundStyle(Theme.Colors.danger)
        }
    }
    .padding()
    .background(Theme.Colors.background)
}
