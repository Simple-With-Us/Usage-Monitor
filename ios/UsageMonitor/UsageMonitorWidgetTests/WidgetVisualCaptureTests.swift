import XCTest
import SwiftUI
import WidgetKit
import WidgetShared
import DesignSystem

/// Renders each supported widget configuration at canonical widget sizes and
/// writes PNGs to `WIDGET_SCREENSHOT_DIR` (set by `scripts/ios-widget-screenshots.sh`).
/// Hosted iOS CI uploads that directory as an artifact — the Kodus review asked for
/// simulator-backed visual verification without committing manual captures.
@MainActor
final class WidgetVisualCaptureTests: XCTestCase {
    private struct CaptureCase: Sendable {
        let slug: String
        let family: WidgetFamily
        let content: WidgetTopicContent
    }

    func testCaptureWidgetConfigurations() throws {
        let dir = ProcessInfo.processInfo.environment["WIDGET_SCREENSHOT_DIR"]
        let outputDirectory = dir.map(URL.init(fileURLWithPath:))
        if outputDirectory == nil {
            throw XCTSkip("WIDGET_SCREENSHOT_DIR is unset; run via scripts/ios-widget-screenshots.sh")
        }
        let output = try XCTUnwrap(outputDirectory)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)

        let snapshot = WidgetSnapshot.placeholder
        let cases = Self.allCaptureCases(snapshot: snapshot)
        for capture in cases {
            let entry = BudgetEntry(date: .now, snapshot: snapshot, content: capture.content)
            let view = UsageMonitorWidgetView(entry: entry)
                .environment(\.widgetFamily, capture.family)
                .padding(8)
                .background(Theme.Colors.background)

            let size = Self.widgetContentSize(for: capture.family)
            let url = output.appendingPathComponent("\(capture.slug).png")
            try Self.writePNG(of: view, size: size, to: url)
            XCTAssertTrue(FileManager.default.fileExists(atPath: url.path), capture.slug)
        }
    }

    private static func allCaptureCases(snapshot: WidgetSnapshot) -> [CaptureCase] {
        let topics: [(String, WidgetTopic, WidgetSortOrder, WidgetSortOrder)] = [
            ("budget", .budget, .utilisation, .spend),
            ("llm", .llmQuotas, .utilisation, .spend),
            ("quotas", .quotas, .utilisation, .spend),
            ("servers", .servers, .utilisation, .spend),
            ("mac", .mac, .utilisation, .spend),
            ("alerts", .alerts, .utilisation, .spend),
            ("providers", .providers, .utilisation, .spend),
            ("projects", .projects, .utilisation, .spend),
        ]
        let families: [(String, WidgetFamily)] = [
            ("small", .systemSmall),
            ("medium", .systemMedium),
            ("large", .systemLarge),
        ]
        var cases: [CaptureCase] = []
        for (topicSlug, topic, sort, providersSort) in topics {
            let content = WidgetTopicPresentation.topicContent(
                from: snapshot,
                topic: topic,
                budgetFocus: .overall,
                llmProviderId: topic == .llmQuotas ? "anthropic" : nil,
                serverFocus: .service,
                maxMeters: 4,
                sortOrder: sort,
                providersSort: providersSort,
                appGroupUnavailable: false
            )
            for (familySlug, family) in families {
                cases.append(
                    CaptureCase(
                        slug: "\(topicSlug)-\(familySlug)",
                        family: family,
                        content: content
                    )
                )
            }
        }
        return cases
    }

    private static func widgetContentSize(for family: WidgetFamily) -> CGSize {
        switch family {
        case .systemSmall:
            return CGSize(width: 158, height: 158)
        case .systemMedium:
            return CGSize(width: 338, height: 158)
        case .systemLarge:
            return CGSize(width: 338, height: 354)
        default:
            return CGSize(width: 338, height: 158)
        }
    }

    private static func writePNG<V: View>(of view: V, size: CGSize, to url: URL) throws {
        let renderer = ImageRenderer(content: view.frame(width: size.width, height: size.height))
        renderer.scale = 2
        guard let image = renderer.uiImage else {
            XCTFail("ImageRenderer produced no image for \(url.lastPathComponent)")
            return
        }
        guard let data = image.pngData() else {
            XCTFail("PNG encoding failed for \(url.lastPathComponent)")
            return
        }
        try data.write(to: url, options: .atomic)
    }
}
