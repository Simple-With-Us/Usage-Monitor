import SwiftUI

/// A small trend card: a title, a current value, and a filled sparkline drawn
/// from a series of points. Uses a hand-drawn `Path` (no external chart
/// dependency) so it renders identically in the app and, if reused, a widget.
public struct SparklineCard: View {
    private let title: String
    private let value: String
    private let caption: String?
    private let points: [Double]
    private let status: Theme.SemanticStatus

    public init(
        title: String,
        value: String,
        caption: String? = nil,
        points: [Double],
        status: Theme.SemanticStatus = .neutral
    ) {
        self.title = title
        self.value = value
        self.caption = caption
        self.points = points
        self.status = status
    }

    private var tint: Color { status == .neutral ? Theme.Colors.accent : status.tint }

    public var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            let showTitle = !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            if showTitle || caption != nil {
                HStack(alignment: .firstTextBaseline) {
                    if showTitle {
                        Text(title)
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.Colors.secondaryText)
                    }
                    Spacer()
                    if let caption {
                        Text(caption)
                            .font(Theme.Typography.captionEmphasis)
                            .foregroundStyle(tint)
                    }
                }
            }

            Text(value)
                .font(Theme.Typography.statValue)
                .monospacedDigit()
                .foregroundStyle(Theme.Colors.primaryText)

            Sparkline(points: points, tint: tint)
                .frame(height: 44)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .dsCard()
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(title): \(value)")
    }
}

/// The bare sparkline shape: a stroked line over a soft gradient fill.
public struct Sparkline: View {
    private let points: [Double]
    private let tint: Color

    public init(points: [Double], tint: Color) {
        self.points = points
        self.tint = tint
    }

    public var body: some View {
        GeometryReader { geo in
            let path = linePath(in: geo.size)
            ZStack {
                filledPath(in: geo.size)
                    .fill(
                        LinearGradient(
                            colors: [tint.opacity(0.28), tint.opacity(0.0)],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                    )
                path
                    .stroke(tint.gradient, style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
            }
        }
    }

    private func normalizedPoints(in size: CGSize) -> [CGPoint] {
        guard points.count > 1 else {
            return [CGPoint(x: 0, y: size.height / 2), CGPoint(x: size.width, y: size.height / 2)]
        }
        let minV = points.min() ?? 0
        let maxV = points.max() ?? 1
        let range = max(maxV - minV, 0.000001)
        let stepX = size.width / CGFloat(points.count - 1)
        let inset: CGFloat = 3
        return points.enumerated().map { index, value in
            let x = CGFloat(index) * stepX
            let ratio = (value - minV) / range
            let y = size.height - inset - CGFloat(ratio) * (size.height - inset * 2)
            return CGPoint(x: x, y: y)
        }
    }

    private func linePath(in size: CGSize) -> Path {
        var path = Path()
        let pts = normalizedPoints(in: size)
        guard let first = pts.first else { return path }
        path.move(to: first)
        for point in pts.dropFirst() { path.addLine(to: point) }
        return path
    }

    private func filledPath(in size: CGSize) -> Path {
        var path = linePath(in: size)
        let pts = normalizedPoints(in: size)
        guard let last = pts.last, let first = pts.first else { return path }
        path.addLine(to: CGPoint(x: last.x, y: size.height))
        path.addLine(to: CGPoint(x: first.x, y: size.height))
        path.closeSubpath()
        return path
    }
}

#Preview {
    ScrollView {
        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: Theme.Spacing.md) {
            SparklineCard(title: "Daily spend", value: "$18.40", caption: "+12%",
                          points: [4, 6, 5, 8, 7, 11, 9, 14, 18], status: .warning)
            SparklineCard(title: "Requests", value: "12.4K", caption: "−4%",
                          points: [20, 18, 19, 15, 16, 13, 14, 12], status: .ok)
        }
        .padding()
    }
    .background(Theme.Colors.background)
}
