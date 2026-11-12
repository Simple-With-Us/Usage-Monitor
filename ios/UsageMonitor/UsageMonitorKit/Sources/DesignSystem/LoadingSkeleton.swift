import SwiftUI

/// An animated shimmer placeholder. Compose `SkeletonBlock`s into a layout that
/// mirrors the real content so the first load feels instant and stable rather
/// than a spinner on an empty screen.
public struct SkeletonBlock: View {
    private let width: CGFloat?
    private let height: CGFloat
    private let radius: CGFloat

    public init(width: CGFloat? = nil, height: CGFloat = 14, radius: CGFloat = Theme.Radius.sm) {
        self.width = width
        self.height = height
        self.radius = radius
    }

    public var body: some View {
        RoundedRectangle(cornerRadius: radius, style: .continuous)
            .fill(Theme.Colors.fill)
            .frame(width: width, height: height)
            .modifier(Shimmer())
            .accessibilityHidden(true)
    }
}

/// A ready-made skeleton for a list of card rows — the default loading state
/// for the dashboard and provider list.
public struct SkeletonList: View {
    private let rows: Int

    public init(rows: Int = 5) {
        self.rows = rows
    }

    public var body: some View {
        VStack(spacing: Theme.Spacing.md) {
            ForEach(0..<rows, id: \.self) { _ in
                HStack(spacing: Theme.Spacing.md) {
                    SkeletonBlock(width: 34, height: 34, radius: Theme.Radius.sm)
                    VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                        SkeletonBlock(width: 140, height: 12)
                        SkeletonBlock(width: 90, height: 10)
                    }
                    Spacer()
                    SkeletonBlock(width: 56, height: 12)
                }
                .dsCard(padding: Theme.Spacing.md)
            }
        }
        .accessibilityElement()
        .accessibilityLabel("Loading")
    }
}

/// A moving-highlight shimmer overlay.
public struct Shimmer: ViewModifier {
    @State private var phase: CGFloat = -1

    public init() {}

    public func body(content: Content) -> some View {
        content
            .overlay(
                GeometryReader { geo in
                    LinearGradient(
                        colors: [.clear, Color.white.opacity(0.35), .clear],
                        startPoint: .leading,
                        endPoint: .trailing
                    )
                    .frame(width: geo.size.width * 1.4)
                    .offset(x: geo.size.width * phase)
                    .blendMode(.plusLighter)
                }
            )
            .mask(content)
            .onAppear {
                withAnimation(.linear(duration: 1.25).repeatForever(autoreverses: false)) {
                    phase = 1.4
                }
            }
    }
}

#Preview {
    SkeletonList()
        .padding()
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Theme.Colors.background)
}
