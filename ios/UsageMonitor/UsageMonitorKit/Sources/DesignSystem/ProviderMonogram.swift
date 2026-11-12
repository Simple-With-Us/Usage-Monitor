import SwiftUI

/// Letter-in-rounded-rect monogram used on provider list rows and detail
/// headers. Model-free — callers pass a title + semantic status.
public struct ProviderMonogram: View {
    private let title: String
    private let status: Theme.SemanticStatus
    private let size: CGFloat
    private let cornerRadius: CGFloat
    private let font: Font

    public init(
        title: String,
        status: Theme.SemanticStatus = .neutral,
        size: CGFloat = 34,
        cornerRadius: CGFloat? = nil,
        font: Font? = nil
    ) {
        self.title = title
        self.status = status
        self.size = size
        self.cornerRadius = cornerRadius ?? (size >= 48 ? Theme.Radius.md : Theme.Radius.sm)
        self.font = font ?? (size >= 48
            ? .title2.weight(.bold)
            : .subheadline.weight(.bold))
    }

    public var body: some View {
        Text(letter)
            .font(font)
            .foregroundStyle(status == .neutral ? Theme.Colors.accent : status.tint)
            .frame(width: size, height: size)
            .background(
                (status == .neutral ? Theme.Colors.accentSoft : status.wash),
                in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            )
            .accessibilityHidden(true)
    }

    private var letter: String {
        String(title.trimmingCharacters(in: .whitespacesAndNewlines).prefix(1)).uppercased()
    }
}

#Preview {
    HStack(spacing: Theme.Spacing.md) {
        ProviderMonogram(title: "OpenRouter", status: .danger)
        ProviderMonogram(title: "Anthropic", status: .warning, size: 52)
        ProviderMonogram(title: "OpenAI", status: .ok)
    }
    .padding()
    .background(Theme.Colors.background)
}
